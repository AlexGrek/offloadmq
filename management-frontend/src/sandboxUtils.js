// Shared utility functions for sandbox apps.

/**
 * HTTP fetch wrapper that injects the X-API-Key header and logs to DevPanel.
 * Throws on non-2xx responses.
 */
export async function clientFetch(path, apiKey, options = {}, addDevEntry = null) {
  const { _label, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});
  headers.set('X-API-Key', apiKey);
  let reqBody = null;
  if (fetchOptions.body && typeof fetchOptions.body === 'string') {
    try { reqBody = JSON.parse(fetchOptions.body); } catch { reqBody = fetchOptions.body; }
  }
  const res = await fetch(path, { ...fetchOptions, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    addDevEntry?.({ label: _label, method: fetchOptions.method || 'GET', url: path, request: reqBody, response: { error: `${res.status} ${res.statusText}${text ? ` – ${text}` : ''}` } });
    throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  let respBody = null;
  if (ct.includes('application/json')) respBody = await res.json();
  addDevEntry?.({ label: _label, method: fetchOptions.method || 'GET', url: path, request: reqBody, response: respBody });
  return respBody;
}

/** Format a byte count into a human-readable string. */
export function fmtBytes(n) {
  if (n == null) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log2(n) / 10), units.length - 1);
  const val = n / Math.pow(1024, i);
  return `${val % 1 === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

/** Map a task status string (+ optional stage) to a human-readable label. */
export function statusLabel(status, stage) {
  const base = {
    pending: 'Pending...',
    queued: 'Queued, waiting for agent...',
    assigned: 'Assigned to agent...',
    starting: 'Agent starting task...',
    running: 'Running...',
    failedRetryPending: 'Failed, retrying...',
    failedRetryDelayed: 'Failed, waiting to retry...',
  }[typeof status === 'string' ? status : ''] ?? `Status: ${JSON.stringify(status)}`;
  return stage ? `${base} [${stage}]` : base;
}

/** Cancel a running task. Logs to DevPanel. Fails silently. */
export async function cancelTask(cap, id, apiKey, addDevEntry) {
  const url = `/api/task/cancel/${encodeURIComponent(cap)}/${encodeURIComponent(id)}`;
  const body = { apiKey };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    addDevEntry?.({ label: 'Cancel task', method: 'POST', url, request: body, response: data });
    return data;
  } catch (err) {
    console.warn('cancelTask failed:', err);
  }
}

/** Delete a storage bucket by UID. Fails silently. */
export async function deleteBucket(uid, apiKey) {
  if (!uid) return;
  try {
    await fetch(`/api/storage/bucket/${uid}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': apiKey },
    });
  } catch (e) {
    console.warn('Failed to delete bucket', uid, e);
  }
}

/** Strip MIME parameters (e.g. charset) and lower-case. */
function stripMimeParams(ct) {
  if (!ct || typeof ct !== 'string') return '';
  return ct.split(';')[0].trim().toLowerCase();
}

/**
 * Bucket file GET uses application/octet-stream; use task metadata so Blob
 * type is a real image/* (avoids browsers saving downloads as .bin).
 */
function pickImageMime(responseContentType, metaContentType) {
  const fromHeader = stripMimeParams(responseContentType);
  if (fromHeader && fromHeader !== 'application/octet-stream') return fromHeader;
  const fromMeta = stripMimeParams(metaContentType);
  if (fromMeta && fromMeta !== 'application/octet-stream') return fromMeta;
  return 'image/png';
}

/** Parse filename from Content-Disposition (attachment; filename="..."). */
function parseAttachmentFilename(cd) {
  if (!cd || typeof cd !== 'string') return null;
  const star = cd.match(/filename\*=(?:UTF-8''|)([^;\s]+)/i);
  if (star) {
    const raw = star[1].trim().replace(/^"|"$/g, '');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const quoted = cd.match(/filename="((?:\\.|[^"\\])*)"/i);
  if (quoted) return quoted[1].replace(/\\"/g, '"');
  const plain = cd.match(/filename=([^;\s]+)/i);
  if (plain) return plain[1].trim().replace(/^"|"$/g, '');
  return null;
}

function hasImageExtension(name) {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name || '');
}

function extForMime(mime) {
  const m = stripMimeParams(mime);
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/bmp') return '.bmp';
  if (m === 'image/png') return '.png';
  return '.png';
}

/** Ensure <a download> has a sensible name with an image extension. */
function ensureDownloadFilename(name, mime) {
  let n = (name || '').trim();
  if (!n) n = 'generated';
  if (hasImageExtension(n)) return n;
  return n + extForMime(mime);
}

/**
 * Fetch images from storage bucket and convert to blob URLs.
 * Returns the images array with `blobUrl` added to each entry.
 *
 * @param {Array} images - Array of image objects with bucket_uid/file_uid
 * @param {string} apiKey - Client API key
 * @param {function} [track] - Optional callback to register each blob URL for later revocation
 */
export async function fetchImageBlobs(images, apiKey, track) {
  if (!images) return images;
  return Promise.all(images.map(async (img) => {
    if (!img.file_uid) return img;
    try {
      const r = await fetch(`/api/storage/bucket/${img.bucket_uid}/file/${img.file_uid}`, {
        headers: { 'X-API-Key': apiKey },
      });
      const mime = pickImageMime(r.headers.get('content-type'), img.content_type);
      const buf = await r.arrayBuffer();
      const blob = new Blob([buf], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      track?.(blobUrl);
      const fromCd = parseAttachmentFilename(r.headers.get('content-disposition'));
      const filename = ensureDownloadFilename(fromCd || img.filename, mime);
      return { ...img, blobUrl, filename };
    } catch { return img; }
  }));
}
