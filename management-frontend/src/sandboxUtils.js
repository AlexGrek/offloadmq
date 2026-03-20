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
      const blob = await r.blob();
      const blobUrl = URL.createObjectURL(blob);
      track?.(blobUrl);
      return { ...img, blobUrl };
    } catch { return img; }
  }));
}
