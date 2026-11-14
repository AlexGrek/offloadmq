---
name: oai-personas
description: OAI Personas at /app/personas — characters with face images, look, system prompt and model preferences; persona chats (chats.kind = 'persona'), persona photos (parent job chaining imggen → img-utils face_swap → upscale child jobs), {p_name}/{p_look}/{p_system} tokens, "most used" model defaults, REST chat send, `oai persona` CLI and the *persona* MCP tools. Use when touching services/personas.rs, services/persona_photos.rs, routes/personas.rs, db/personas.rs, db/persona_photos.rs, mcp/tools/personas.rs, cli/personas.go, PersonasPage.tsx, components/personas/**, api/personas.ts, or the persona branch of ChatWorkspace / services/chat.rs.
---

# OAI Personas

Full reference: `oai/docs/personas.md`. Stack with `oai-backend` / `oai-frontend`, plus
`oai-chat` (persona chats), `oai-img` + `oai-img-tools` (photo child jobs), `oai-cli`, `oai-mcp`.

## Shape

- **Persona** (`personas` table): faces are an ordered JSON id list (`face_image_ids_json`,
  first = primary; dangling ids are filtered on read). Preferences are nullable base
  capabilities, validated by prefix (`normalize_pref`). Update is a **full PUT** — CLI and
  MCP read → merge → PUT (`personas::input_from`).
- **Tokens** `{p_name}` `{p_look}` `{p_system}`: `personas::render_tokens`, always *before*
  `PromptExpander`. Reserved as placeholder names via `prompt_placeholders::is_reserved_name`
  (checks `personas::PERSONA_TOKENS`). Substituted only where present — never prepended
  (user decision).
- **Model resolution** (`effective_models`, `resolve_llm|imggen|img_tool`): preference →
  user's most-used online → first online (`source` says which). If the OffloadMQ listing
  fails, a set preference still stands (`preference_or`, `online:false`).
- **Photos** (`persona_photos.rs`): parent job modelled on `image_cycles.rs` — steps in
  `steps_json`, child id saved *before* submit, advisory lock (`db::image_cycles::lock`).
  Steps: `generate` (`image_jobs::start_job_with_id`), `face_swap` / `upscale`
  (`img_utils::start_job_with_id`). Everything (models, workflows, face, scale) is resolved in
  `resolve_params` at start; local checks (scale, faces) run before any OffloadMQ lookup.
  `poll(.., foreground=true)` also pokes the active child's own `poll_job`; the worker pass
  (`foreground=false`) only reads child rows. `drive` loops so one poll can finish a step and
  submit the next.
- **Chats**: `ChatKind::Persona` + `chats.persona_id` (FK cascade). System prompt resolved
  live in `chat::effective_system_prompt`; no `note_use` for personas; capability defaults to
  `last_model`, then the persona's effective LLM. `chat::submit_turn` is the transport-free
  core shared by the WS `chat` command and `POST /api/chats/{id}/messages`; REST callers
  spawn `poll_loop` with a dropped receiver and read `GET …/messages/{mid}`
  (`get_message_reconciled`).

## Frontend

- `PersonasPage` (`/app/personas/:personaId?/:tab?`, tabs profile|chat|photos, `new` = create
  form). Sidebar on md+, chip row on phones.
- `PersonaProfile` — faces (upload / library multi-pick / primary / remove), look, system
  prompt, model selects fed by `GET /api/personas/options` with "Auto — X (most used)".
- `PersonaPhotos` — `PromptTextarea` on the shared `imggen-prompt` bucket, txt2img/img2img,
  face picker, Face swap / Upscale ×2 toggles, history grid with step chips, 3 s poll while
  any run is in flight.
- Chat = `ChatWorkspace kind="persona" persona={PersonaChatContext}`: persona's rendered
  prompt shown read-only, `emptyState` from the page, chat created on first send,
  `listChats(token, 'persona', personaId)`.

## Verify

```bash
cd oai/backend && cargo test persona
cd oai/cli && go test ./... -run Persona
cd oai/itests && OAI_BASE_URL=http://127.0.0.1:PORT uv run pytest tests/test_personas.py tests/test_mcp.py -n 0
cd oai/e2e && npx playwright test tests/personas.spec.ts   # mocked, needs the SPA served
```

A real chain needs imggen + img-utils face_swap + upscale agents. Locally: throwaway OffloadMQ
+ a scripted fake agent that uploads to `data.output_bucket` and resolves
`{"images":[{"file_uid","filename"}]}` (see memory `local-imggen-e2e-with-fake-agent`).

## Pitfalls

1. Face swap needs a source face: `face_swap:true` with no faces is a 400; the default is
   "on iff the persona has faces".
2. Deleting a photo run deletes its child jobs **and their images** (intermediates included).
   Deleting a persona does not delete images.
3. Children appear in Image Generation / Image Tools history by design — don't hide them
   without also changing how they are reconciled (their own workers drive them).
4. `persona_photo_jobs` uses the same advisory-lock namespace as image cycles (keyed on the
   snowflake id, which is globally unique).
