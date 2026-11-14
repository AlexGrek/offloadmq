# OAI LangGraph

`/app/langgraph` builds Python LangGraph applications and submits them as non-urgent
`llm-runtime.<model>` tasks. It is available from the dashboard and app navigation.
Only runners with explicit runtime enablement and sensitive model approvals execute
these programs. Python has the runner account's permissions; it is not sandboxed.
See [runner setup and execution contract](llm-runtime-api.md).

## Workspace

- `main.py`: editable graph, stdin request parsing, model calls, and output handling.
- `tools.py`: a default `dummy_tool` and an allowlist-aware `get_tools` registry.
- `pyproject.toml`: standard `[project].dependencies` requirements. The server parses
  TOML and passes these requirements to the runner, which runs `uv sync --refresh`
  for every task. Metadata such as name/version is not used to install a project.
  Python is fixed at 3.11. `requires-python`, if supplied, must be `>=3.11` or
  `==3.11.*`. Build systems, `tool` configuration (including uv sources/indexes),
  dependency groups, dynamic and optional dependencies are rejected. Put required
  packages in `dependencies` or express a direct PEP 508 URL requirement there.
- Resources: any JSON passed as `request["resources"]`. This editor supplies inline
  resource data; it does not upload files or download URLs automatically.
- Output: `{ "data_file": "result.json", "files": ["report.md"] }`. Paths must be
  unique and relative, excluding the two Python source filenames. The program must
  write every declared output. The default program writes its answer into them.

The Python editors provide syntax highlighting, line numbers, undo, search, and Tab
indentation. Escape then Tab moves keyboard focus out of the editor. Drafts are
stored per user in this browser. Viewing saved runs leaves the current draft intact;
**Edit as new run** replaces the draft with the run's saved inputs.

Choose a primary model and optionally named roles such as `critic` or `planner`.
The default `local_llm(role=None)` helper uses the primary model; supplying a role
uses `request["models"][role]`. Pickers list only online runtime capabilities.
Every model must be enabled on the same runner; OffloadMQ enforces this when
scheduling. Individually online models on different machines may remain queued.
No model is downloaded automatically.

System and user prompts each have a saved prompt library (`langgraph-system` and
`langgraph-user` buckets). Successful submissions record prompt recents server-side;
favorites, search, edits, and deletion use OAI's shared prompt drawer.

The allowed-tools input supports all, none, or a named list. The default tools.py
honors this contract and rejects unknown names. Submitted code is responsible for
honoring it; the setting does not constrain arbitrary Python.

## Runs and results

Each run stores an immutable snapshot of code, pyproject, prompts, tools, resources,
output definition, runtime limit, and selected models. History lists the latest 100
runs. Viewing a run polls every three seconds until terminal; a background worker
continues reconciliation after navigation or a backend restart.

Results show Markdown text, raw stdout, stderr, dependency setup diagnostics, exit
code and optional JSON data. Failed/canceled task polls retain their captured
inline output. Successful artifact files are copied from the OffloadMQ bucket to
OAI storage before the bucket is released. Downloads require the job owner's JWT
and are served as attachments. The metadata and inline result are kept on the job
row; blob paths use numeric artifact slots rather than submitted filenames.

Cancel works for queued and running tasks. Retry is allowed for failed/canceled
runs and creates a new run from the exact saved request. Editing a completed run
creates a fresh request. Delete is allowed only after terminal status and removes
job artifacts, including partially persisted files. Each file is capped at 64 MiB,
with at most 16 files per run; the runner's normal inline-result limits also apply.

## API

All routes require Bearer authentication and scope jobs/artifacts to the owner.

| Method | Path | Result |
|--------|------|--------|
| GET | `/api/langgraph/capabilities` | Online runtime capability array |
| POST | `/api/langgraph/jobs` | 201 `{job_id,status}` |
| GET | `/api/langgraph/jobs` | Latest 100 summaries, without code/results |
| GET | `/api/langgraph/jobs/{id}` | Saved request, result, artifacts and lifecycle |
| POST | `/api/langgraph/jobs/{id}/poll` | Reconcile and return detail |
| POST | `/api/langgraph/jobs/{id}/cancel` | Cancel outcome |
| POST | `/api/langgraph/jobs/{id}/retry` | 201 new job ID |
| DELETE | `/api/langgraph/jobs/{id}` | 204 |
| GET | `/api/langgraph/jobs/{id}/artifacts/{index}` | Attachment bytes |

Submit body:

```json
{
  "capability": "llm-runtime.qwen3:8b",
  "models": {"critic": "gemma3:12b"},
  "main_py": "import json,sys\nr=json.load(sys.stdin)\nprint(r['user_prompt'])\n",
  "tools_py": "# Application tools\n",
  "pyproject": "[project]\nname='example'\nversion='0.1.0'\ndependencies=[]\n",
  "system_prompt": "You are a helpful assistant.",
  "user_prompt": "Hello",
  "allowed_tools": [],
  "resources": {},
  "output": {"files": []},
  "runtime_secs": 600
}
```

Runtime is 1–3600 seconds, default 600. Code is limited to 1 MiB combined; prompts,
resource JSON and pyproject to 64 KiB each. There are at most 16 named model roles
and 128 dependencies. Invalid requests fail before creating a job. A failed
submission after job creation is recorded as a failed run and any created bucket
is cleaned up.

Migration `m20261114_000044_create_langgraph_jobs` runs at backend startup. The
shared worker uses `LANGGRAPH_WORKER_TICK_SECS` (10) and
`LANGGRAPH_WORKER_BATCH_SIZE` (20). No new required deployment configuration.

The editors follow [CodeMirror's setup API](https://codemirror.net/examples/basic/).
TOML parsing uses the [toml crate](https://docs.rs/toml/latest/toml/).
