---
name: oai-cli
description: >-
  Go engineer context for the OAI command-line client (`oai`). Use when working on
  oai/cli/** — adding a CLI command for an existing OAI backend feature, changing
  auth/config/HTTP helpers, or debugging why `oai login`, `oai image generate`
  (incl. detached `--no-wait` + `image job|poll|download`), `oai image prompts`
  (prompt history + starred prompts), `oai image describe` or
  `oai nude` misbehaves against a backend. Stack with oai-backend (API
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
| `image.go` | `image` sub-dispatch, `capabilities`, `generate` (incl. `--no-wait`), detached-job commands `job`/`poll`/`download` (`imageJobDetail`, `outputImageFiles`), shared `capabilityInfo`, `printCapabilities`, `pickCapability`, `waitForJob` (poll loop), `finishJob` |
| `image_jobs.go` | `image jobs|cancel|retry|delete` — image-job history (`GET /api/images/jobs` = 50 newest, `…/{id}/cancel|retry`, `DELETE …/{id}`); `filterImageJobs`, `localTime`, `flagSet` (was a flag given explicitly), `requireIDs` (rejects blank IDs from an empty `$(…)`) |
| `imgutils.go` | `img-utils tools|run|jobs|job|poll|cancel|retry|delete|download` and the top-level `upscale` shortcut — Image Tools over `routes/img_utils.rs`; `toolsFromCapabilities` (one tool per operation, sorted operation→pack), `pickImgTool` (operation/pack/capability, `-`/`_`-insensitive, `resize`→`basic_resize`), `imgToolOptions` (per-tool flag rules), `waitForImgUtilsJob` |
| `prompts.go` | `image prompts recent|starred|show|star|unstar|record|edit|delete|preview` — the image prompt library (`imggen-prompt` / `imggen-negative` buckets); `promptEntry`/`promptPage` DTOs, `fetchPromptPage`/`fetchAllPrompts` (keyset paging), `findPromptEntry` (ID lookup by scanning — no single-entry GET), `starPrompt` (also used by `generate --star`) |
| `nude.go` | `nude scan|availability|jobs|job|poll|cancel|retry|delete`; also hosts the shared `printJSON` |
| `describe.go` | `image describe`, `image describe-capabilities` |
| `placeholders.go` | `{color}`/`{animal}`/… (gofakeit) + custom `{name}` (server `GET /api/prompt-placeholders`) prompt expansion, mirroring `frontend/src/lib/promptPlaceholders.ts`; `{?}` stays server-side |
| `placeholders_cmd.go` | `image placeholders list|show|create|set|add|remove|rename|edit|delete|expand` — CRUD over `routes/prompt_placeholders.rs`; `fetchPlaceholders` (also used by `generate`), `findPlaceholder` (name case-insensitive, braces optional, or ID), `editText` + swappable `editorCommand` ($VISUAL/$EDITOR) |
| `progress.go` | TTY-aware spinner/progress bar, web-UI timing heuristic, `--progress` / `--profress` flags, plain-output fallback |
| `README.md` | User-facing usage — keep in sync with the usage banner in `main.go` |

Commands today: `login`, `whoami`, `image capabilities|generate|jobs|job|poll|download|cancel|retry|delete|prompts|placeholders|describe|describe-capabilities`, `img-utils tools|run|jobs|job|poll|cancel|retry|delete|download`, `upscale`, `nude scan|availability|jobs|job|poll|cancel|retry|delete`. Default server `https://oai.alexgr.space`.

## Conventions

- **Each command is `cmdX(args []string) error`**; `main` prints `error: <msg>` to stderr and exits 1. Never `os.Exit` inside commands (the one exception is `-h` in `parseInterleaved`).
- **Own a `flag.NewFlagSet(name, flag.ContinueOnError)`** and parse with `parseInterleaved(fs, args)`; it returns the positionals.
- **Auth**: call `requireLogin()`; build URLs with `cfg.serverURL("")`.
- **stdout vs stderr**: results a script might pipe (describe text) go to stdout, progress to stderr. `generate` prints progress to stdout (its output is a file).
- **JSON field names are snake_case**, exactly as the Rust structs (`#[derive(Deserialize)]` with no rename). Optional server fields are pointers (`*string`, `*int64`) so `null`/absent is distinguishable; request-side optionals use `omitempty`.
- **IDs are strings** in JSON (snowflake i64 → string). Path-escape them with `url.PathEscape`.
- **Capabilities**: OAI lists base capabilities (`imggen.x`, `llm.x`); tags describe kind (`txt2img`, `img2video`, `vision`). `pickCapability(caps, preferTag, kind)` picks the first online one with the tag, else any online one — never blindly the first online entry, because imggen also contains img2img/video capabilities.
- **Batch generate (`-n`)**: one job per image, all submitted first, then awaited in order. A non-zero `-seed` is offset by the job index (a shared seed would yield identical images); `outputImagePath` names results (`out.jpg`, `out_2.jpg`; extra images within a batch job get `out_<job>_<image>.jpg`) so jobs never overwrite each other.
- **Prompt placeholders**: `generate` expands them per job through one shared `placeholderExpander` (no repeats across a batch) and sends the raw text as `prompt_template`. JS-only libraries are replaced by Go analogs (gofakeit); anything with no analog (`{starwars}`) is left literal with a warning. Keep the builtin category list in step with the frontend/backend `RESERVED_PLACEHOLDER_NAMES`.
- Every job-style feature follows **submit → poll → terminal** (`completed|failed|canceled`); poll every 5s (`pollInterval`, same as the web UI) via `waitForJob`.
- **Detached mode (`image generate --no-wait`)** splits that flow across invocations. Contract (pinned by `image_detached_test.go`, keep it): stdout is *exactly* the bare job ID(s), one per line, and nothing else — every informational line (auto-selected capability, expanded prompt) must go to stderr when `--no-wait` is set, so `id=$(oai image generate … --no-wait)` works. `-o` is rejected (detected with `fs.Visit`, since its default is non-empty); submit errors in a batch are joined and returned after the IDs already printed. No poll happens. The follow-ups:
  - `image job <id>` → `GET /api/images/jobs/{id}`: last *persisted* state, no OffloadMQ call (the backend's `image_pipeline_worker` reconciles in the background, so this does advance on its own).
  - `image poll <id>` → `POST /api/images/jobs/{id}/poll`: one forced reconcile, prints the refreshed state.
  - `image download <id> -o out.jpg` reads the persisted job (deliberately no poll), refuses non-`completed` jobs, and saves every `direction == "output"` file via `indexedOutputPath` (`out.jpg`, `out_2.jpg`, …).
  - `job`/`poll` take `-json` (`printJSON`, 2-space indent) for scripts. When adding detached mode to another feature, mirror this split and the stdout contract.
- **Prompt library (`image prompts`)** wraps `routes/prompts.rs` — it is *not* a job feature (plain CRUD, no poll):
  - `GET /api/prompts/{bucket}/entries?kind=recent|starred&q=&cursor=&limit=` → `recent` / `starred` listing (`-q`, `-limit`, `-cursor`, `-all`, `-full`, `-json`); the next cursor goes to **stderr** so stdout stays the table/JSON.
  - `POST /api/prompts/{bucket}/star` → `star` (server dedupes by exact content and bumps the existing favorite); `POST …/recent` → `record` and `generate`'s automatic history (once per invocation, gated by `--history`).
  - `PATCH` / `DELETE /api/prompt-entries/{id}` → `edit` / `delete` (the backend works on any owned entry, recent or starred); `GET …/{id}/preview` → `preview` (404 = no preview; `downloadFile` checks status before creating the file, so nothing is left behind).
  - Derived, CLI-only operations: `show <id>` and `star -id <id>` resolve an ID via `findPromptEntry` (scans recent+starred of both buckets; recents are capped at 10, so cheap), `unstar "text"` = search starred with `q` (skipped above the server's 500-char `MAX_QUERY_LEN`) → exact-content match → delete.
  - `-negative` (bool) picks the `imggen-negative` bucket for list/star/unstar/record; ID-based commands need no bucket. Don't confuse it with `generate -negative TEXT`.
  - `show` prints the bare text so `generate "$(oai image prompts show ID)"` works; `generate --star` stars the unexpanded template and reports on **stderr** (keeps the `--no-wait` stdout contract).
  - The web UI uses only the paged `/entries` endpoint; the legacy `GET /api/prompts/{bucket}` (recent+starred at once) isn't wrapped. Bucket names come from `ImageGenerationPage.tsx`; other features' buckets (`llm-system`, `describe-image-user`, …) are out of scope unless asked.
- **Custom placeholders (`image placeholders`)** wrap `routes/prompt_placeholders.rs` — plain CRUD: `GET`/`POST /api/prompt-placeholders`, `PATCH`/`DELETE …/{id}`. `PATCH` takes the **full** `{name, variants}`, so `add`/`remove`/`rename`/`edit` all read the list, modify, and send the whole definition. The backend has no single GET; resolve by name via the list. Names/variants are validated server-side (reserved names, uniqueness, trimming) — don't duplicate that in the CLI. Variant text format everywhere (stdin `-`, `show`, the editor) is one per line, blank lines dropped, matching the web UI's textarea. `show` output is bare so it round-trips with `set NAME -`. `expand` reuses `placeholderExpander`, so it previews exactly what `generate` would send.
- **Image job history** (`image jobs|cancel|retry|delete`): the backend's image `retry` accepts `completed|failed|canceled` and returns a *new* job ID (201); the CLI then reuses `waitForImageJob` + `finishJob` exactly like `generate` (progress on stdout), and `--no-wait` follows the detached stdout contract. `cancel` is asynchronous (`cancelRequested` → `canceled`); a second cancel on a `cancelRequested` job can come back `failed` (upstream task already gone) — that's backend behaviour. Image `delete` purges the job's stored files too. Multi-ID commands continue past failures and `errors.Join` them.
- **Image Tools** (`img-utils`, see the `oai-img-tools` skill for the feature): the capabilities endpoint lists **only online** tools, so "available" = present in the list; `pickImgTool` never falls back to another operation and fails *before uploading* when nothing matches (`oai upscale` relies on this). Per-tool flags: upscale → `options.scale_multiplier` (default 4, 1–8, sent as int when whole); face_swap → `-source` uploaded separately as `source_image_id`; resize → flat `width/height/scale/mode/method/format/quality/allow_upscale` (server validates — only the "nothing to resize to" case is checked locally); `-opt k=v` → verbatim `options` for ComfyUI tools. A flag that doesn't apply to the chosen tool is an error. Output default name `<input>_<tool><ext>` with the ext from the stored output's filename. Unlike `generate`, `run` renders progress and `Job:` lines on **stderr** and prints only `Saved <path> (WxH)` on stdout. img-utils `retry` accepts only `failed|canceled` (not `completed`, unlike image retry); `delete` removes the output only.
- Job commands enable the live progress renderer by default. Pass API timing metadata through `jobProgressState`; keep stdout pipe-safe for result-producing commands by rendering their progress on stderr.

## Adding a new command

1. **Read the contract first** — the frontend client (`oai/frontend/src/api/<feature>.ts`) and the Rust route (`oai/backend/src/routes/<feature>.rs`, wired in `oai/backend/src/app.rs`). Check request field names, required fields, which status codes count as success (job starts return `201`, which `doJSON` accepts), and whether an upload is needed first (`POST /api/images/upload` → `image_id`).
2. **Add DTOs** mirroring the Rust structs (only fields you use).
3. **Write `cmdFeature(args)`** in a new file (or `image.go` if it belongs to an existing group): flags → `requireLogin` → resolve capability → start → `waitForJob` → print/save result.
4. **Wire it**: add a `case` in `main.go` (top-level) or in the group dispatcher (`cmdImage`), and update the usage banner in `main.go`.
5. **Document it** in `oai/cli/README.md`.
6. Verify (below). For a new job type, reuse `waitForJob` rather than copying the loop.

Out of scope so far (add only on request): chat (WebSocket), TTS, music generation, LLM compare/debate, movie, img2img/video, files/storage, admin commands, shell completion.

## Installed copy on the dev Mac

The CLI is **probably already installed** on this Mac and on `PATH`: `~/go/bin/oai` (from
`task install-mac` in `oai/cli/`), and the user's zsh also aliases `oai` to the repo build at
`oai/cli/oai`. It is usually logged in to `https://oai.alexgr.space` already — check with
`oai whoami` before asking for a login. So for reproducing a bug or trying a change end to
end you can just run `oai …`; the `oai-app` skill (`~/.claude/skills/oai-app/SKILL.md`)
covers everyday usage. After changing CLI source, refresh the install with
`cd oai/cli && go test ./... && task install-mac` (this also rebuilds `oai/cli/oai`).
The Bash tool doesn't load zsh aliases reliably, so call `~/go/bin/oai` explicitly if `oai`
isn't found.

## Build & verify

```bash
cd oai/cli
gofmt -l .
go test ./...
go vet ./...
go build -o oai .
```

`batch_test.go` exercises multi-job generation and description against a mock HTTP server; `image_detached_test.go` covers `--no-wait` (stdout is only IDs, no polling, `-o` rejected) and `job`/`poll`/`download`; `nude_test.go` the nude commands; `image_jobs_test.go` covers `image jobs` filters, multi-ID cancel/delete error aggregation, and `retry` (wait+download, `--no-wait` bare ID); `imgutils_test.go` covers tool resolution (aliases, first-by-pack, `-capability`, nothing online), `upscale` defaults and its "no upscale tool" failure (nothing uploaded), per-tool option/flag rules, `--no-wait` and batch naming, and `download`/`jobs`; `placeholders_cmd_test.go` runs every `image placeholders` subcommand against an in-memory fake with the server's validation (the editor is a temp shell script swapped into `editorCommand`, run through `sh -c '$EDITOR "$@"'` like git); `prompts_test.go` runs every `image prompts` subcommand plus `generate --star` against an in-memory fake of the prompt routes (paging, search, dedupe, cross-bucket ID lookup, preview 404); `progress_test.go` covers the web-UI timing heuristic, flags, terminal sizing, and redirected-output fallback. End-to-end verification against a real backend is still manual:

```bash
./oai login -server http://localhost:3001 -login root    # local: root / 000000
./oai whoami
./oai image capabilities
./oai image generate "a red bicycle" -o /tmp/bike.jpg && file /tmp/bike.jpg
id=$(./oai image generate "a red bicycle" --no-wait) && ./oai image poll "$id"
./oai image job "$id" -json                  # repeat until "status": "completed"
./oai image download "$id" -o /tmp/bike2.jpg
./oai image describe /tmp/bike.jpg -capability llm.qwen3-vl:8b
./oai image prompts recent && ./oai image prompts starred -limit 5
./oai image jobs -active && ./oai img-utils tools
./oai upscale /tmp/small.jpg -scale 2 -o /tmp/up.jpg   # then: oai img-utils delete <id>
```

Prompt-library checks on **prod** touch the user's real library. Listing, `show` and `preview` are read-only. For writes, use a net-zero round trip on a throwaway text (`star "zz-cli-test …"` → `show` → `edit` → `unstar`). **Never `record` on prod**: recents are capped at 10, so it evicts one of the user's real entries. For placeholders, `list`/`show`/`expand` are read-only; test writes on a throwaway name (`create zz-cli-test a` → `add` → `remove` → `rename` → `delete`).

Real generation/description needs an **online agent** with the capability (ComfyUI for `imggen.*`, Ollama vision model for `llm.*`). A local `task dev` OAI has none unless you attach an agent, so generation is normally tested against `https://oai.alexgr.space` with the user's own login (ask the user to run `oai login` themselves — do not guess credentials on prod). To test CLI plumbing without agents, point `-server` (or `~/.oai-cli.json`) at a throwaway mock HTTP server and use a temp `HOME` so the real config is untouched. Don't leave generated files in the repo; write to `/tmp`. The built `oai` binary is git-ignored (`oai/cli/.gitignore`).

## Debugging

| Symptom | Likely cause / where to look |
|---------|------------------------------|
| `not logged in — run oai login first` | No token in `~/.oai-cli.json`; `whoami` to confirm |
| `Unauthorized` / `unauthorized — run oai login again` | Token expired/invalid or wrong server; re-login. Check `server` in the config — login stores the server it logged in on |
| `login failed: Invalid credentials` | Wrong login/password; `OAI_PASSWORD` env silently overrides the prompt — `unset` it |
| `no <kind> capability is online; known: …` | No agent online. Compare with `image capabilities` / the web UI. Not a CLI bug |
| `job failed: <msg>` | Job reached `failed` on the server; the message is the backend's `error` field. Same job appears in the web UI (Describe/Images history) — check its details there, then `debug-stack` skill for agent/MQ side. Model-specific failures (e.g. a big vision model failing) reproduce with the web UI too; retry with `-capability` |
| `timed out after … (job X is still running…)` | Only the CLI gave up; the job continues. Raise `-timeout`, or resume with `image job X` / `image download X` |
| `--no-wait` output breaks `$(…)` capture | Something new printed to stdout under `--no-wait`; route it to stderr (see the detached-mode contract) |
| `image download`: `job X is submitted/running` | Expected before completion — `download` never polls. `image poll X` or wait for the background worker |
| `prompt X not found in imggen-prompt or imggen-negative` | `show`/`star -id` only search the two image buckets; the ID may belong to another feature's bucket, or was deleted/trimmed out of recents |
| `no starred prompt in … has exactly that text` | `unstar` needs the exact stored (trimmed) text — use `starred -q …` to find it, or `delete <id>` |
| `prompt cannot be empty` / `prompt exceeds 32000 characters` | Server-side validation in `db/prompts.rs` |
| `no upscale tool is available; online tools: …` | No online agent advertises an `upscale` operation under `img-utils.*` — check `oai img-utils tools` / the agent's installed workflows (`oai-img-tools` skill). Not a CLI bug |
| `only failed or canceled jobs can be retried` | img-utils retry refuses completed jobs (image retry allows them) — rerun with `img-utils run` instead |
| `HTTP 405` on cancel/delete | A blank ID reached the collection URL — `requireIDs` should catch it; check the new command calls it |
| `HTTP 4xx` with no message | Backend returned a non-`{error}` body — usually a request-shape problem (field name/type). Diff the DTO against the Rust struct |
| `HTTP 413` on describe/upload | Upload over the backend cap (`image_processing::MAX_UPLOAD_BYTES`) |
| Decode error (`cannot unmarshal …`) | DTO type mismatch (e.g. ID as number, nullable field not a pointer) |

Useful moves: `curl -H "Authorization: Bearer $(jq -r .token ~/.oai-cli.json)" https://oai.alexgr.space/api/...` to see the raw response; temporarily print the request body in `doJSON`; check the backend route in `oai/backend/src/routes/` and the offload-job state machine in `services/offload_job.rs` for why a job stays in a non-terminal state.

The token in `~/.oai-cli.json` is a credential — never paste it into commits, docs, or logs.
