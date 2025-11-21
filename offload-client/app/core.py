import typer
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


def serve_tasks(server_url: str, jwt_token: str) -> None:
    http = HttpClient(server_url, jwt_token)

    # Capability router
    def _route(cap: str):
        if cap.startswith("LLM::"):
            return execute_llm_query
        return {
            "debug::echo": execute_debug_echo,
            "shell::bash": execute_shell_bash,
            "shellcmd::bash": execute_shellcmd_bash,
            "TTS::kokoro": execute_kokoro_tts,
        }.get(cap)

    try:
        while True:
            try:
                # Poll
                resp = http.get("private", "agent", "task", "poll", timeout=60)
                resp.raise_for_status()
                task_info = resp.json()

                if task_info and task_info.get("id"):
                    raw_id = task_info["id"]["id"]
                    raw_cap = task_info["id"]["cap"]
                    q_cap = qpart(raw_cap)
                    # Take
                    take_resp = http.post(
                        "private",
                        "agent",
                        "take",
                        q_cap,
                        qpart(raw_id),
                        json_body={},
                        timeout=60,
                    )
                    take_resp.raise_for_status()
                    task = take_resp.json()

                    task_id = TaskId(
                        id=str(task.get("id", {}).get("id", "")),
                        cap=str(task.get("id", {}).get("cap", "")),
                    )
                    capability = task_id.cap
                    payload = (task.get("data") or {}).get("payload")
                    fetch_files = (task.get("data") or {}).get("fetch_files") or []

                    typer.echo(
                        f"Received new task: {task_id.to_wire()} with capability '{capability}'"
                    )

                    executor = _route(capability)
                    data_path = pick_directory(task_id)
                    if executor:
                        for fileref in fetch_files:
                            try:
                                process_data_download(data_path, fileref)
                            except Exception as e:
                                report = make_failure_report(task_id, capability, str(e))
                                report_result(http, report)
                                return
                        executor(http, task_id, capability, payload, data_path)
                    else:
                        msg = f"Unknown capability: {capability}"
                        typer.echo(msg)
                        report = make_failure_report(task_id, capability, msg)
                        report_result(http, report)

            except requests.Timeout:
                typer.echo("Polling timed out, will retry...")
            except requests.RequestException as e:
                typer.echo(f"Polling error: {e}. Backing off...")
                time.sleep(15)

            time.sleep(5)
    except Exception as e:
        typer.echo(f"Unexpected error in serve loop: {e}")
