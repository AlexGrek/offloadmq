import builtins from '../../../backend/src/default_prompts.json'

export const BUILTIN_PROMPT_DEFAULTS = {
  ...builtins,
  image_cycles: builtins.describe_image,
}

export type PromptApp = keyof typeof BUILTIN_PROMPT_DEFAULTS
export type PromptDefaults = Record<PromptApp, string | null>

export function resolvePromptDefaults(overrides?: PromptDefaults) {
  return Object.fromEntries(
    Object.entries(BUILTIN_PROMPT_DEFAULTS).map(([key, fallback]) => [
      key, overrides?.[key as PromptApp]?.trim() || fallback,
    ]),
  ) as Record<PromptApp, string>
}
