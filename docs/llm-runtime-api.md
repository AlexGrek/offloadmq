# LLM runtime tasks

`llm-runtime.<ollama-model>` executes a client-supplied Python application on an
agent v2 runner. This is arbitrary code execution with the runner account's
filesystem, network and process permissions, including dependency build scripts.
A virtual environment isolates dependencies; it is **not a security sandbox**.
Only enable this for clients you trust to execute code on that machine.

## Runner setup

Install `uv` on the runner PATH and install a model in its configured Ollama
server. In `~/.offloadmq-agent.json` (or the runner UI's Config JSON editor), set:

```json
{
  "llm_runtime_enabled": true,
  "llm_runtime_cache_limit": 8,
  "sensitive_allowed_caps": ["llm-runtime.qwen3:8b", "llm-runtime.gemma3:12b"]
}
```

Merge these fields into the existing config; preserve other sensitive capability
choices. Rescan/restart the runner after editing the file externally. Runtime
capabilities appear alongside installed Ollama models when `uv` is available.
Both the enable switch and the exact sensitive capability approval are required.
They are checked before resource preparation and again before execution. A task
cannot opt itself in. Revocation blocks subsequent execution, but does not kill
an already running app; cancel that task separately.

## Submission

Use the existing `/api/task/submit` or `/api/task/submit_blocking` API and client
capability permissions. Prefer non-urgent jobs because environment setup can
exceed the urgent queue's 60-second lifetime. A minimal payload:

```json
{
  "capability": "llm-runtime.qwen3:8b",
  "urgent": false,
  "restartable": false,
  "runtimeSecs": 600,
  "payload": {
    "model": "qwen3:8b",
    "models": {"critic": "gemma3:12b"},
    "dependencies": [],
    "entrypoint": "main.py",
    "files": {
      "main.py": "import json, sys\nr = json.load(sys.stdin)\nprint(r['user_prompt'])\n"
    },
    "args": [],
    "system_prompt": "You are a research assistant.",
    "user_prompt": "Summarize the attached report.",
    "allowed_tools": [],
    "resources": {"report": "report.txt"},
    "output": {"data_file": "result.json", "files": ["report.md"]}
  },
  "file_bucket": ["input-bucket-uid"],
  "output_bucket": "output-bucket-uid",
  "apiKey": "your-client-key"
}
```

The minimal inline script above only prints text; remove `output`, `resources`,
`file_bucket`, and `output_bucket` to run it as-is. A real application must write
all declared outputs. Missing files, invalid JSON data, or upload failures fail
the task while retaining captured streams.

- `model`: primary Ollama model selected by the client. It must match the model
  in `capability` so scheduling and execution agree. For older tasks that omit
  it, the model in the capability remains the default.
- `models`: optional map of named app roles to additional Ollama models, e.g.
  `{"planner":"qwen3:8b", "critic":"gemma3:12b"}`. Defaults to `{}`. Every
  selected model must be installed and explicitly enabled as a sensitive
  `llm-runtime.<model>` capability on the **same runner**. Both queue types and
  tier reservations respect the complete selection. The runner rechecks local
  approval before preparing resources and executing the app. It does not pull
  missing models automatically. Role names are defined by the application;
  unused roles still participate in scheduling.
- `dependencies`: list of PEP 508 Python requirements, e.g. `langgraph`,
  `langchain-ollama`. Pin versions when reproducibility matters.
- `entrypoint`: relative Python script path; executed directly with Python 3.11.
- `files`: optional mapping of relative filenames to UTF-8 source. Apps may also
  come from input buckets or `fetchFiles`; inline files overwrite attached files
  of the same name. Multi-file apps and script arguments are supported.
- `system_prompt`, `user_prompt`: strings passed to the app.
- `allowed_tools`: absent/null means all tools the app exposes; `[]` means none;
  otherwise a list of allowed names. **The app must filter its tool registry**
  before binding tools to its LLM/graph and reject unknown names. This is a
  cooperative application contract, not enforcement against hostile Python.
- `resources`: arbitrary JSON passed unchanged to the app. Use top-level
  `file_bucket`, `fetchFiles`, and `dataPreparation` for existing attachment,
  download and preparation behavior. Resource paths refer to the working directory.
- `output.data_file`: optional relative file containing any JSON value.
- `output.files`: optional relative filenames to upload to the client-owned
  `output_bucket`. No globs. Each file is limited to 64 MiB.

All app/output paths must be relative and cannot traverse directories or escape
through symlinks. These checks avoid accidental path misuse; arbitrary submitted
code still has full machine access.

## Application contract

The script runs in a fresh task directory containing prepared attachments and
source files. Its stdin contains one JSON object:

```json
{
  "system_prompt": "...", "user_prompt": "...", "allowed_tools": null,
  "resources": {}, "output": {}, "data_dir": "/absolute/task/directory",
  "ollama_base_url": "http://127.0.0.1:11434",
  "model": "qwen3:8b", "models": {"critic":"gemma3:12b"}
}
```

`OLLAMA_HOST`, `OLLAMA_MODEL`, and `OFFLOAD_DATA_DIR` expose the same connection
and directory information in the environment. `OFFLOAD_LLM_MODELS` contains the
named role map as JSON. All selected models use the runner's `ollama_base_url`. The app owns graph construction,
LLM calls, tool filtering and final printing. The runner does not append a
second inference. See [the LangGraph example](../examples/llm-runtime/main.py).

The task result always contains `text` (identical to `stdout`), `stdout`, `stderr`
and `files`. After process execution it includes `return_code`. `data` holds the
parsed JSON output if requested. File records contain `filename`, `file_uid`,
`bucket_uid`, and `content_type`. Dependency setup diagnostics use `sync_stdout`,
`sync_stderr`, and `sync_return_code`, separate from the application's output.
A nonzero exit fails the task and preserves diagnostics. No credentials are
injected into the JSON contract, but this is not isolation from the runner's
inherited environment or filesystem.

## Cache and lifecycle

Environments live under `~/.cache/offloadmq/llm-runtime`, keyed by normalized
requirements plus Python version. Identical requirements share an environment;
different dependency sets use separate entries. Each entry includes its uv cache
and lockfile. The runner performs `uv sync --refresh --no-install-project
--python 3.11` on **every** task, including cache hits. Refresh revalidates cached
packages; existing lockfile versions are retained, not automatically upgraded.
See [uv's cache semantics](https://docs.astral.sh/uv/concepts/cache/).

Least-recently-used entries are removed before admitting a new environment. The
positive runner setting defaults to eight entries; this limits entry count, not
bytes. Runtime tasks serialize within a runner through setup and execution so
sync/eviction cannot modify an active environment. Run one agent process per
cache directory. Other task families remain concurrent.

`runtimeSecs` bounds cache waiting, dependency sync and app execution; it defaults
to `timeoutSecs`, then 600 seconds. Attachment preparation uses the existing
pipeline's download timeouts. Uploads use the existing transport timeout. Cancel
and timeout terminate the process group on POSIX or process tree on Windows.
Windows apps and uv start suspended, are assigned to a Job Object with kill-on-close, then resumed; job membership retains descendants
after their parent exits. Cleanup terminates the job and waits for all members
to exit before removing the task directory.
Each captured stream is capped at 8 MiB; exceeding it fails the task and retains
its prefix. JSON data is also capped at 8 MiB. The complete JSON-serialized
result has a separate 8 MiB budget, including escaped characters, duplicated
`text`/`stdout`, setup diagnostics, data and artifact metadata. Oversized results
fail explicitly with `result_truncated`, `original_result_bytes`, diagnostic
prefixes of at most 128 Ki characters, and `truncated_fields`. JSON data is
omitted with `data_omitted=true`; artifact references are retained where they
fit, otherwise `omitted_file_count` records how many were dropped. Store large
application output in declared files to avoid this inline result limit.
Cancellation remains cancellation even if partial output requires truncation.
Task working directories are removed after completion; dependency environments persist. Python code that
intentionally detaches processes or evades cleanup is outside this trust model.

## Implementation plan and validation

1. Reuse generic task scheduling, authorization, buckets and result polling;
   validate runtime payloads on both submission endpoints.
2. Validate primary and named input models; schedule only to runners with every
   selected model. Detect model-specific runtime capabilities and apply both runner enablement
   and sensitive-capability policy before accepting execution.
3. Reuse attachment preparation; execute source with a bounded uv environment
   cache and a documented stdin/output contract.
4. Preserve diagnostics on failures and cancellation; upload declared artifacts.
5. Test policy bypass attempts, path escapes, cache reuse/eviction, process output,
   cancellation/timeout, real uv sync, JSON results and file transport.

## Cancellation protocol compatibility

Deploy the updated OffloadMQ server before the updated agent. Agent cancellation
now resolves with `{"canceled":"Task cancelled by client"}` rather than a failure
or `notExecuted` report. This preserves runner-local cancellation in both urgent
and persistent queues, as well as in the runner UI, and retains partial stdout
and stderr. `notExecuted` keeps its existing server meaning for unsupported or
otherwise unexecuted tasks.

The Job Object lifecycle follows [Microsoft's job object semantics](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
