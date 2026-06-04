# Chat attachments

LLM chat (`/app/chat`) lets a user attach **images** and **text documents** to a
message, or **reference** files they already have (uploaded or AI-generated
images, plus previously uploaded documents). The offload agent reads them: it
extracts text from documents and base64-attaches images to the model request.

## How it works

OAI stages all of a turn's attachments into a single one-shot OffloadMQ bucket
and submits the normal `llm.*` chat task with `file_bucket: [<uid>]`. The agent
(`offload-agent/app/exec/llm.py`) then, for files in the task data dir:

- **Documents** (`.pdf .txt .md .csv .json .xml .yml .yaml .log`) → extracts text
  and appends it to the **last user message** content.
- **Images** → base64-encodes and appends to the last user message's `images`
  field (Ollama vision input).

Streaming stays on, so replies still stream back.

```
composer/picker → pre-upload (REST) → attachment ids
   ws "chat" { ..., attachment_ids } → link to user message
   → stage bucket → submit task file_bucket:[uid] → agent reads files
```

## Storage model — `chat_attachments`

One row per attachment **instance** on a message (snowflake `id`):

| Field | Notes |
|-------|-------|
| `message_id` | null until the attachment is linked to a sent user message |
| `kind` | `"image"` or `"document"` |
| `image_file_id` | for images → reuses `image_files` (served by `/api/images/files/{id}`) |
| `storage_path` | for documents → bytes at `users/{uid}/chat_docs/{id}.{ext}` |

Images never duplicate storage — they point at the existing `image_files` row.
"Reference existing" just creates a new `chat_attachments` row pointing at the
same `image_files` id (image) or shared `storage_path` (document). Document blobs
are **not** deleted when a message/chat is deleted (shared-blob safety); only the
rows go away.

## Limits

- Max **10** attachments per message
- Max **100 MiB** per uploaded document
- Images are normalized/capped by the standard image upload pipeline (≤1920 px)

## REST API (Bearer; `?token=` for downloads)

| Method | Path | Body / result |
|--------|------|---------------|
| POST | `/api/chat/attachments/upload` | multipart `file` → document attachment |
| POST | `/api/chat/attachments/image` | `{ image_id }` → image attachment (new upload or reference) |
| POST | `/api/chat/attachments/reference` | `{ attachment_id }` → re-reference a prior document |
| GET | `/api/chat/attachments/documents` | prior documents (reference picker) |
| GET | `/api/chat/attachments/{id}/download` | document bytes (`?token=`) |

New image uploads go through `/api/images/upload` first, then
`/api/chat/attachments/image` (the frontend's `uploadImageAttachment` does both).

`GET /api/chats/{id}/messages` now returns `attachments[]` per message:
`{ id, kind, filename, content_type, size_bytes, image_id, created_at }`.

## WebSocket

The `chat` command gains an optional `attachment_ids: string[]`. The backend
links those (unlinked, user-owned) rows to the new user message and stages them
into the bucket for that turn only.

## Retry / follow-ups

Attachments are sent **only on their own turn**. On **retry**, the prior user
turn's attachments are re-referenced into fresh rows
(`cloneAttachmentsForResend`) and re-staged — because already-linked rows won't
re-stage. Later turns do not re-send earlier attachments.

## Vision gating

If an image is attached but the selected model has no `vision` tag, the composer
shows a non-blocking warning; the send still proceeds (text documents work on any
model).

## Frontend

| File | Role |
|------|------|
| `frontend/src/api/chatAttachments.ts` | upload/reference/list/download + `cloneAttachmentsForResend` |
| `frontend/src/components/chat/ChatComposer.tsx` | attach menu (`+`), chips, hidden file inputs |
| `frontend/src/components/chat/AttachmentReferencePicker.tsx` | modal: Images + Documents tabs |
| `frontend/src/components/chat/MessageAttachments.tsx` | transcript thumbnails + doc chips |

## Backend

| File | Role |
|------|------|
| `backend/src/services/chat_attachments.rs` | upload/reference/list, `stage_into_bucket` |
| `backend/src/routes/chat_attachments.rs` | REST handlers |
| `backend/src/db/chat_attachments.rs` | `chat_attachments` access (create/link/list) |
| `backend/src/services/chat.rs` | links + stages attachments in `run_chat`; `submit_chat(file_bucket)` |
