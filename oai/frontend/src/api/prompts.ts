import { apiRequest as request } from './http'

/**
 * Generic prompt storage shared across apps. Prompts live in named buckets
 * (e.g. `llm-system`, `describe-image-user`); each bucket has a `recent` list
 * (auto-managed server-side, last 10 unique) and a `starred` list (favorites the
 * user adds, which are editable and deletable).
 */
export interface PromptItem {
  id: string
  content: string
}

export interface PromptLibrary {
  recent: PromptItem[]
  starred: PromptItem[]
}

export function listPrompts(token: string, bucket: string): Promise<PromptLibrary> {
  return request(`/api/prompts/${encodeURIComponent(bucket)}`, token)
}

/**
 * Record a use of `content` in a bucket's recent list. Callers decide exactly
 * when a use counts — e.g. once per user submission, not once per generated
 * job — so batches of jobs sharing one prompt template don't flood recents.
 */
export function recordRecentPrompt(token: string, bucket: string, content: string): Promise<PromptItem> {
  return request(`/api/prompts/${encodeURIComponent(bucket)}/recent`, token, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

/** Add the given content to a bucket's favorites. */
export function starPrompt(token: string, bucket: string, content: string): Promise<PromptItem> {
  return request(`/api/prompts/${encodeURIComponent(bucket)}/star`, token, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

/** Edit the content of a saved favorite. */
export function updatePrompt(token: string, id: string, content: string): Promise<PromptItem> {
  return request(`/api/prompt-entries/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  })
}

export function deletePrompt(token: string, id: string): Promise<void> {
  return request(`/api/prompt-entries/${id}`, token, { method: 'DELETE' })
}
