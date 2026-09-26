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

export type PromptKind = 'recent' | 'starred'

/** A saved prompt as the paged library drawer sees it. */
export interface PromptEntry {
  id: string
  kind: PromptKind
  content: string
  created_at: string
  last_used_at: string
  updated_at: string
  /** Set when the entry has an image preview (the latest image generated from
   *  this text); used as the preview URL's cache-buster. */
  preview_version: string | null
}

export interface PromptPage {
  items: PromptEntry[]
  /** Opaque keyset cursor for the next page; null on the last page. */
  next_cursor: string | null
}

export function listPrompts(token: string, bucket: string): Promise<PromptLibrary> {
  return request(`/api/prompts/${encodeURIComponent(bucket)}`, token)
}

/**
 * One page of a bucket's recent or starred list, newest first. `q` filters
 * server-side (case-insensitive substring), so search covers the whole library,
 * not just the pages already loaded.
 */
export function listPromptEntries(
  token: string,
  bucket: string,
  opts: { kind: PromptKind; q?: string; cursor?: string | null; limit?: number; signal?: AbortSignal },
): Promise<PromptPage> {
  const params = new URLSearchParams({ kind: opts.kind })
  if (opts.q?.trim()) params.set('q', opts.q.trim())
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.limit) params.set('limit', String(opts.limit))
  return request(`/api/prompts/${encodeURIComponent(bucket)}/entries?${params}`, token, {
    signal: opts.signal,
  })
}

/** `<img src>` URL for an entry's preview thumbnail — JWT in the query, since
 *  browsers can't send `Authorization` for images. */
export function promptPreviewUrl(id: string, token: string, version: string): string {
  return `/api/prompt-entries/${encodeURIComponent(id)}/preview?token=${encodeURIComponent(token)}&v=${encodeURIComponent(version)}`
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

/** Edit the content of a saved favorite. Returns the full updated entry. */
export function updatePrompt(token: string, id: string, content: string): Promise<PromptEntry> {
  return request(`/api/prompt-entries/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  })
}

export function deletePrompt(token: string, id: string): Promise<void> {
  return request(`/api/prompt-entries/${id}`, token, { method: 'DELETE' })
}
