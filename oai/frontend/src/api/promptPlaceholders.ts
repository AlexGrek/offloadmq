import { apiRequest as request } from './http'

/**
 * User-scoped custom placeholder definitions, e.g. `{.cinematic}` -> one of a few
 * variant phrases. Resolved (including recursively) client-side — see
 * `lib/promptPlaceholders.ts`; this client only handles CRUD storage.
 */
export interface PromptPlaceholder {
  id: string
  name: string
  variants: string[]
}

export function listPromptPlaceholders(token: string): Promise<PromptPlaceholder[]> {
  return request('/api/prompt-placeholders', token)
}

export function createPromptPlaceholder(
  token: string,
  name: string,
  variants: string[],
): Promise<PromptPlaceholder> {
  return request('/api/prompt-placeholders', token, {
    method: 'POST',
    body: JSON.stringify({ name, variants }),
  })
}

export function updatePromptPlaceholder(
  token: string,
  id: string,
  name: string,
  variants: string[],
): Promise<PromptPlaceholder> {
  return request(`/api/prompt-placeholders/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ name, variants }),
  })
}

export function deletePromptPlaceholder(token: string, id: string): Promise<void> {
  return request(`/api/prompt-placeholders/${id}`, token, { method: 'DELETE' })
}
