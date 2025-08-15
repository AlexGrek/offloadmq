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