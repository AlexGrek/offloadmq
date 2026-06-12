import type { LlmCapabilityInfo } from '../types/ws'
import { apiRequest as request } from './http'

/**
 * Prompt generator: rewrites the user's rough idea into a polished generation
 * prompt via an LLM. The query template (must contain `{}`) is stored per
 * generation mode in the prompt library bucket `imggen-promptgen-{mode}`.
 * Cancel runs through the generic `/api/tasks/cancel/{cap}/{id}`.
 */
export type PromptGenCapability = LlmCapabilityInfo

export interface PromptGenTaskId {
  cap: string
  id: string
}

export interface PromptGenPollResponse {
  status: string
  stage?: string
  /** Generated prompt — present once status is `completed`. */
  text?: string
  /** Failure reason — present on `failed` / `canceled`. */
  error?: string
}

export function listPromptGenCapabilities(
  token: string,
): Promise<{ capabilities: PromptGenCapability[] }> {
  return request('/api/promptgen/capabilities', token)
}

export function generatePrompt(
  token: string,
  payload: { mode: string; capability: string; query: string; prompt: string },
): Promise<PromptGenTaskId> {
  return request('/api/promptgen/generate', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function pollPromptGen(
  token: string,
  task: PromptGenTaskId,
): Promise<PromptGenPollResponse> {
  return request('/api/promptgen/poll', token, {
    method: 'POST',
    body: JSON.stringify(task),
  })
}
