export interface CancelOffloadTaskResponse {
  cap: string
  id: string
  status: string
  message: string
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

export async function cancelOffloadTask(
  token: string,
  cap: string,
  id: string,
): Promise<CancelOffloadTaskResponse> {
  const capEnc = encodeURIComponent(cap)
  const idEnc = encodeURIComponent(id)
  const res = await fetch(`/api/tasks/cancel/${capEnc}/${idEnc}`, {
    method: 'POST',
    headers: authHeaders(token),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<CancelOffloadTaskResponse>
}
