const BASE = '/api'

export interface AuthResponse {
  token: string
  user_id: number
}

export interface User {
  id: number
  login: string
  google_id: string | null
  created_at: string
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export function register(login: string, password: string) {
  return request<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ login, password }),
  })
}

export function login(login: string, password: string) {
  return request<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login, password }),
  })
}

export function me(token: string) {
  return request<User>('/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
}
