export interface RunnerSummary {
  uid: string
  uid_short: string
  display_name: string | null
  tier: number
  capacity: number
  last_contact: string | null
  capabilities: string[]
}

export interface ListRunnersResponse {
  runners: RunnerSummary[]
}

async function request<T>(path: string, token: string): Promise<T> {
  const res = await fetch(path, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function listOnlineRunners(token: string): Promise<ListRunnersResponse> {
  return request('/api/runners/online', token)
}
