export async function fetchOffloadPoll(
  token: string,
  cap: string,
  id: string,
): Promise<unknown> {
  const res = await fetch('/api/debug/offload_poll', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ cap, id }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json()
}
