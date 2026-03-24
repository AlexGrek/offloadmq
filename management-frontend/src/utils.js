// ----- Formatting helpers -----
export const fmtDate = (iso) => {
    if (!iso) return "—";
    try {
        const d = new Date(iso);
        return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
    } catch {
        return iso;
    }
};

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", headers.get("Content-Type") || "application/json");
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ""}`);
  }
  // try to parse json; if empty, return null
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return null;
}

export const TOKEN_KEY = "offload-mq-mgmt-token";

/** Strip the [attr1;attr2] suffix from a capability string.
 *  "llm.qwen2.5vl:7b[vision;size:5Gb]" → "llm.qwen2.5vl:7b"
 */
export function stripCapabilityAttrs(cap) {
  const idx = cap.indexOf('[');
  return idx === -1 ? cap : cap.slice(0, idx);
}

/** Parse the bracketed attributes from a capability string.
 *  "llm.qwen2.5vl:7b[vision;size:5Gb;tools]" → ["vision", "size:5Gb", "tools"]
 */
export function parseCapabilityAttrs(cap) {
  const start = cap.indexOf('[');
  const end = cap.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  return cap.slice(start + 1, end).split(';').filter(Boolean);
}

/** Fetch the extended online capability list from the management API. */
export async function fetchOnlineCapabilities() {
  return apiFetch('/management/capabilities/list/online_ext');
}

/** Generate a deterministic color from a string ID using HSL.
 *  Returns {hue, saturation, lightness, hex} for consistent coloring.
 */
export function getColorFromId(id) {
  if (!id) return { hue: 0, saturation: 60, lightness: 50, hex: '#808080' };

  // Simple hash function
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Map hash to hue (0-360)
  const hue = Math.abs(hash) % 360;
  const saturation = 65; // Vibrant colors
  const lightness = 50;

  // Convert HSL to hex for convenience
  const hex = hslToHex(hue, saturation, lightness);

  return { hue, saturation, lightness, hex };
}

/** Convert HSL to hex color. */
function hslToHex(h, s, l) {
  l /= 100;
  const a = (s / 100) * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Pull assistant-visible text from common LLM / executor JSON shapes (sandbox apps). */
export function extractSandboxModelText(output) {
  if (output == null) return null;
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      return extractSandboxModelText(parsed);
    } catch {
      return output;
    }
  }
  if (typeof output === 'object' && !Array.isArray(output)) {
    if (output.message?.content != null && typeof output.message.content === 'string') {
      return output.message.content;
    }
    const c0 = output.choices?.[0]?.message?.content;
    if (typeof c0 === 'string') return c0;
    if (typeof output.stdout === 'string') return output.stdout;
  }
  return null;
}