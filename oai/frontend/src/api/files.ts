export interface UserFile {
  id: string
  direction: string
  source: string
  filename: string
  content_type: string
  width: number
  height: number
  size_bytes: number
  sha256: string
  job_id: string | null
  created_at: string
  url: string
  thumbnail_url: string
  is_image: boolean
}

export interface StorageSummary {
  used_bytes: number
  file_count: number
  input_bytes: number
  output_bytes: number
}

export interface FileBrowserResponse {
  files: UserFile[]
  summary: StorageSummary
}

async function request<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export type CleanupFilesScope = 'uploads' | 'generated' | 'all'

export interface CleanupFilesRequest {
  scope: CleanupFilesScope
  keep_starred?: boolean
}

export interface CleanupFilesResponse {
  deleted_count: number
  skipped_starred: number
}

/** Lists all of the current user's files plus a storage summary. */
export function listFiles(token: string): Promise<FileBrowserResponse> {
  return request('/api/files', token)
}

/** Bulk-delete files by scope; optionally skip starred images. */
export function cleanupFiles(
  token: string,
  body: CleanupFilesRequest,
): Promise<CleanupFilesResponse> {
  return request('/api/files/cleanup', token, {
    method: 'POST',
    body: JSON.stringify({
      scope: body.scope,
      keep_starred: body.keep_starred ?? true,
    }),
  })
}
