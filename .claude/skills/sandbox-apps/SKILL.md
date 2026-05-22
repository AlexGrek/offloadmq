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
| `CustomApp.jsx` | Generic capability runner: auto-detects fields from extended attrs, submits + polls |
| `TtsApp.jsx` | Text-to-speech: full UI for synthesizing audio via `tts.*` capability |
| `SpeechWidget.jsx` | **Reusable** compact TTS widget (voice picker + play button) — embed in any app to read text aloud |

---

## App Registry

Apps are registered in the `apps` array inside `SandboxApps.jsx`. To add a new app:

1. Create `management-frontend/src/components/MyApp.jsx`
2. Import it as a lazy component in `SandboxApps.jsx`:
   ```js
   const MyApp = React.lazy(() => import('./MyApp'))
   ```
3. Import a [lucide-react](https://lucide.dev/icons/) icon for the tile
4. Add an entry to the `apps` array:
   ```js
   const apps = [
     // ...existing entries...
     { id: 'myapp', name: 'My App', logo: SomeLucideIcon, app: MyApp },
   ];
   ```

### Full checklist for a new app

1. **Create the component file** — export a default functional component that accepts `{ apiKey, addDevEntry }` props
2. **Use shared styles** — `import { sandboxStyles as ss } from '../sandboxStyles'` for form layout, inputs, buttons, response containers
3. **Use shared hooks** (see below) — `useCapabilities` for capability discovery, `useTaskPolling` for async task polling
4. **Use `TerminalOutput`** — `import TerminalOutput from './TerminalOutput'` for rendering task output in a terminal-style box
5. **Log all API calls** via `addDevEntry` so they appear in the Dev tab
6. **Register in `SandboxApps.jsx`** — lazy import + `apps` array entry (see above)

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

## Shared Hooks

### `useCapabilities(prefix, { setModel?, setError? })`

**File:** `management-frontend/src/hooks/useCapabilities.js`

Fetches extended online capabilities from the management API and filters by prefix. Returns `[capabilities, setCapabilities]`.

```js
import { useCapabilities } from '../hooks/useCapabilities';

// Filter capabilities starting with "shell"
const [capabilities] = useCapabilities('shell', { setError });

// Filter LLM capabilities and auto-select first model
const [capabilities] = useCapabilities('llm.', { setModel, setError });
```

- Calls `fetchOnlineCapabilities()` (management API `/management/capabilities/list/online_ext`)
- Returns the **full extended strings** (with `[...]` attributes) — use `stripCapabilityAttrs()` to get base capability
- If `setModel` is provided, auto-selects the first match with the prefix stripped

### `useTaskPolling({ currentTask, apiKey, addDevEntry, onResult, onError, onLog?, onStatus?, interval? })`

**File:** `management-frontend/src/hooks/useTaskPolling.js`

Sets up interval-based polling for an async (non-urgent) task. Starts polling when `currentTask` is non-null, stops when null.

```js
import { useTaskPolling } from '../hooks/useTaskPolling';

useTaskPolling({
  currentTask,              // { id: string, capability: string } | null
  apiKey,
  addDevEntry,
  onResult: (data) => { },  // data.output contains the result
  onError: (msg) => { },    // error message string
  onLog: setLog,             // data.log text (live progress)
  onStatus: (s) => { },     // data.status on each poll
  interval: 2000,            // polling interval ms (default 2000)
});
```

- Polls `POST /api/task/poll/{capability}/{id}` with `{ apiKey }` body
- Automatically logs each poll to DevPanel via `addDevEntry`
- Calls `onResult` when `data.output` is present (task completed)
- Calls `onError` when `data.error` is present
- Otherwise calls `onStatus` with `data.status` ("pending", "running", etc.)

### `TerminalOutput` component

**File:** `management-frontend/src/components/TerminalOutput.jsx`

Renders output in a dark terminal-style box. Handles JSON with `stdout`/`stderr`, plain JSON, and raw text.

```jsx
import TerminalOutput from './TerminalOutput';

<TerminalOutput response={response} style={{ maxHeight: '24em', overflowY: 'auto' }} />
<TerminalOutput response={{ stdout: logText }} />  {/* force stdout rendering */}
```

### `SpeechWidget` component

**File:** `management-frontend/src/components/SpeechWidget.jsx`

Compact "read aloud" widget: voice dropdown + 24px play button. On click → spins a loader while a blocking TTS task runs → auto-plays the returned audio via `new Audio(blobUrl)`. During playback the button becomes a red Stop button.

```jsx
import SpeechWidget from './SpeechWidget';

<SpeechWidget text={assistantResponse} apiKey={apiKey} addDevEntry={addDevEntry} />
```

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| `text` | `string` | Text to synthesize. Button is disabled if empty. |
| `apiKey` | `string` | Client API key (required). |
| `addDevEntry` | `(entry) => void` | Optional — logs the TTS call to the Dev tab. |
| `disabled` | `boolean` | Optional — force-disable (e.g. while a parent task is running). Default `false`. |
| `compact` | `boolean` | Optional — reserved (currently only affects gap). Default `true`. |

**Behavior:**

- Auto-discovers `tts.*` capabilities via `useCapabilities('tts.')`, auto-picks first capability and first voice.
- Persists the last chosen voice + capability in `localStorage` under keys `offroadmq-tts-voice` and `offroadmq-tts-capability` (shared across all embeds on the page).
- Derives `model` from the capability string (`tts.kokoro` → `kokoro`) and submits `POST /api/task/submit_blocking` with `{ urgent: true, payload: { model, voice, input: text } }`.
- Expects `data.result.audio_data_base64` + `data.result.content_type` on success (standard `tts.*` response shape).
- Cleans up blob URLs on unmount, on playback end, and before each new request.
- If no `tts.*` capability is online, the dropdown shows `no tts` and the button is disabled.

**Where to embed:** Next to any assistant-visible text. Common patterns:

- **Bubble / message** (LlmChatApp, LlmDebateApp): in a right-aligned action row inside or beside the bubble.
- **Result panel header** (PdfAnalyzerApp, ImageAnalyzerApp): use a `labelRow` flex row with the "Result" label on the left and `<SpeechWidget>` on the right.
- **Simple response container** (LlmApp, TranslatorApp): a top-right-aligned div above the markdown body.
- **Multi-slot results** (LlmCompareApp): inside each result header, alongside the Copy button — renders only when `r.content` is present.
- **Streaming output** (StreamingLLMApp): guard with `response && !isLoading` so the widget only appears after the full response arrives (don't offer speech of partial streams). Extract text with `extractSandboxModelText(response)` when the output is an object.

For object-shaped responses, unwrap the text first: `extractSandboxModelText(response)` from `utils.js`.

## Capability Utilities

**File:** `management-frontend/src/utils.js`

```js
import { stripCapabilityAttrs, parseCapabilityAttrs, fetchOnlineCapabilities } from '../utils';

stripCapabilityAttrs('llm.qwen:7b[vision;tools]')  // → 'llm.qwen:7b'
parseCapabilityAttrs('llm.qwen:7b[vision;tools]')  // → ['vision', 'tools']
fetchOnlineCapabilities()                            // → Promise<string[]> (extended caps)
```

- `fetchOnlineCapabilities()` hits `/management/capabilities/list/online_ext` (requires mgmt token)
- Extended attributes use bracket notation: `base.cap[attr1;attr2;key:value]`
- Clients always submit tasks with **base capability only** (no brackets) — use `stripCapabilityAttrs()`

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

### Non-Urgent with Polling (manual)

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
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey }),
});
const state = await poll.json();
// state.status: 'pending' | 'running' | 'completed' | 'failed'
// state.result: executor output when completed
```

### Non-Urgent with `useTaskPolling` hook (preferred)

This is the standard pattern for async apps. The hook manages the polling interval, DevPanel logging, and cleanup automatically.

```jsx
const [currentTask, setCurrentTask] = useState(null);
const [response, setResponse] = useState(null);
const [log, setLog] = useState('');
const [error, setError] = useState(null);
const [isLoading, setIsLoading] = useState(false);
const [pollingStatus, setPollingStatus] = useState('');

useTaskPolling({
  currentTask, apiKey, addDevEntry,
  onResult: (data) => {
    setIsLoading(false); setResponse(data.output); setPollingStatus(''); setCurrentTask(null);
  },
  onError: (msg) => {
    setIsLoading(false); setError(msg); setPollingStatus(''); setCurrentTask(null);
  },
  onLog: setLog,
  onStatus: (status) => setPollingStatus('Status: ' + status),
});

const handleSubmit = async () => {
  setIsLoading(true); setResponse(null); setError(null); setLog('');
  const body = { capability: 'my.cap', urgent: false, payload: myPayload, apiKey };
  const res = await fetch('/api/task/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  addDevEntry?.({ label: 'Submit', method: 'POST', url: '/api/task/submit', request: body, response: data });
  if (data.id?.id && data.id?.cap) {
    setCurrentTask({ id: data.id.id, capability: data.id.cap });  // triggers polling
  }
};
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

### Vision LLM task submit (Image Analyzer contract)

When submitting an `llm.*` task after uploading images to a bucket, mirror **`ImageAnalyzerApp.jsx`**:

- Top-level JSON: `fetchFiles: []`, `artifacts: []`, **`file_bucket`: [bucketUid]**, `capability`, `urgent`, `restartable`, `apiKey`.
- **`payload`**: `{ stream: false, messages: [...] }` only — **do not** put a top-level `model` key inside `payload`. The offload agent derives `model` from the task `capability` when calling Ollama and attaches images from downloaded bucket files.

Documented for external integrators in **`docs/integration-guide-llm.md`** (section *Recommended: `llm.*` task body with `file_bucket` (vision)*).

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
