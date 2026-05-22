const BASE = '/api/admin'

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

export async function amIAdmin(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/am_i_admin`, { headers: authHeaders(token) })
    if (!res.ok) return false
    const data = await res.json() as { is_admin: boolean }
    return data.is_admin
  } catch {
    return false
  }
}

export interface AdminSettings {
  offloadmq_url: string
  client_api_token: string | null
  management_api_token: string | null
}

async function adminRequest<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: authHeaders(token),
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function getSettings(token: string) {
  return adminRequest<AdminSettings>('/settings', token)
}

export function updateSettings(token: string, settings: AdminSettings) {
  return adminRequest<AdminSettings>('/settings', token, {
    method: 'POST',
    body: JSON.stringify(settings),
  })
}

export interface TokenCheckResult {
  ok: boolean
  error: string | null
}

export interface CheckConnectionResponse {
  client_token: TokenCheckResult | null
  management_token: TokenCheckResult | null
}

export function checkConnection(token: string, settings: AdminSettings) {
  return adminRequest<CheckConnectionResponse>('/check_connection', token, {
    method: 'POST',
    body: JSON.stringify(settings),
  })
}
