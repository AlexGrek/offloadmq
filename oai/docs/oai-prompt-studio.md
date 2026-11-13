# OAI Prompt Studio (`/app/prompt-studio`)

An LLM chat specialised for image-prompt engineering. Each sidebar entry is a studio
session: the system prompt makes the model an artistic image-prompt engineer, the first
message is usually an **example prompt** run through a **message template**, and every
reply can go straight to txt2img.

## How it is built

A studio session **is a chat**: a `chats` row with `kind = 'prompt_studio'`. Everything
the LLM Chat page has — WS `chat` command, streaming progress, `WorkloadContext`, cancel,
the pending-reply reconcile worker, ToolDebug, image attachments — is reused unchanged.

| Layer | File |
|-------|------|
| Page | `frontend/src/pages/PromptStudioPage.tsx` → `<ChatWorkspace kind="prompt_studio" />` |
| Shared chat UI | `frontend/src/components/chat/ChatWorkspace.tsx` (`KIND_CONFIG`; LLM Chat is `kind="chat"`) |
| Setup panel | `frontend/src/components/promptStudio/PromptStudioSetup.tsx` |
| Helpers | `frontend/src/lib/promptStudio.ts` (`renderTemplate`, `extractPrompt`, buckets, route state) |
| Kind | `backend/src/db/chats.rs` `ChatKind` (`chat` / `prompt_studio`) |
| Migration | `m20261113_000042_prompt_studio` — `chats.kind` (default `chat`) + two prompt-default columns |

### API

- `GET /api/chats?kind=chat|prompt_studio` — default `chat`, so LLM Chat never lists studio
  sessions and vice versa. Unknown kind → 400.
- `POST /api/chats` `{ kind?, system_prompt?, last_model? }` — empty system prompt resolves the
  per-kind default (`prompt_studio_system` for studio). Response carries `kind`.
- Messages, PATCH system prompt / last model and DELETE are kind-agnostic (ownership only).

## UX

- **Enter adds a newline**; Ctrl/⌘+Enter or the send button sends (`ChatComposer enterSends={false}`).
- **New session** opens a draft (no row yet). The session is created on the **first send**
  from the setup panel's system prompt; an existing empty session gets its prompt PATCHed if edited.
  The just-created session skips its REST message load so it can't wipe the optimistic first turn.
- **Setup panel** (shown while the session has no messages):
  - *System prompt* — own library bucket `prompt-studio-system`.
  - *Example prompt* (optional) — picks from the txt2img library (`imggen-prompt`, with previews).
  - *Message template* — own library bucket `prompt-studio-user`; `{prompt}` is replaced by the
    example (a template without it gets the example appended after a blank line).
  - The rendered message fills the composer; template/example edits re-render it only while the
    composer is empty or still holds the last rendered text — user edits are never clobbered.
  - A template is recorded as a recent in `prompt-studio-user` when it opened a session with an
    example. System prompts are recorded server-side per kind (`ChatKind::system_prompt_bucket`).
- **Images** can be attached on any turn (upload, library, paste). Documents are not offered.
- Every finished message (reply **and** the user's own message) and the setup panel's example
  prompt get three actions (`components/promptStudio/PromptActions.tsx`). The prompt is
  `extractPrompt(content)`: the body of a single fenced code block, otherwise the whole text, minus
  one pair of wrapping quotes.
  - **Generate** (Zap) — the shared quick txt2img dialog (`components/imggen/QuickGenerateDialog.tsx`,
    also used by Describe Image): model, size preset, count; jobs show up in Progress and the user
    stays in the studio. The prompt field is **not** auto-focused (size/model are the usual next step).
  - **Edit** (Highlighter) — the smart **prompt editor** (below).
  - **Use** (ImagePlus) — `/app/images` with `ImggenRouteState.usePrompt` (switches to txt2img).
- **"Good, now create another one"** quick reply appears above the composer after each reply.

## Prompt editor

`components/promptStudio/PromptEditor.tsx` — a full-screen dialog; splitting/editing helpers are
pure functions in `lib/promptSegments.ts` (`splitSegments`, `replaceSegment`, `removeSegment`,
`appendSegment`). The prompt text is the single source of truth; segments are re-derived from it.

- The prompt is laid out as **sentences** or **phrases** (sentences + `,` `;` `:`), toggle persisted
  in `oai_prompt_editor_mode`. A terminator only splits when whitespace follows (`f/1.8`, `8.5mm`
  stay whole); line breaks always split and survive edits.
- Hover highlights a segment; click selects it (others dim) and shows **Edit / Delete**. Clicking a
  selected segment edits it in place (Enter saves, Esc cancels, empty deletes). **Add sentence**
  appends one with the punctuation the mode expects. Deleting a sentence-closing phrase repairs the
  dangling comma (`a, b, c. Next` − `c.` → `a, b. Next`).
- Keyboard: ←/→ select, Enter edit, Delete/Backspace delete (selection moves on), Esc deselect then
  close, Ctrl/⌘+Z / Shift+Z undo/redo, Ctrl/⌘+Enter generate. **Plain text** mode edits the whole
  prompt in a textarea (one undo step). Reset restores the original prompt.
- Side panel: size presets (Square/Landscape/Portrait with aspect thumbnails, last pick persisted in
  `oai_prompt_editor_size`), model, count and **Generate now** — starts txt2img jobs
  (`components/imggen/useQuickTxt2Img.ts`, shared with the quick dialog) and keeps the editor open.
  **Open in Image Generation** hands the edited prompt to txt2img; **Copy**; for the example prompt,
  **Use as example** writes the edit back to the setup panel (re-rendering the composer).

## Entry points from other apps

`navigate('/app/prompt-studio', { state: { examplePrompt } })` (`PromptStudioRouteState`) opens a
new draft session with that example and the default template.

- Image Generation: **Prompt studio** on the Prompt label row (`imggen-prompt-studio-open`) —
  passes the raw prompt textarea (placeholders intact).
- Describe Image: **Prompt studio** in the result header (`describe-prompt-studio-open`) — passes
  the description.

## Defaults

`default_prompts.json` → `prompt_studio_system`, `prompt_studio_template`; overridable per user
in Settings → Default prompts (`user_prompt_defaults.prompt_studio_system|template`). The browser
remembers the last studio system prompt for 24 h (`oai_prompt_studio_system_prompt:{userId}`),
separately from Chat's.

## Tests

- itest `oai/itests/tests/test_chats.py::TestPromptStudioChats`
- mocked e2e `oai/e2e/tests/prompt-studio.spec.ts`; defaults round trip in `prompt-defaults.spec.ts`
- Rust: `db::chats::tests`, `db::prompt_defaults::tests`

## data-testid

```
prompt-studio-page, prompt-studio-setup, prompt-studio-system, prompt-studio-system-reset,
prompt-studio-example, prompt-studio-template, prompt-studio-template-reset,
prompt-studio-{generate,edit,use-as-prompt} (replies), prompt-studio-user-{…} (user messages),
prompt-studio-example-{…} (example field), prompt-studio-generate-{dialog,prompt,model,size-WxH,submit},
prompt-studio-another,
prompt-editor, prompt-editor-{segment-N,segment-toolbar,segment-edit,segment-delete,segment-input,
segment-save,add,mode-sentence,mode-phrase,raw,undo,redo,reset,close,size-WxH,model,count,generate,
notice,use,copy,apply,stats},
imggen-prompt-studio-open, describe-prompt-studio-open
(+ shared chat ids: chat-input, send-btn, new-chat-btn, chat-item-{id}, …)
```
