import logging
import threading
import time
import requests
from colorlog import ColoredFormatter

from .ollama import *
from .config import *
from .systeminfo import *
from .models import *
from .httphelpers import *
from .exec.llm import *
from .exec.tts import *
from .exec.debug import *
from .exec.shell import *
from .exec.shellcmd import *
from .exec.docker import *
from .exec.imggen import execute_imggen_comfyui
from .exec.skill import execute_skill
from .data.updn import process_data_download
from .data.fs_utils import *
from .exec.helpers import report_starting


# -----------------------------------------
# Logger setup
# -----------------------------------------
def setup_logger() -> logging.Logger:
    logger = logging.getLogger("agent")
    logger.setLevel(logging.INFO)

    handler = logging.StreamHandler()
    formatter = ColoredFormatter(
        "%(log_color)s[%(levelname)s] %(message)s",
        log_colors={
            "DEBUG":    "white",
            "INFO":     "cyan",
            "WARNING":  "yellow",
            "ERROR":    "red",
            "CRITICAL": "bold_red",
        }
    )
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.propagate = False

    return logger


logger = setup_logger()

# -----------------------------------------
# Helper Functions
# -----------------------------------------

class AuthError(Exception):
    """Raised when the server rejects the agent's JWT (403)."""
    pass


def poll_task(http: HttpClient) -> dict | None:
    """Poll server for a new task, return task_info or None."""
    try:
        resp = http.get("private", "agent", "task", "poll", timeout=60)
        if resp.status_code == 403:
            raise AuthError("403 Forbidden — JWT rejected or agent deregistered")
        resp.raise_for_status()
        return resp.json()
    except AuthError:
        raise
    except requests.Timeout:
        logger.warning("Polling timed out, retrying...")
    except Exception as e:
        logger.error(f"Polling error: {e}. Backing off for 15s...")
        time.sleep(15)
    return None


def _reauth_or_reregister(server_url: str) -> str | None:
    """Attempt to recover a valid JWT after a 403.

    Tries re-authentication first (JWT expired but agent still exists).
    Falls back to re-registration if the agent record was deleted.
    Returns a fresh JWT string, or None if all attempts fail.
    """
    cfg = load_config()
    agent_id = cfg.get("agentId")
    key = cfg.get("key")
    api_key = cfg.get("apiKey")

    if agent_id and key:
        try:
            auth = authenticate_agent(server_url, agent_id, key)
            jwt = auth["token"]
            cfg["jwtToken"] = jwt
            save_config(cfg)
            logger.info("Re-authentication successful.")
            return jwt
        except Exception as e:
            logger.warning(f"Re-authentication failed: {e}. Attempting re-registration...")

    if not api_key:
        logger.error("No API key in config — cannot re-register.")
        return None

    try:
        caps = cfg.get("capabilities") or ["debug.echo", "shell.bash", "shellcmd.bash", "tts.kokoro"]
        tier = cfg.get("tier", 5)
        capacity = cfg.get("capacity", 1)
        reg = register_agent(server_url, caps, tier, capacity, api_key)
        cfg.update({"agentId": reg["agentId"], "key": reg["key"]})
        auth = authenticate_agent(server_url, reg["agentId"], reg["key"])
        jwt = auth["token"]
        cfg["jwtToken"] = jwt
        save_config(cfg)
        logger.info("Re-registration successful.")
        return jwt
    except Exception as e:
        logger.error(f"Re-registration failed: {e}")
        return None


def take_task(http: HttpClient, raw_id: str, raw_cap: str) -> dict | None:
    """Take a task from the server and return full task object."""
    try:
        q_cap = qpart(raw_cap)
        resp = http.post(
            "private",
            "agent",
            "take",
            q_cap,
            qpart(raw_id),
            json_body={},
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    except Exception as e:
        logger.error(f"Failed to take task {raw_id}: {e}")
        return None


def download_required_files(http, task_id: TaskId, capability: str, fetch_files: list, data_path: Path) -> bool:
    """Download associated file references. Returns True if succeeded."""
    for fileref in fetch_files:
        try:
            parsed = parse_file_reference(fileref)
            process_data_download(data_path, parsed)

        except Exception as e:
            logger.error(f"Failed to fetch file {fileref}: {e}")
            report = make_failure_report(task_id, capability, str(e))
            report_result(http, report)
            return False

    return True


def download_bucket_files(http: HttpClient, task_id: TaskId, capability: str, file_buckets: list, data_path: Path) -> bool:
    """Download all files from the listed storage buckets. Returns True on success."""
    for bucket_uid in file_buckets:
        try:
            # Stat the bucket to discover files
            resp = http.get("private", "agent", "bucket", bucket_uid, "stat", timeout=60)
            resp.raise_for_status()
            bucket_info = resp.json()

            files = bucket_info.get("files", [])
            logger.info(f"Bucket {bucket_uid}: {len(files)} file(s) to download")

            for file_info in files:
                file_uid = file_info["file_uid"]
                original_name = file_info.get("original_name", file_uid)
                save_path = data_path / original_name

                if save_path.exists():
                    logger.info(f"File already exists, skipping: {save_path}")
                    continue

                save_path.parent.mkdir(parents=True, exist_ok=True)

                # Download the file
                dl_resp = http.get(
                    "private", "agent", "bucket", bucket_uid, "file", file_uid,
                    timeout=300,
                )
                dl_resp.raise_for_status()

                with open(save_path, "wb") as f:
                    f.write(dl_resp.content)

                logger.info(f"Downloaded {original_name} ({len(dl_resp.content)} bytes) to {save_path}")

        except Exception as e:
            logger.error(f"Failed to download from bucket {bucket_uid}: {e}")
            report = make_failure_report(task_id, capability, str(e))
            report_result(http, report)
            return False

    return True


def route_executor(cap: str):
    """Pick function based on capability string."""
    if cap.startswith("llm."):
        return execute_llm_query

    if cap.startswith("docker."):
        return execute_docker_run

    if cap.startswith("imggen."):
        return execute_imggen_comfyui

    if cap.startswith("skill."):
        return execute_skill

    return {
        "debug.echo": execute_debug_echo,
        "shell.bash": execute_shell_bash,
        "shellcmd.bash": execute_shellcmd_bash,
        "tts.kokoro": execute_kokoro_tts,
    }.get(cap)


def handle_task(http: HttpClient, task: dict):
    """Parse and run a single task from the server."""
    task_id = TaskId(
        id=str(task.get("id", {}).get("id", "")),
        cap=str(task.get("id", {}).get("cap", "")),
    )
    capability = task_id.cap
    task_data = task.get("data") or {}
    payload = task_data.get("payload")
    fetch_files = task_data.get("fetchFiles") or []
    file_buckets = task_data.get("fileBucket") or []
    output_bucket = task_data.get("outputBucket")

    logger.info(f"Received task: {task_id.to_wire()} with capability '{capability}'")
    logger.info(f"Required files: {fetch_files}, buckets: {file_buckets}, output_bucket: {output_bucket}")

    executor = route_executor(capability)
    if not executor:
        msg = f"Unknown capability: {capability}"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        report_result(http, report)
        return

    data_path = pick_directory(task_id)
    report_starting(http, task_id)

    # Download files from buckets
    if file_buckets:
        if not download_bucket_files(http, task_id, capability, file_buckets, data_path):
            logger.error("Bucket file download failed; skipping task.")
            return

    # Download files from fetch_files references
    if not download_required_files(http, task_id, capability, fetch_files, data_path):
        logger.error("File download failed; skipping task.")
        return

    # Execute task
    try:
        if capability.startswith("imggen."):
            executor(http, task_id, capability, payload, data_path, output_bucket=output_bucket)
        else:
            executor(http, task_id, capability, payload, data_path)
    except Exception as e:
        logger.error(f"Executor failed: {e}")
        report = make_failure_report(task_id, capability, str(e))
        report_result(http, report)


# -----------------------------------------
# Main loop
# -----------------------------------------

def serve_tasks(server_url: str, jwt_token: str, stop_event: threading.Event | None = None) -> None:
    http = HttpClient(server_url, jwt_token)
    auth_failures = 0

    while not (stop_event and stop_event.is_set()):
        try:
            task_info = poll_task(http)
            if not task_info or not task_info.get("id"):
                time.sleep(5)
                continue

            auth_failures = 0
            raw_id = task_info["id"]["id"]
            raw_cap = task_info["id"]["cap"]

            task = take_task(http, raw_id, raw_cap)
            if not task:
                time.sleep(5)
                continue

            handle_task(http, task)

        except AuthError:
            auth_failures += 1
            if auth_failures > 3:
                logger.critical("Auth recovery failed 3 times — giving up. Restart the agent.")
                return
            logger.warning(f"Auth rejected (attempt {auth_failures}/3) — attempting recovery...")
            new_jwt = _reauth_or_reregister(server_url)
            if new_jwt:
                http = HttpClient(server_url, new_jwt)
            else:
                logger.error("Could not recover auth. Backing off for 30s...")
                time.sleep(30)

        except Exception as e:
            logger.critical(f"Unexpected exception in main loop: {e}")

        time.sleep(5)
