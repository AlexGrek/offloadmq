export interface ChatSummary {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export interface ChatMessageRecord {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  status: 'complete' | 'failed'
  model: string | null
  created_at: string
}

async function request<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export function listChats(token: string): Promise<ChatSummary[]> {
  return request('/api/chats', token)
}

export function createChat(token: string): Promise<ChatSummary> {
  return request('/api/chats', token, { method: 'POST' })
}

export function deleteChat(token: string, chatId: string): Promise<void> {
  return request(`/api/chats/${chatId}`, token, { method: 'DELETE' })
}

export function getChatMessages(token: string, chatId: string): Promise<ChatMessageRecord[]> {
  return request(`/api/chats/${chatId}/messages`, token)
}
