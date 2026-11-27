# `shell.*` — shell jobs

Run a command on an agent host inside a workspace, with an env map, credential
passthrough, input files and output artifacts. Executor:
`agent_v2/agent/src/offloadmq_agent/exec/shell/`.

## Capabilities

| Capability | Interpreter | Advertised when |
|---|---|---|
| `shell.bash` | `bash` | bash on `PATH` (Linux/macOS). On Windows: Git for Windows bash (`git` sibling, `%ProgramFiles%\Git\bin\bash.exe`, …). The WSL launcher `System32\bash.exe` is never used. |
| `shell.zsh` | `zsh` | zsh found (always on macOS) |
| `shell.posix` | `/bin/sh` | Linux, macOS |
| `shell.pwsh` | `pwsh` (PowerShell 7) | pwsh found (any OS) |
| `shell.cmd` | `cmd.exe` | Windows |
| `shell.any` | the agent's default shell | Linux/macOS: bash → zsh → sh. Windows: pwsh → powershell.exe → cmd → Git Bash |

All `shell.*` caps are **sensitive** and are off by default. Each one must be opted in
separately (`sensitive_allowed_caps`, or the agent UI's Capabilities page). The
legacy `shellcmd.bash` is unchanged.

`shell.any` scripts cannot know the interpreter in advance. `$OMQ_SHELL`
(`bash`, `zsh`, `posix`, `pwsh`, `powershell`, `cmd`) and `output.shell` tell you
which one ran. Pin a specific agent with `payload.runner = <agent uid>` (server-side
pinning).

## Request

Standard task submission (`POST /api/task/submit` or `/submit_blocking`):

| Field | Purpose |
|---|---|
| `capability` | `shell.bash`, `shell.any`, … |
| `payload` | object below, **or** a bare string (treated as `{"command": "<string>"}`) |
| `file_bucket` / `fetchFiles` | input files, downloaded **into the workspace** before the command runs (a file already present is overwritten) |
| `output_bucket` | required when `payload.artifacts` is set |
| `runtimeSecs` | job timeout (default `timeoutSecs`, else 600 s) |

```json
{
  "command": "make test\n./package.sh",
  "workspace": "build/${env:PROJECT:-demo}/${rand}",
  "cleanup": "auto",
  "env": {"PROJECT": "acme", "PATH": "${env:PATH}:/opt/tools/bin"},
  "inherit_env": true,
  "strict": false,
  "credentials": [
    {"name": "DEPLOY_TOKEN", "type": "value", "value": "…"},
    {"name": "KUBECONFIG", "type": "agent_file", "path": "~/.kube/prod", "as": "file"}
  ],
  "artifacts": ["dist/**", "reports/*.xml"],
  "artifacts_when": "on_success",
  "runner": "01M8…"
}
```

| Field | Default | Meaning |
|---|---|---|
| `command` | — | Required. A single line runs as `sh -c` / `pwsh -Command`. Multi-line text is written to a script file **outside** the workspace and run as a file. cmd.exe always runs a `.cmd` file. |
| `strict` | `false` | Prepend `set -euo pipefail` (bash/zsh), `set -eu` (posix) or `$ErrorActionPreference = 'Stop'` (PowerShell). |
| `workspace` | per-task dir | Working directory. See [Workspace](#workspace). |
| `cleanup` | `auto` | `auto` / `always` / `on_success` / `never`. |
| `env` | `{}` | `NAME: value` map, applied in order. `null` removes a variable. Numbers and booleans are converted to strings. |
| `inherit_env` | `true` | `false` starts from a minimal env (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, Windows system vars). |
| `credentials` | `[]` | See [Credentials](#credentials). |
| `artifacts` | `[]` | Glob patterns relative to the workspace (a string is accepted for one pattern). |
| `artifacts_when` | `on_success` | `always` also uploads after a non-zero exit. |

## Evaluation order

1. **Env.** Start from the agent's environment (or the minimal set), then apply `env` in
   order. A value may reference variables set by earlier keys.
2. **Workspace.** Resolve `workspace` against that env and create it. This happens before
   input files are downloaded.
3. **Credentials.** Resolve credentials. They are *not* visible to `workspace`
   substitution, so a secret never ends up in a path.
4. **Built-in variables.** Add `OMQ_TASK_ID`, `OMQ_CAPABILITY`, `OMQ_SHELL`,
   `OMQ_WORKSPACE` and `OMQ_ARTIFACTS_DIR` (the workspace).
5. **Run.** Run the command. Output streams live to the task log.
6. **Artifacts.** Upload artifacts, then clean up the workspace.

### Substitution grammar (`env` values and `workspace`)

| Token | Value |
|---|---|
| `${rand}` | 12 hex chars. **One value per task**, so `env` and `workspace` see the same one. |
| `${rand:N}` | the first N (1-32) chars of the same value |
| `${task_id}` | the task id |
| `${date}` / `${ts}` | UTC `YYYYMMDD` / unix seconds, fixed at task start |
| `${home}` / `${tmp}` | the agent user's home / the system temp dir |
| `${env:NAME}` or `${NAME}` | a variable from the env being built. **Fails the task if it is unset.** |
| `${env:NAME:-default}` | `default` when the variable is unset or empty |
| `$${` | a literal `${` |

### Workspace

- **Omitted:** a fresh per-task directory, deleted after the task (`cleanup: auto`).
- **Relative:** created under the agent's workspace root. The root is setting
  `shell_workspace_root`, default `~/.offload-agent/shell-workspaces`.
- **Absolute or `~/…`:** used as is. It is rejected if `shell_restrict_workspace` is on
  and the path is outside the root.
- **`cleanup: auto`:** deletes the workspace when it is the default one or the path
  contains `${rand}`. Otherwise it is kept (a persistent build dir).
- **Created directories only:** a directory that already existed before the task is
  **never** deleted, whatever the policy. Only the leaf directory is removed.

Agent settings: `omq config set --shell-workspace-root DIR --shell-restrict-workspace`,
or the **Shell jobs** card on the agent UI's Settings page.

## Credentials

Each entry is `{"name", "type", "as"?: "env" | "file", "mask"?: true, …}`.

| `type` | Fields | Resolved | Exposes |
|---|---|---|---|
| `value` | `value` | inline (from the client) | `NAME` |
| `map` | `values: {"K": "V"}` | inline | each `K` (`name` is only a label) |
| `login_password` | `login`, `password`, `login_var`?, `password_var`? | inline | `NAME_LOGIN`, `NAME_PASSWORD` (or the given vars) |
| `agent_env` | `from`? (default `name`) | the agent's own environment | `NAME` |
| `agent_file` | `path` (`~` expanded, ≤ 1 MiB) | a file on the agent host. Trailing newline is stripped. | `NAME` |
| `agent_cmd` | `command`, `timeout_secs`? (default 30, max 300) | stdout of a command run on the agent, with the step-1 env and the task's shell | `NAME` |

- **`as: "file"`:** writes the value to a `0600` file in a per-task scratch dir outside
  the workspace and sets the variable to that file's **path** (GitLab "file variable"
  semantics). Use it for binary `agent_file` secrets. The scratch dir is always deleted.
- **Masking:** every masked value (≥ 4 chars, plus each line of a multi-line value) is
  replaced by `[MASKED]` in the live log, `stdout`, `stderr` and error messages.
- **Errors:** a missing variable or file, or a failing `agent_cmd`, fails the task
  **before** the command runs. The error names the credential, never its value.

**Inline values are not secret from the server.** `value`, `map` and
`login_password` travel in the task payload. That payload is stored as-is and shown in
the management task list. Use the `agent_*` types to keep secrets on the agent host.

## Artifacts

When the job succeeds (or always, with `artifacts_when: "always"`), the agent expands
`artifacts` relative to the workspace and uploads each file to `output_bucket`:

- **Matching:** `**` recurses, and a matching directory contributes every file under it.
- **Containment:** anything resolving outside the workspace (symlinks) is skipped.
- **Naming:** files keep their workspace-relative path as the bucket file name (`dist/app.tgz`).
- **Limit:** at most 256 files. An upload error fails the task.

Download each file with `GET /api/storage/bucket/{bucket_uid}/file/{file_uid}` (see
[client-storage-api.md](client-storage-api.md)).

## Result

```json
{
  "exit_code": 0,
  "stdout": "…",
  "stderr": "…",
  "stdout_truncated": false,
  "stderr_truncated": false,
  "shell": "bash",
  "shell_path": "/bin/bash",
  "workspace": "/home/agent/.offload-agent/shell-workspaces/build/acme/3fa1c2d4e5b6",
  "duration_ms": 5123,
  "artifacts": [
    {"path": "dist/app.tgz", "file_uid": "…", "bucket_uid": "…", "size": 1024,
     "sha256": "…", "content_type": "application/gzip"}
  ],
  "artifacts_missing": ["reports/*.xml"]
}
```

- **Exit status:** a non-zero `exit_code` marks the task **failed**. The output is still
  returned, and the error is the stderr tail.
- **Truncation:** `stdout` / `stderr` keep the **last** 256 KiB each.
- **Live log:** the task log carries output lines as they arrive (stderr prefixed with
  `[stderr] `), capped at 1 MiB.
- **Optional fields:** `timed_out: true` on a timeout, `artifacts_skipped: true` when a
  failure skipped `on_success` artifacts.
- **Cancel or timeout:** kills the whole process tree (a Unix process group / a Windows
  job object). Background processes still running when the command exits are killed
  too. A cancelled task resolves with the partial output.

Blocking submits return this object under `result`; `POST /api/task/poll` returns it
under `output`.

## Sandbox

The management console's **Sandbox → Shell Jobs** app covers the whole contract:

- shell and agent pickers;
- workspace tokens and the env editor;
- credential rows for every type;
- input upload, artifact globs and downloads;
- presets, which never store inline secret values.
