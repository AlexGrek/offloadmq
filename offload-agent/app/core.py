import itertools
import logging
import threading
import time
import requests
from pathlib import Path
from typing import Any, Callable
from colorlog import ColoredFormatter

from .ollama import *
from .config import *
from .systeminfo import *
from .models import *
from .httphelpers import *
from .capabilities import detect_capabilities, rescan_and_push
from .exec.llm import *
from .exec.tts import *
from .exec.debug import *
from .exec.shell import *
from .exec.shellcmd import *
from .exec.docker import *
from .exec.imggen import execute_imggen_comfyui
from .exec.custom import execute_custom_cap
from .exec.slavemode import execute_slavemode, merge_registration_caps
from .data.updn import process_data_download
from .data.fs_utils import *
from .exec.helpers import (
    TaskCancelled,
    report_cancelled,
    report_progress,
    report_starting,
)


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


def poll_task(http: HttpClient) -> dict[str, Any] | None:
    """Poll server for a new task, return task_info or None."""
    try:
        resp = http.get("private", "agent", "task", "poll", timeout=60)
        if resp.status_code == 403:
            raise AuthError("403 Forbidden — JWT rejected or agent deregistered")
        resp.raise_for_status()
        task_data: dict[str, Any] = resp.json()
        return task_data
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
            jwt: str = str(auth["token"])
            cfg["jwtToken"] = jwt
            save_config(cfg)
            logger.info("Re-authentication successful.")
            return jwt
        except requests.ConnectionError as e:
            logger.warning(f"Re-authentication failed (server unreachable): {e}. Keeping existing credentials.")
            return None
        except requests.Timeout as e:
            logger.warning(f"Re-authentication timed out: {e}. Keeping existing credentials.")
            return None
        except Exception as e:
            logger.warning(f"Re-authentication failed: {e}. Attempting re-registration...")

    if not api_key:
        logger.error("No API key in config — cannot re-register.")
        return None

    try:
        caps = cfg.get("capabilities") or ["debug.echo", "shell.bash", "shellcmd.bash", "tts.kokoro"]
        caps = merge_registration_caps(list(caps), cfg)
        stored_tier = cfg.get("tier")
        tier = stored_tier if stored_tier is not None else calculate_tier(collect_system_info())
        capacity = cfg.get("capacity", 1)
        display_name: str | None = cfg.get("displayName") or None
        reg = register_agent(server_url, caps, tier, capacity, api_key, display_name=display_name)
        cfg.update({"agentId": reg["agentId"], "key": reg["key"]})
        auth = authenticate_agent(server_url, reg["agentId"], reg["key"])
        new_jwt: str = str(auth["token"])
        cfg["jwtToken"] = new_jwt
        save_config(cfg)
        logger.info("Re-registration successful.")
        return new_jwt
    except Exception as e:
        logger.error(f"Re-registration failed: {e}")
        return None


def take_task(http: HttpClient, raw_id: str, raw_cap: str) -> dict[str, Any] | None:
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
        taken: dict[str, Any] = resp.json()
        return taken

    except Exception as e:
        logger.error(f"Failed to take task {raw_id}: {e}")
        return None


def download_required_files(http: HttpClient, task_id: TaskId, capability: str, fetch_files: list[Any], data_path: Path) -> bool:
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


def download_bucket_files(http: HttpClient, task_id: TaskId, capability: str, file_buckets: list[Any], data_path: Path) -> bool:
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
                file_uid = file_info["fileUid"]
                original_name = file_info.get("originalName", file_uid)
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


def route_executor(cap: str) -> Callable[..., bool] | None:
    """Pick function based on capability string."""
    if cap.startswith("llm."):
        return execute_llm_query

    if cap.startswith("docker."):
        return execute_docker_run

    if cap.startswith("imggen."):
        return execute_imggen_comfyui

    if cap.startswith("custom."):
        return execute_custom_cap

    if cap.startswith("slavemode."):
        return execute_slavemode

    return {
        "debug.echo": execute_debug_echo,
        "shell.bash": execute_shell_bash,
        "shellcmd.bash": execute_shellcmd_bash,
        "tts.kokoro": execute_kokoro_tts,
    }.get(cap)


def handle_task(http: HttpClient, task: dict[str, Any]) -> None:
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
    try:
        report_starting(http, task_id)
    except TaskCancelled:
        logger.info(f"Task {task_id.id} cancelled before execution started")
        report_cancelled(http, task_id, capability)
        return

    # Download files from buckets
    if file_buckets:
        if not download_bucket_files(http, task_id, capability, file_buckets, data_path):
            logger.error("Bucket file download failed; skipping task.")
            return

    # Download files from fetch_files references
    if not download_required_files(http, task_id, capability, fetch_files, data_path):
        logger.error("File download failed; skipping task.")
        return

    try:
        report_progress(http, log=None, stage="running", task_id=task_id)
    except TaskCancelled:
        logger.info(f"Task {task_id.id} cancelled before execution")
        report_cancelled(http, task_id, capability)
        return

    # Execute task
    try:
        if capability.startswith("imggen."):
            executor(http, task_id, capability, payload, data_path, output_bucket=output_bucket)
        else:
            executor(http, task_id, capability, payload, data_path)
    except TaskCancelled:
        # Fallback: executor didn't handle cancellation itself
        logger.info(f"Task {task_id.id} cancelled (unhandled by executor)")
        report_cancelled(http, task_id, capability)
    except Exception as e:
        logger.error(f"Executor failed: {e}")
        report = make_failure_report(task_id, capability, str(e))
        report_result(http, report)


# -----------------------------------------
# Capability rescan scheduler
# -----------------------------------------

# Rescan intervals in seconds: 30s → 2 min → 5 min → 15 min (forever)
_RESCAN_INTERVALS = [30, 120, 300]
_RESCAN_STEADY_INTERVAL = 900


def _rescan_and_push() -> None:
    """Detect capabilities and push the updated list to the server."""
    logger.info("[rescan] Starting capability rescan...")
    try:
        cfg = load_config()
        server_url: str = cfg.get("server", "")
        jwt: str = cfg.get("jwtToken", "")
        if not server_url or not jwt:
            logger.warning("[rescan] No server/JWT in config — skipping.")
            return

        http = HttpClient(server_url, jwt)
        caps = rescan_and_push(http, lambda msg: logger.info(msg))
        logger.info(f"[rescan] Updated server with {len(caps)} capabilities.")
    except Exception as e:
        logger.error(f"[rescan] Failed to push capabilities: {e}")


def _rescan_scheduler(busy_event: threading.Event, stop_event: threading.Event) -> None:
    """Background thread: fire capability rescans on a stepped schedule.

    Schedule: 30 s → 2 min → 5 min → 15 min (repeating).
    Skips a cycle (without resetting the schedule) if the agent is busy.
    """
    schedule = itertools.chain(_RESCAN_INTERVALS, itertools.repeat(_RESCAN_STEADY_INTERVAL))
    for interval in schedule:
        _wait_interruptible(interval, stop_event)
        if stop_event.is_set():
            return
        if busy_event.is_set():
            logger.info("[rescan] Agent busy — skipping scheduled rescan.")
            continue
        threading.Thread(target=_rescan_and_push, daemon=True).start()


def _wait_interruptible(seconds: int, stop_event: threading.Event) -> None:
    """Sleep for `seconds`, waking every second to check stop_event."""
    deadline = time.monotonic() + seconds
    while not stop_event.is_set() and time.monotonic() < deadline:
        time.sleep(1)


def start_rescan_scheduler(busy_event: threading.Event, stop_event: threading.Event) -> None:
    """Launch the background capability rescan scheduler thread."""
    t = threading.Thread(
        target=_rescan_scheduler, args=(busy_event, stop_event), daemon=True
    )
    t.start()


# -----------------------------------------
# Main loop
# -----------------------------------------

def serve_tasks(server_url: str, jwt_token: str, stop_event: threading.Event | None = None) -> None:
    http = HttpClient(server_url, jwt_token)
    auth_backoff = 10
    _stop = stop_event or threading.Event()
    busy_event = threading.Event()
    start_rescan_scheduler(busy_event, _stop)

    while not _stop.is_set():
        try:
            task_info = poll_task(http)
            if not task_info or not task_info.get("id"):
                time.sleep(5)
                continue

            auth_backoff = 30
            raw_id = task_info["id"]["id"]
            raw_cap = task_info["id"]["cap"]

            task = take_task(http, raw_id, raw_cap)
            if not task:
                time.sleep(5)
                continue

            busy_event.set()
            try:
                handle_task(http, task)
            finally:
                busy_event.clear()

        except AuthError:
            logger.warning(f"Auth rejected — attempting recovery...")
            new_jwt = _reauth_or_reregister(server_url)
            if new_jwt:
                http = HttpClient(server_url, new_jwt)
                auth_backoff = 10
            else:
                logger.error(f"Could not recover auth. Backing off for {auth_backoff}s...")
                time.sleep(auth_backoff)
                auth_backoff = min(auth_backoff * 2, 1200)

        except Exception as e:
            logger.critical(f"Unexpected exception in main loop: {e}")

        time.sleep(5)
