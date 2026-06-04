import { apiRequest as request } from './http'

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
