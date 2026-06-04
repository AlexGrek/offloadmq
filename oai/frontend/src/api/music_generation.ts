import { apiRequest as request } from './http'

export interface MusicCapability {
  base: string
  tags: string[]
  raw: string
  online: boolean
  last_available_at: string
}

export interface AudioTrackInfo {
  track: number
  filename: string
  content_type: string
  size_bytes: number
}

export interface MusicJob {
  job_id: string
  status: string
  capability: string
  tags: string
  lyrics: string | null
  bpm: number | null
  duration: number
  seed: number | null
  language: string | null
  keyscale: string | null
  cfg_scale: number | null
  temperature: number | null
  result_seed: number | null
  audio_tracks: AudioTrackInfo[]
  stage: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
  created_at: string
  updated_at: string
}

export interface StartMusicJobRequest {
  capability: string
  tags: string
  lyrics?: string
  bpm?: number
  duration: number
  seed?: number
  language?: string
  keyscale?: string
  cfg_scale?: number
  temperature?: number
}

export interface StartMusicJobResponse {
  job_id: string
  status: string
}

export interface CancelMusicJobResponse {
  job_id: string
  status: string
  message: string
}

export function listMusicCapabilities(
  token: string,
): Promise<{ capabilities: MusicCapability[] }> {
  return request('/api/music-gen/capabilities', token)
}

export function startMusicJob(
  token: string,
  payload: StartMusicJobRequest,
): Promise<StartMusicJobResponse> {
  return request('/api/music-gen/jobs', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listMusicJobs(token: string): Promise<MusicJob[]> {
  return request('/api/music-gen/jobs', token)
}

export function getMusicJob(token: string, jobId: string): Promise<MusicJob> {
  return request(`/api/music-gen/jobs/${encodeURIComponent(jobId)}`, token)
}

export function pollMusicJob(token: string, jobId: string): Promise<MusicJob> {
  return request(`/api/music-gen/jobs/${encodeURIComponent(jobId)}/poll`, token, {
    method: 'POST',
  })
}

export function cancelMusicJob(token: string, jobId: string): Promise<CancelMusicJobResponse> {
  return request(`/api/music-gen/jobs/${encodeURIComponent(jobId)}/cancel`, token, {
    method: 'POST',
  })
}

export function retryMusicJob(token: string, jobId: string): Promise<StartMusicJobResponse> {
  return request(`/api/music-gen/jobs/${encodeURIComponent(jobId)}/retry`, token, {
    method: 'POST',
  })
}

export function deleteMusicJob(token: string, jobId: string): Promise<void> {
  return request(`/api/music-gen/jobs/${encodeURIComponent(jobId)}`, token, {
    method: 'DELETE',
  })
}

/** URL for a specific audio track — JWT travels in `?token=` (browsers omit Authorization on <audio>). */
export function musicAudioUrl(jobId: string, track: number, token: string | null | undefined): string {
  const base = `/api/music-gen/jobs/${encodeURIComponent(jobId)}/audio/${track}`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}
