import type { LlmCapabilityInfo } from '../types/ws'
import { apiRequest as request } from './http'

export type MovieCapability = LlmCapabilityInfo

export interface SceneView {
  index: number
  outline: string
  prompt: string | null
  workflow: string
  input_image_id: string | null
  imggen_job_id: string | null
  video_file_id: string | null
  last_frame_image_id: string | null
  status: string
  error: string | null
}

export interface MovieJobView {
  job_id: string
  status: string
  phase: string
  idea: string
  width: number
  height: number
  scene_count: number
  scene_length: number
  long_shot: boolean
  auto_approve: boolean
  expand_prompt: boolean
  director_model: string
  scene_model: string
  video_capability: string
  director_system: string
  scene_system: string
  initial_image_id: string | null
  outline: string[]
  scenes: SceneView[]
  current_scene: number
  active_log: string | null
  stage: string | null
  error: string | null
  movie_file_id: string | null
  created_at: string
  updated_at: string
}

export interface StartMovieJobRequest {
  idea: string
  width: number
  height: number
  scene_count: number
  scene_length: number
  long_shot?: boolean
  auto_approve?: boolean
  expand_prompt?: boolean
  director_model: string
  scene_model: string
  video_capability: string
  director_system?: string
  scene_system?: string
  initial_image_id?: string
}

export interface StartMovieJobResponse {
  job_id: string
  status: string
}

export interface CancelMovieJobResponse {
  job_id: string
  status: string
  message: string
}

export interface MovieCapabilitiesResponse {
  llm: MovieCapability[]
  video: MovieCapability[]
}

export function listMovieCapabilities(token: string): Promise<MovieCapabilitiesResponse> {
  return request('/api/movie/capabilities', token)
}

export function startMovieJob(
  token: string,
  payload: StartMovieJobRequest,
): Promise<StartMovieJobResponse> {
  return request('/api/movie/jobs', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listMovieJobs(token: string): Promise<MovieJobView[]> {
  return request('/api/movie/jobs', token)
}

export function getMovieJob(token: string, jobId: string): Promise<MovieJobView> {
  return request(`/api/movie/jobs/${encodeURIComponent(jobId)}`, token)
}

export function pollMovieJob(token: string, jobId: string): Promise<MovieJobView> {
  return request(`/api/movie/jobs/${encodeURIComponent(jobId)}/poll`, token, {
    method: 'POST',
  })
}

export function approveMovieJob(
  token: string,
  jobId: string,
  outline?: string[],
): Promise<MovieJobView> {
  return request(`/api/movie/jobs/${encodeURIComponent(jobId)}/approve`, token, {
    method: 'POST',
    body: JSON.stringify(outline ? { outline } : {}),
  })
}

export function stopMovieJob(token: string, jobId: string): Promise<MovieJobView> {
  return request(`/api/movie/jobs/${encodeURIComponent(jobId)}/stop`, token, {
    method: 'POST',
  })
}

export function resumeMovieJob(token: string, jobId: string): Promise<MovieJobView> {
  return request(`/api/movie/jobs/${encodeURIComponent(jobId)}/resume`, token, {
    method: 'POST',
  })
}

export function cancelMovieJob(
  token: string,
  jobId: string,
): Promise<CancelMovieJobResponse> {
  return request(`/api/movie/jobs/${encodeURIComponent(jobId)}/cancel`, token, {
    method: 'POST',
  })
}

export function deleteMovieJob(token: string, jobId: string): Promise<void> {
  return request(`/api/movie/jobs/${encodeURIComponent(jobId)}`, token, {
    method: 'DELETE',
  })
}
