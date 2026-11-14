# Personas

Personas (`/app/personas`) are reusable characters. Each one has:

- a **name** (unique per user, case-insensitive);
- **face reference images**, ordered, up to 10. The first is the **primary** face;
- a **look** description (hair, body, style…);
- a **system prompt** for its chats;
- optional **preferred models**: chat LLM, txt2img, img2img, face swap and upscaler.

A persona owns **chats** and **photos**. Memory is planned and not implemented yet.

Every function is available in the web UI, the CLI (`oai persona …`, see
[cli/README.md](../cli/README.md)) and MCP (the `*persona*` tools, see [mcp.md](mcp.md)).

## Persona tokens

| Token | Becomes |
|-------|---------|
| `{p_name}` | The persona's name |
| `{p_look}` | The look description |
| `{p_system}` | The rendered system prompt. Inside the system prompt itself it becomes empty, to avoid recursion |

- Matching is case-insensitive and ignores inner whitespace (`{ P_LOOK }`).
- Tokens are substituted **before** regular placeholder expansion, so a look text may use
  `{color}`, custom placeholders or `{a|b}` choices.
- A token is replaced only where it appears. Nothing is auto-prepended to a prompt.
- `p_name`, `p_look` and `p_system` are reserved: no custom placeholder may use them.
- Implementation: `services::personas::render_tokens`.

## Model defaults

A slot with no preference resolves at use time, in this order:

1. The online model the user ran most. For imggen this is the last 20 image jobs; for LLMs
   the last 50 assistant replies (`db::chats::recent_model_usage`); for Image Tools the last
   50 jobs of that operation (`db::img_utils::capability_usage`).
2. Otherwise the first online model.

A set preference is always used, even while it is offline: the task queues until the agent
returns. `GET /api/personas/{id}` reports `effective` per slot as
`{capability, workflow?, source: preference|most_used|only|first_online, online}`.

## Photos — the chain

A photo is a parent job (`persona_photo_jobs`) that runs ordinary child jobs, one after another:

```
generate (imggen txt2img | img2img) → face_swap (img-utils, source = a persona face) → upscale (img-utils, scale_multiplier)
```

The default is all three steps with ×2 upscaling:

- `face_swap` defaults to on when the persona has faces. Passing `true` for a persona with no faces is a 400.
- `upscale` defaults to on.
- Each step's input is the previous step's output image.

**Visibility.** Children are normal jobs, so intermediates appear in Image Generation and
Image Tools history, My Files, the Gallery and the Progress drawer.

**Start (`POST /api/personas/{id}/photos`):**

- Validates the request and resolves every capability up front. These are stored in
  `params_json`, so retry is deterministic. If a needed tool is offline, the start fails
  fast with a 400 such as "no upscale tool is online; pass upscale=false".
- Expands the prompt in this order: persona tokens, then `PromptExpander` (custom and
  built-in placeholders, choices), then `{?}`.
- Records the template in the shared `imggen-prompt` recents, the same pool Image
  Generation uses.

**Engine.** The engine follows `services::image_cycles`:

- Each child id is persisted before it is submitted.
- An advisory lock (`pg_try_advisory_xact_lock(job_id)`) serializes advance, cancel and delete.
- The `persona_photos` worker (`PERSONA_PHOTOS_WORKER_TICK_SECS`, default 3;
  `PERSONA_PHOTOS_WORKER_BATCH_SIZE`, default 20) advances runs from their children's
  persisted rows.
- A foreground `POST …/poll` also polls the active child upstream, so a watched photo
  finishes promptly.

**Retry and delete.** `retry` starts a new run with the same resolved prompt and models.
`delete` removes the run and its child jobs, including their images. The stale-job reaper
covers this table.

## Chats

- A persona chat is a `chats` row with `kind = 'persona'` and `persona_id` set.
- Its system prompt is **not** copied into the chat. `services::chat::effective_system_prompt`
  renders the persona's current prompt at send time, so edits apply to existing chats.
- `PATCH /api/chats/{id}/system-prompt` on a persona chat returns 400.
- Model order: the chat's last model, then the persona's effective LLM.

**REST chat** (generic; used by the CLI and MCP):

- `POST /api/chats/{id}/messages` `{content, capability?, attachment_ids?, max_wait_secs?}`
  returns 201 `{chat_id, user_message_id, assistant_message_id, capability, cap, id}`.
- `GET /api/chats/{id}/messages/{message_id}` returns the message. A `pending` reply is
  reconciled upstream first.

Both paths share `services::chat::submit_turn` with the WebSocket `chat` command.

**Deleting a persona** deletes its chats and photo runs (FK cascade). Generated images
stay in the library.

## API

```
GET    /api/personas                     list (no `effective`)
POST   /api/personas                     PersonaInput → 201 persona
GET    /api/personas/options             model choices per slot (online + known offline)
GET    /api/personas/{id}[?effective=false]
PUT    /api/personas/{id}                full replace (PersonaInput)
DELETE /api/personas/{id}
GET    /api/personas/{id}/photos[?limit=]
POST   /api/personas/{id}/photos         StartPhotoRequest → 201 {job_ids}
GET    /api/persona-photos/{id}
DELETE /api/persona-photos/{id}
POST   /api/persona-photos/{id}/poll | /cancel | /retry
GET    /api/chats?kind=persona&persona_id=…
POST   /api/chats {kind:"persona", persona_id}
```

**PersonaInput:** `{name, system_prompt, look, face_image_ids[], llm_capability,
txt2img_capability, img2img_capability, face_swap_capability, upscaler_capability}`.

- Model fields take a capability or `null`. Blank and `"auto"` mean `null`.
- Bracket attributes are stripped.
- The prefix is checked: `llm.`, `imggen.` or `img-utils.`.
- Faces must be the user's own images. Upload them with `POST /api/images/upload`.

**StartPhotoRequest:** `{prompt, negative_prompt?, workflow? (txt2img|img2img), input_image_id?,
width?, height?, seed?, count? (1–8; one run each, seed+i), face_image_id?, face_swap?, upscale?,
scale? (1–8, default 2), image_model?, face_swap_capability?, upscaler_capability?}`.

- txt2img defaults to 1024×1024.
- img2img defaults to the input's size, or its aspect ratio at a 1024 long edge when the
  input is outside 64–4096.

## Code map

| Layer | Files |
|-------|-------|
| DB | `db/personas.rs`, `db/persona_photos.rs`, entities `personas`, `persona_photo_jobs`, `chats.persona_id` (migration `m20261113_000043_personas`) |
| Services | `services/personas.rs` (CRUD, tokens, model resolution, `chat_for`), `services/persona_photos.rs` (chain driver), `services/chat.rs` (`submit_turn`, `effective_system_prompt`, `get_message_reconciled`) |
| Routes | `routes/personas.rs`, `routes/chats.rs` (`send_message`, `get_message`) |
| Worker | `jobs/persona_photos_worker.rs` |
| MCP | `mcp/tools/personas.rs` |
| CLI | `cli/personas.go` |
| Frontend | `pages/PersonasPage.tsx`, `components/personas/{PersonaProfile,PersonaPhotos}.tsx`, `api/personas.ts`, `ChatWorkspace` `kind="persona"` (`PersonaChatContext`) |
| Tests | `itests/tests/test_personas.py`, `test_mcp.py::TestPersonaTools`, `cli/personas_test.go`, `e2e/tests/personas.spec.ts`, unit tests in both services |
