import { apiRequest } from './http'
import type { PromptDefaults } from '../lib/promptDefaults'

export function savePromptDefaults(token: string, prompts: PromptDefaults) {
  return apiRequest<PromptDefaults>('/api/me/prompt-defaults', token, {
    method: 'PUT',
    body: JSON.stringify(prompts),
  })
}

/** Words never swapped for a placeholder, and placeholder names never tried, by "reverse substitutions". */
export interface ReverseExclusionsConfig {
  words: string[]
  placeholders: string[]
}

export function getReverseExclusions(token: string, signal?: AbortSignal) {
  return apiRequest<ReverseExclusionsConfig>('/api/me/reverse-exclusions', token, { signal })
}

export function saveReverseExclusions(token: string, value: ReverseExclusionsConfig) {
  return apiRequest<ReverseExclusionsConfig>('/api/me/reverse-exclusions', token, {
    method: 'PUT',
    body: JSON.stringify(value),
  })
}
