/**
 * Shared authenticated fetch helper for the OAI API clients.
 *
 * Every per-feature client (`tts.ts`, `images.ts`, `chats.ts`, …) used to carry
 * its own near-identical `request<T>`. They now alias this one:
 *
 *   import { apiRequest as request } from './http'
 *
 * Behavior: attaches `Authorization: Bearer <token>`, sets a JSON content-type
 * unless the body is `FormData` (so the browser can set the multipart boundary),
 * unwraps `{ error }` bodies into thrown `Error`s, and returns `undefined` for
 * `204 No Content`.
 *
 * The public auth client (`auth.ts`) is intentionally separate — it has no token
 * and prefixes a base URL.
 */
export async function apiRequest<T>(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<T> {
  const isFormData = options?.body instanceof FormData
  const headers = new Headers(options?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (!isFormData) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) {
    return undefined as T
  }
  return res.json() as Promise<T>
}
