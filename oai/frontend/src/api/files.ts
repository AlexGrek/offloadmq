import { apiRequest as request } from './http'

export interface UserFile {
  id: string
  /** `"image"` (image_files) or `"audio"` (synthesized tts_jobs). */
  kind: 'image' | 'audio'
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
  is_video: boolean
  is_audio: boolean
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

export interface FileProperties {
  filename: string
  /** `"image"` or `"audio"`. */
  source: string
  parameters: Record<string, unknown>
  created_at: string
}

/** Look up the generation parameters recorded for a file by filename.
 *  Returns `null` when no parameters row exists (uploads, or pre-feature files). */
export async function getFileProperties(
  token: string,
  filename: string,
): Promise<FileProperties | null> {
  const path = `/api/files/properties?filename=${encodeURIComponent(filename)}`
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as FileProperties
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
