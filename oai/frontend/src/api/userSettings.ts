import { apiRequest } from './http'
import type { PromptDefaults } from '../lib/promptDefaults'

export function savePromptDefaults(token: string, prompts: PromptDefaults) {
  return apiRequest<PromptDefaults>('/api/me/prompt-defaults', token, {
    method: 'PUT',
    body: JSON.stringify(prompts),
  })
}
