# Python Agent — Code Review Findings

Review date: 2026-05-22. Scope: `offload-agent/app/` — core polling loop, transport
layer, and all executors.

The one **critical** issue found (Windows `shell.bash`/`docker.*` tasks reporting every
successful run as failed) has already been **fixed** in
[shell.py](../../offload-agent/app/exec/shell.py) and
[docker.py](../../offload-agent/app/exec/docker.py): the redundant post-loop
`process.communicate()` (which re-read pipes the reader threads had already closed —
returning `(None, None)` on Windows → `str += None` → `TypeError` → false failure report)
was replaced with `join` + `_drain_queue` + `process.wait()`.

The remaining items below are **not yet fixed**, ordered by severity.

---

## 🟠 High

### 1. Custom shell-cap parameters can clobber `PATH` / `LD_PRELOAD`, defeating injection-safety

**Where:** [custom_caps.py:219-224](../../offload-agent/app/custom_caps.py#L219-L224)
(`CustomCap.build_env`), used by [custom.py](../../offload-agent/app/exec/custom.py).

`build_env` exports each task-submitter-controlled parameter value under **two** env names:

```python
env[f"CUSTOM_{name.upper()}"] = value
env[name.upper()] = value          # <-- unprefixed alias
```

The `CUSTOM_` prefix is the entire isolation mechanism documented at the top of
`custom.py` ("Values are injected via environment variables, NOT string interpolation").
The unprefixed alias breaks it. The custom-cap *script* and *param names* are authored by
the trusted operator, but param **values** come from untrusted task submitters. If an
operator defines a plausibly-named param (`path`, `home`, `lang`, `pythonpath`, `ifs`, …),
a submitter controls the value of the corresponding real environment variable for the
trusted script's subprocess. A `path` param → submitter sets `PATH`, and the script's
`git` / `curl` / `echo` calls resolve to attacker-chosen binaries (chainable with the file
download mechanism or a prior `shell.bash` task to plant a binary).

**Fix:** drop the unprefixed alias, or refuse to alias any name that collides with a known
sensitive variable (`PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PYTHONPATH`, `IFS`, `HOME`, …).

### 2. Per-line synchronous progress reporting can stall verbose commands

**Where:** [shell.py:85-103](../../offload-agent/app/exec/shell.py#L85-L103) and
[docker.py:151-166](../../offload-agent/app/exec/docker.py#L151-L166).

Every single stdout/stderr **line** triggers a blocking `report_progress()` round-trip
(HTTP or WS) inside the drain loop. A command that emits thousands of lines produces
thousands of serialized network calls, each blocking the loop — output is produced far
faster than it ships, so the queues grow unbounded in memory and the task effectively
hangs. The LLM executors already solve this by batching (flush every ~2s).

**Fix:** batch progress on a time interval instead of per-line, and cap the retained
`full_stdout_log` / `full_stderr_log` size.

---

## 🟡 Medium

### 3. Non-atomic config write can corrupt agent identity

**Where:** [config.py:31-36](../../offload-agent/app/config.py#L31-L36) (`save_config`).

`save_config` writes `~/.offload-agent.json` in place. A crash mid-write corrupts the file
that holds `agentId` / `key` / `jwtToken`, so the agent loses its identity and
re-registers as a brand-new node.

**Fix:** write to a temp file in the same directory, then `os.replace()` onto the target.

### 4. Weak directory-traversal check in file download/upload

**Where:** [updn.py:384](../../offload-agent/app/data/updn.py#L384) and
[updn.py:451](../../offload-agent/app/data/updn.py#L451).

```python
if not os.path.abspath(save_path).startswith(os.path.abspath(base_path)):
    raise ValueError(...)
```

`startswith` has no trailing-separator guard (so a `runs/123` base matches sibling
`runs/1234`) and `os.path.abspath` does not resolve symlinks.

**Fix:** use `Path.resolve()` + `Path.is_relative_to(base.resolve())`.

### 5. No agent-side validation of bucket filenames (defense-in-depth)

**Where:** [core.py:222-243](../../offload-agent/app/core.py#L222-L243)
(`download_bucket_files`).

Downloaded bucket files are written to `data_path / original_name` with **no** traversal /
absolute-path check (unlike `process_data_download`). Verified that
`data_path / "C:/Windows/Temp/x"` escapes the run directory entirely, and `../` segments
are resolved by `open()`. Currently mitigated server-side: `sanitize_upload_path` in
`src/api/client/storage.rs` strips `..` and absolute prefixes before storing
`original_name`. The agent should not trust server-supplied names blindly.

**Fix:** apply the same resolved-path containment check used in `updn.py` (see #4) before
writing.

### 6. Non-streaming LLM requests are uncancellable

**Where:** [llm.py:218-225](../../offload-agent/app/exec/llm.py#L218-L225).

The non-streaming branch blocks on `requests.post` with no 499 / cancellation check, so a
client cancel does not take effect until the model finishes generating.

**Fix:** prefer streaming, or poll progress/cancel on a background thread during the call.

---

## 🟢 Low / notes

- **Unconditional loop sleep** — [core.py:481](../../offload-agent/app/core.py#L481)
  sleeps 5s at the end of every iteration, including immediately after finishing a task and
  after an auth-backoff sleep. Adds idle latency between tasks.
- **Transposed backoff reset** — [core.py:452](../../offload-agent/app/core.py#L452) sets
  `auth_backoff = 30` right after a *successful* poll, while the AuthError-recovery path
  resets it to `10`. The two reset values look swapped/confusing.
- **Re-registration orphans the old agent record** —
  [core.py:163-180](../../offload-agent/app/core.py#L163-L180) creates a new agent
  (`agentId`/`key`) on re-registration. Expected behaviour, but confirm the server reaps
  stale agent records.
