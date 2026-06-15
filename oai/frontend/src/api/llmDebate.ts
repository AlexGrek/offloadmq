import type { LlmCapabilityInfo } from '../types/ws'
import { apiRequest as request } from './http'

export type LlmDebateCapability = LlmCapabilityInfo

export interface DebateMessage {
  side: string
  content: string
}

export interface LlmDebateJob {
  job_id: string
  status: string
  model_a: string
  model_b: string
  system_a: string
  system_b: string
  initial_prompt: string
  referee_enabled: boolean
  model_ref: string | null
  system_ref: string | null
  command_ref: string | null
  referee_turns: number
  messages: DebateMessage[]
  phase: string
  current_turn: string | null
  active_log: string | null
  stage: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface StartLlmDebateJobRequest {
  model_a: string
  model_b: string
  system_a?: string
  system_b?: string
  initial_prompt: string
  referee_enabled?: boolean
  model_ref?: string
  system_ref?: string
  command_ref?: string
  referee_turns?: number
}

export interface StartLlmDebateJobResponse {
  job_id: string
  status: string
}

export interface CancelLlmDebateJobResponse {
  job_id: string
  status: string
  message: string
}

export function listLlmDebateCapabilities(
  token: string,
): Promise<{ capabilities: LlmDebateCapability[] }> {
  return request('/api/llm-debate/capabilities', token)
}

export function startLlmDebateJob(
  token: string,
  payload: StartLlmDebateJobRequest,
): Promise<StartLlmDebateJobResponse> {
  return request('/api/llm-debate/jobs', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listLlmDebateJobs(token: string): Promise<LlmDebateJob[]> {
  return request('/api/llm-debate/jobs', token)
}

export function getLlmDebateJob(token: string, jobId: string): Promise<LlmDebateJob> {
  return request(`/api/llm-debate/jobs/${encodeURIComponent(jobId)}`, token)
}

export function pollLlmDebateJob(token: string, jobId: string): Promise<LlmDebateJob> {
  return request(`/api/llm-debate/jobs/${encodeURIComponent(jobId)}/poll`, token, {
    method: 'POST',
  })
}

export function cancelLlmDebateJob(
  token: string,
  jobId: string,
): Promise<CancelLlmDebateJobResponse> {
  return request(`/api/llm-debate/jobs/${encodeURIComponent(jobId)}/cancel`, token, {
    method: 'POST',
  })
}

export function retryLlmDebateJob(
  token: string,
  jobId: string,
): Promise<StartLlmDebateJobResponse> {
  return request(`/api/llm-debate/jobs/${encodeURIComponent(jobId)}/retry`, token, {
    method: 'POST',
  })
}

export function deleteLlmDebateJob(token: string, jobId: string): Promise<void> {
  return request(`/api/llm-debate/jobs/${encodeURIComponent(jobId)}`, token, {
    method: 'DELETE',
  })
}
