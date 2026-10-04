import { apiRequest } from './http'
import type { LlmCapabilityInfo } from '../types/ws'

export interface RewritePromptRequest {
  capability: string
  prompt: string
  system_prompt: string
  user_prompt: string
}

export function listRewriteModels(token: string, signal?: AbortSignal): Promise<LlmCapabilityInfo[]> {
  return apiRequest('/api/images/rewrite-prompt/capabilities', token, { signal })
}

export function rewritePrompt(token: string, body: RewritePromptRequest, signal?: AbortSignal): Promise<{ text: string }> {
  return apiRequest('/api/images/rewrite-prompt', token, {
    method: 'POST', body: JSON.stringify(body), signal,
  })
}
