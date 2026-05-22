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

/** Lists all of the current user's files plus a storage summary (read-only). */
export function listFiles(token: string): Promise<FileBrowserResponse> {
  return request('/api/files', token)
}
