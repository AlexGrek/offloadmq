import { useAuth } from '../contexts/AuthContext'
import { resolvePromptDefaults } from '../lib/promptDefaults'

export function useDefaultPrompts() {
  const { user } = useAuth()
  return resolvePromptDefaults(user?.prompt_defaults)
}
