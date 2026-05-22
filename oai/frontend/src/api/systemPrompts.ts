export interface SystemPromptItem {
  id: string
  content: string
  starred: boolean
  last_used_at: string
}

export interface SystemPromptLibrary {
  recent: SystemPromptItem[]
  starred: SystemPromptItem[]
}

function authHeaders(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

async function request<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...options, headers: { ...authHeaders(token), ...options?.headers } })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export function listSystemPromptLibrary(token: string): Promise<SystemPromptLibrary> {
  return request('/api/system-prompts', token)
}

export function recordSystemPromptUse(token: string, content: string): Promise<SystemPromptItem> {
  return request('/api/system-prompts/use', token, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

export function setSystemPromptStarred(
  token: string,
  id: string,
  starred: boolean,
): Promise<SystemPromptItem> {
  return request(`/api/system-prompts/${id}/star`, token, {
    method: 'PATCH',
    body: JSON.stringify({ starred }),
  })
}

export function deleteSystemPrompt(token: string, id: string): Promise<void> {
  return request(`/api/system-prompts/${id}`, token, { method: 'DELETE' })
}
