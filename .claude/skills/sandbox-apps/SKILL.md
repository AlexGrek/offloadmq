---
name: sandbox-apps
description: Frontend engineer context for the management UI sandbox apps. Use when working on any sandbox app component — creating new apps, editing existing ones, DevPanel, or the SandboxApps container.
---

# Sandbox Apps — Frontend Engineering

## What Are Sandbox Apps

Sandbox apps are interactive demo/test widgets embedded in the management frontend. They live inside a modal triggered from a tile grid and let you exercise the OffloadMQ API (task submission, storage, etc.) directly from the browser.

**Entry point:** `management-frontend/src/components/SandboxApps.jsx`

---

## File Map

| File | Purpose |
|------|---------|
| `SandboxApps.jsx` | Container: tile grid, modal shell, tab bar, api key input, devLog state |
| `DevPanel.jsx` | "Dev" tab — shows logged API calls with expand/collapse and method badges |
| `BashApp.jsx` | Execute bash commands (urgent/blocking) |
| `LlmApp.jsx` | Non-streaming LLM prompts (urgent/blocking) |
| `PipelineApp.jsx` | Async bash tasks with polling |
| `StreamingLLMApp.jsx` | Async LLM with streaming output |
| `LlmChatApp.jsx` | Multi-turn LLM chat, supports image attachments |
| `StorageBucketApp.jsx` | File bucket CRUD (client storage API) |
| `PdfAnalyzerApp.jsx` | PDF/image analysis: bucket → upload → task → poll |
| `Txt2ImgApp.jsx` | Text-to-image generation via output bucket |
| `Img2ImgApp.jsx` | Image-to-image transformation via input+output buckets |

---

## App Registry

Apps are registered in the `apps` array inside `SandboxApps.jsx`. To add a new app:

1. Create `management-frontend/src/components/MyApp.jsx`
2. Import it in `SandboxApps.jsx`
3. Add an entry to the `apps` array:

```js
const apps = [
  // ...existing entries...
  { id: 'myapp', name: 'My App', logo: SomeLucideIcon, app: MyApp },
];
```

---

## Props Every App Receives

```jsx
<MyApp apiKey={apiKey} addDevEntry={addDevEntry} />
```

| Prop | Type | Description |
|------|------|-------------|
| `apiKey` | `string` | Client API key; loaded from `localStorage` key `'offroadmq-api-key'` |
| `addDevEntry` | `(entry) => void` | Log an API call to the Dev tab |

---

## `addDevEntry` — Dev Log API

Call this whenever the app makes an HTTP request so it appears in the Dev tab.

```js
// Before the request (show in-progress):
addDevEntry({
  key: 'my-op',          // unique key — same key updates the existing row
  label: 'Submit task',
  method: 'POST',
  url: '/api/task/submit_blocking',
  request: bodyObject,
  response: null,        // null = still in flight
});

// After the response:
addDevEntry({
  key: 'my-op',          // same key replaces the row
  label: 'Submit task',
  method: 'POST',
  url: '/api/task/submit_blocking',
  request: bodyObject,
  response: responseObject,
});
```

**Entry shape:**

```ts
{
  key?: string | null     // omit or null for append-only (no dedup)
  label: string           // human label shown in the row
  method: string          // GET | POST | PUT | DELETE | PATCH
  url: string             // path (no origin needed)
  request: any            // request body; will be JSON.stringify'd
  response: any           // response body; null while in flight
  // ts is auto-added by SandboxApps
}
```

---

## API Key Usage

| Endpoint type | How to pass |
|---------------|-------------|
| Task endpoints (`/api/task/*`) | `apiKey` field in JSON request body |
| Polling endpoints (`/api/task/poll/*`) | `apiKey` field in JSON request body |
| Storage endpoints (`/api/storage/*`) | `X-API-Key` request header |

Storage helper pattern (from `StorageBucketApp.jsx`):

```js
function clientFetch(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set('X-API-Key', apiKey);
  return fetch(path, { ...opts, headers });
}
```

---

## Task Submission Patterns

### Urgent / Blocking

```js
const res = await fetch('/api/task/submit_blocking', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    capability: 'shell.bash',
    urgent: true,
    payload: commandString,
    apiKey,
  }),
});
const data = await res.json();
// data.result contains the executor's output
```

### Non-Urgent with Polling

```js
// Submit
const sub = await fetch('/api/task/submit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ capability: 'shell.bash', urgent: false, payload, apiKey }),
});
const { id: { id, cap } } = await sub.json();

// Poll every N ms until done
const poll = await fetch(`/api/task/poll/${cap}/${id}`, {
  method: 'GET',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey }),
});
const state = await poll.json();
// state.status: 'pending' | 'running' | 'completed' | 'failed'
// state.result: executor output when completed
```

---

## Output Bucket Pattern (image generation, PDF analysis)

For tasks that return files (images, processed PDFs) rather than inline text:

```js
// 1. Create an output bucket
const bucketRes = await clientFetch('/api/storage/bucket/create', { method: 'POST' });
const { uid: outputBucketId } = await bucketRes.json();

// 2. Include in the task payload
const payload = {
  ...taskParams,
  output_bucket: outputBucketId,
};

// 3. After task completes, read files from data.result.images (or similar)
// Shape: [{ file_uid, bucket_uid, content_type, data_base64, filename }]

// 4. Clean up
await clientFetch(`/api/storage/bucket/${outputBucketId}`, { method: 'DELETE' });
```

Input bucket (for uploading files before a task):

```js
const bucketRes = await clientFetch(
  '/api/storage/bucket/create?rm_after_task=true', // auto-delete after task
  { method: 'POST' }
);
const { uid: inputBucketId } = await bucketRes.json();

const form = new FormData();
form.append('file', fileBlob, filename);
await clientFetch(`/api/storage/bucket/${inputBucketId}/upload`, {
  method: 'POST',
  body: form,
});
```

---

## Tab Visibility — Keep Apps Mounted

The "App" and "Dev" tabs use `display: none` / `display: contents` toggling, **not** conditional rendering. Both components stay mounted at all times. This is intentional — never switch back to a ternary/`&&` pattern or app state will be destroyed on tab switch.

```jsx
<div style={{ display: activeTab === 'app' ? 'contents' : 'none' }}>
  <selectedApp.app apiKey={apiKey} addDevEntry={addDevEntry} />
</div>
<div style={{ display: activeTab === 'dev' ? 'contents' : 'none' }}>
  <DevPanel entries={devLog} />
</div>
```

---

## Styling Conventions

All apps use CSS custom properties defined in the global theme. Never hardcode colors that have a variable equivalent.

| Variable | Use |
|----------|-----|
| `--text` | Body text |
| `--muted` | Secondary/dimmed text |
| `--border` | Borders (`#e5e7eb` in light mode) |
| `--glass` | Card / panel background |
| `--input-bg` | Input field background |
| `--code-bg` | Code/pre block background |
| `--primary` | Primary action (blue) |
| `--danger` | Destructive actions / errors (`#ef4444`) |
| `--accent` | Accent blue (`#3b82f6`) |

Common layout patterns:

```jsx
// Form group
<div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
  <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--muted)' }}>Label</label>
  <input style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text)' }} />
</div>

// Primary button
<button style={{ padding: '8px 16px', borderRadius: '6px', background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 500 }}>
  Run
</button>

// Response container
<div style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px', maxHeight: '300px', overflowY: 'auto' }}>
  ...
</div>

// Terminal output (bash/shell results)
<pre style={{ background: '#000', color: '#22c55e', padding: '12px', borderRadius: '6px', fontSize: '12px', fontFamily: 'monospace', overflowX: 'auto' }}>
  {output}
</pre>
```

---

## DevPanel — Method Badge Colors

When displaying API call history, method badges use these colors:

| Method | Color |
|--------|-------|
| GET | `#22c55e` |
| POST | `#3b82f6` |
| DELETE | `#ef4444` |
| PUT | `#f59e0b` |
| PATCH | `#a78bfa` |

---

## Common Gotchas

- **Polling with GET + body**: The `/api/task/poll` endpoint uses `GET` with a JSON body (`{ apiKey }`). Some fetch wrappers strip bodies from GET requests — always set `body` explicitly.
- **`data.id.id` vs `data.id`**: The submit response wraps the task ID: `{ id: { id: "...", cap: "..." } }` — destructure carefully.
- **`rm_after_task=true`**: Passing this query param on bucket creation tells the server to delete the bucket automatically after a task that references it completes. Use it for input-only buckets.
- **Image base64**: Strip the `data:image/...;base64,` prefix before sending to the API. The API returns images with `data_base64` (no prefix).
- **Max devLog entries**: `SandboxApps` caps the dev log at 100 entries (most recent first).
