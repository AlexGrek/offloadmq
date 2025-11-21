import logging
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
from .data.updn import process_data_download
from .data.fs_utils import *


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

def poll_task(http: HttpClient) -> dict | None:
    """Poll server for a new task, return task_info or None."""
    try:
        resp = http.get("private", "agent", "task", "poll", timeout=60)
        resp.raise_for_status()
        return resp.json()
    except requests.Timeout:
        logger.warning("Polling timed out, retrying...")
    except Exception as e:
        logger.error(f"Polling error: {e}. Backing off for 15s...")
        time.sleep(15)
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


def route_executor(cap: str):
    """Pick function based on capability string."""
    if cap.startswith("LLM::"):
        return execute_llm_query

    return {
        "debug::echo": execute_debug_echo,
        "shell::bash": execute_shell_bash,
        "shellcmd::bash": execute_shellcmd_bash,
        "TTS::kokoro": execute_kokoro_tts,
    }.get(cap)


def handle_task(http: HttpClient, task: dict):
    """Parse and run a single task from the server."""
    task_id = TaskId(
        id=str(task.get("id", {}).get("id", "")),
        cap=str(task.get("id", {}).get("cap", "")),
    )
    capability = task_id.cap
    payload = (task.get("data") or {}).get("payload")
    fetch_files = (task.get("data") or {}).get("fetchFiles") or []

    logger.info(f"Received task: {task_id.to_wire()} with capability '{capability}'")
    logger.info(f"Required files: {fetch_files}")

    executor = route_executor(capability)
    if not executor:
        msg = f"Unknown capability: {capability}"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        report_result(http, report)
        return

    data_path = pick_directory(task_id)

    # Download files — errors are handled and logged inside
    if not download_required_files(http, task_id, capability, fetch_files, data_path):
        logger.error("File download failed; skipping task.")
        return

    # Execute task
    try:
        executor(http, task_id, capability, payload, data_path)
    except Exception as e:
        logger.error(f"Executor failed: {e}")
        report = make_failure_report(task_id, capability, str(e))
        report_result(http, report)


# -----------------------------------------
# Main loop
# -----------------------------------------

def serve_tasks(server_url: str, jwt_token: str) -> None:
    http = HttpClient(server_url, jwt_token)

    while True:
        try:
            task_info = poll_task(http)
            if not task_info or not task_info.get("id"):
                time.sleep(5)
                continue

            raw_id = task_info["id"]["id"]
            raw_cap = task_info["id"]["cap"]

            task = take_task(http, raw_id, raw_cap)
            if not task:
                time.sleep(5)
                continue

            handle_task(http, task)

        except Exception as e:
            logger.critical(f"Unexpected exception in main loop: {e}")

        time.sleep(5)
