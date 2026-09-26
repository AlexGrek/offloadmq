---
name: oai-cli
description: >-
  Go engineer context for the OAI command-line client (`oai`). Use when working on
  oai/cli/** — adding a CLI command for an existing OAI backend feature, changing
  auth/config/HTTP helpers, or debugging why `oai login`, `oai image generate`, or
  `oai image describe` misbehaves against a backend. Stack with oai-backend (API
  contract), oai-img / oai-chat (feature semantics).
---

# OAI CLI (`oai/cli/`)

A standalone Go CLI that drives the **same HTTP API the React SPA uses** (`oai/frontend/src/api/*`), with the same JWT bearer auth. It has no server-side component of its own: every feature it exposes must already exist as a backend route.

Style: flat `package main`, stdlib only (`net/http`, `encoding/json`, `flag`) plus `golang.org/x/term` for password prompts. No CLI framework. Modelled on `micro-agent/`.

## Layout

| File | Role |
|------|------|
| `main.go` | Top-level dispatch on `os.Args[1]`, usage banner, `parseInterleaved` (flags before **or after** positionals — plain `flag.Parse` stops at the first positional) |
| `config.go` | `Config{Server, Token, Login}` in `~/.oai-cli.json` (0600); `serverURL()` (override → config → `defaultServer`); `requireLogin()` |
| `httpclient.go` | `doJSON` (bearer + `{error}` unwrapping, mirrors `frontend/src/api/http.ts`), `downloadFile`, `uploadFile` (multipart field `file`), `errNotLoggedIn` |
| `password.go` | `readLine`, `readPassword` (`OAI_PASSWORD` env → TTY no-echo → piped stdin) |
| `auth.go` | `login`, `whoami` |
| `image.go` | `image` sub-dispatch, `capabilities`, `generate`, shared `capabilityInfo`, `printCapabilities`, `pickCapability`, `waitForJob` (poll loop), `finishJob` |
| `describe.go` | `image describe`, `image describe-capabilities` |
| `progress.go` | TTY-aware spinner/progress bar, web-UI timing heuristic, `--progress` / `--profress` flags, plain-output fallback |
| `README.md` | User-facing usage — keep in sync with the usage banner in `main.go` |

Commands today: `login`, `whoami`, `image capabilities|generate|describe|describe-capabilities`. Default server `https://oai.alexgr.space`.

## Conventions

- **Each command is `cmdX(args []string) error`**; `main` prints `error: <msg>` to stderr and exits 1. Never `os.Exit` inside commands (the one exception is `-h` in `parseInterleaved`).
- **Own a `flag.NewFlagSet(name, flag.ContinueOnError)`** and parse with `parseInterleaved(fs, args)`; it returns the positionals.
- **Auth**: call `requireLogin()`; build URLs with `cfg.serverURL("")`.
- **stdout vs stderr**: results a script might pipe (describe text) go to stdout, progress to stderr. `generate` prints progress to stdout (its output is a file).
- **JSON field names are snake_case**, exactly as the Rust structs (`#[derive(Deserialize)]` with no rename). Optional server fields are pointers (`*string`, `*int64`) so `null`/absent is distinguishable; request-side optionals use `omitempty`.
- **IDs are strings** in JSON (snowflake i64 → string). Path-escape them with `url.PathEscape`.
- **Capabilities**: OAI lists base capabilities (`imggen.x`, `llm.x`); tags describe kind (`txt2img`, `img2video`, `vision`). `pickCapability(caps, preferTag, kind)` picks the first online one with the tag, else any online one — never blindly the first online entry, because imggen also contains img2img/video capabilities.
- **Batch generate (`-n`)**: one job per image, all submitted first, then awaited in order. A non-zero `-seed` is offset by the job index (a shared seed would yield identical images); `outputImagePath` names results (`out.jpg`, `out_2.jpg`; extra images within a batch job get `out_<job>_<image>.jpg`) so jobs never overwrite each other.
- Every job-style feature follows **submit → poll → terminal** (`completed|failed|canceled`); poll every 5s (`pollInterval`, same as the web UI) via `waitForJob`.
- Job commands enable the live progress renderer by default. Pass API timing metadata through `jobProgressState`; keep stdout pipe-safe for result-producing commands by rendering their progress on stderr.

## Adding a new command

1. **Read the contract first** — the frontend client (`oai/frontend/src/api/<feature>.ts`) and the Rust route (`oai/backend/src/routes/<feature>.rs`, wired in `oai/backend/src/app.rs`). Check request field names, required fields, which status codes count as success (job starts return `201`, which `doJSON` accepts), and whether an upload is needed first (`POST /api/images/upload` → `image_id`).
2. **Add DTOs** mirroring the Rust structs (only fields you use).
3. **Write `cmdFeature(args)`** in a new file (or `image.go` if it belongs to an existing group): flags → `requireLogin` → resolve capability → start → `waitForJob` → print/save result.
4. **Wire it**: add a `case` in `main.go` (top-level) or in the group dispatcher (`cmdImage`), and update the usage banner in `main.go`.
5. **Document it** in `oai/cli/README.md`.
6. Verify (below). For a new job type, reuse `waitForJob` rather than copying the loop.

Out of scope so far (add only on request): chat (WebSocket), TTS, img2img/video, img-utils, admin commands, shell completion.

## Build & verify

```bash
cd oai/cli
gofmt -l .
go test ./...
go vet ./...
go build -o oai .
```

`batch_test.go` exercises multi-job generation and description against a mock HTTP server; `progress_test.go` covers the web-UI timing heuristic, flags, terminal sizing, and redirected-output fallback. End-to-end verification against a real backend is still manual:

```bash
./oai login -server http://localhost:3001 -login root    # local: root / 000000
./oai whoami
./oai image capabilities
./oai image generate "a red bicycle" -o /tmp/bike.jpg && file /tmp/bike.jpg
./oai image describe /tmp/bike.jpg -capability llm.qwen3-vl:8b
```

Real generation/description needs an **online agent** with the capability (ComfyUI for `imggen.*`, Ollama vision model for `llm.*`). A local `task dev` OAI has none unless you attach an agent, so generation is normally tested against `https://oai.alexgr.space` with the user's own login (ask the user to run `oai login` themselves — do not guess credentials on prod). To test CLI plumbing without agents, point `-server` (or `~/.oai-cli.json`) at a throwaway mock HTTP server and use a temp `HOME` so the real config is untouched. Don't leave generated files in the repo; write to `/tmp`. The built `oai` binary is git-ignored (`oai/cli/.gitignore`).

## Debugging

| Symptom | Likely cause / where to look |
|---------|------------------------------|
| `not logged in — run oai login first` | No token in `~/.oai-cli.json`; `whoami` to confirm |
| `Unauthorized` / `unauthorized — run oai login again` | Token expired/invalid or wrong server; re-login. Check `server` in the config — login stores the server it logged in on |
| `login failed: Invalid credentials` | Wrong login/password; `OAI_PASSWORD` env silently overrides the prompt — `unset` it |
| `no <kind> capability is online; known: …` | No agent online. Compare with `image capabilities` / the web UI. Not a CLI bug |
| `job failed: <msg>` | Job reached `failed` on the server; the message is the backend's `error` field. Same job appears in the web UI (Describe/Images history) — check its details there, then `debug-stack` skill for agent/MQ side. Model-specific failures (e.g. a big vision model failing) reproduce with the web UI too; retry with `-capability` |
| `timed out after … (job X is still running…)` | Only the CLI gave up; the job continues. Raise `-timeout` or look it up in the UI |
| `HTTP 4xx` with no message | Backend returned a non-`{error}` body — usually a request-shape problem (field name/type). Diff the DTO against the Rust struct |
| `HTTP 413` on describe/upload | Upload over the backend cap (`image_processing::MAX_UPLOAD_BYTES`) |
| Decode error (`cannot unmarshal …`) | DTO type mismatch (e.g. ID as number, nullable field not a pointer) |

Useful moves: `curl -H "Authorization: Bearer $(jq -r .token ~/.oai-cli.json)" https://oai.alexgr.space/api/...` to see the raw response; temporarily print the request body in `doJSON`; check the backend route in `oai/backend/src/routes/` and the offload-job state machine in `services/offload_job.rs` for why a job stays in a non-terminal state.

The token in `~/.oai-cli.json` is a credential — never paste it into commits, docs, or logs.
