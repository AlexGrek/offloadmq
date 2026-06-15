import type { LlmCapabilityInfo } from '../types/ws'
import { apiRequest as request } from './http'

export type LlmCompareCapability = LlmCapabilityInfo

export interface CompareSlot {
  model: string
  status: string
  content: string | null
  log: string | null
  error: string | null
}

export interface LlmCompareJob {
  job_id: string
  status: string
  system_prompt: string
  user_prompt: string
  slots: CompareSlot[]
  error: string | null
  created_at: string
  updated_at: string
}

export interface StartLlmCompareJobRequest {
  models: string[]
  system_prompt?: string
  user_prompt: string
}

export interface StartLlmCompareJobResponse {
  job_id: string
  status: string
}

export interface CancelLlmCompareJobResponse {
  job_id: string
  status: string
  message: string
}

export function listLlmCompareCapabilities(
  token: string,
): Promise<{ capabilities: LlmCompareCapability[] }> {
  return request('/api/llm-compare/capabilities', token)
}

export function startLlmCompareJob(
  token: string,
  payload: StartLlmCompareJobRequest,
): Promise<StartLlmCompareJobResponse> {
  return request('/api/llm-compare/jobs', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listLlmCompareJobs(token: string): Promise<LlmCompareJob[]> {
  return request('/api/llm-compare/jobs', token)
}

export function getLlmCompareJob(token: string, jobId: string): Promise<LlmCompareJob> {
  return request(`/api/llm-compare/jobs/${encodeURIComponent(jobId)}`, token)
}

export function pollLlmCompareJob(token: string, jobId: string): Promise<LlmCompareJob> {
  return request(`/api/llm-compare/jobs/${encodeURIComponent(jobId)}/poll`, token, {
    method: 'POST',
  })
}

export function cancelLlmCompareJob(
  token: string,
  jobId: string,
): Promise<CancelLlmCompareJobResponse> {
  return request(`/api/llm-compare/jobs/${encodeURIComponent(jobId)}/cancel`, token, {
    method: 'POST',
  })
}

export function retryLlmCompareJob(
  token: string,
  jobId: string,
): Promise<StartLlmCompareJobResponse> {
  return request(`/api/llm-compare/jobs/${encodeURIComponent(jobId)}/retry`, token, {
    method: 'POST',
  })
}

export function deleteLlmCompareJob(token: string, jobId: string): Promise<void> {
  return request(`/api/llm-compare/jobs/${encodeURIComponent(jobId)}`, token, {
    method: 'DELETE',
  })
}
