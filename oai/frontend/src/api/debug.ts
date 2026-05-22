export interface DebugExtraJob {
  cap: string
  id: string
  label?: string
  source?: string
  key?: string
}

export async function fetchOffloadDebugYaml(
  token: string,
  extra: DebugExtraJob[],
): Promise<string> {
  const res = await fetch('/api/debug/offload_status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ extra }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `HTTP ${res.status}`)
  }
  return res.text()
}
