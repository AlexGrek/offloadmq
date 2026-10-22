import { BUILTIN_PROMPT_DEFAULTS } from './promptDefaults'

/** Shared built-ins; each app may override its default in user settings. */
export const DEFAULT_DESCRIBE_PROMPT = BUILTIN_PROMPT_DEFAULTS.describe_image
export const DESCRIBE_PROMPT_BUCKET = 'describe-image-user'
export const DEFAULT_IMPROVER_PROMPT = BUILTIN_PROMPT_DEFAULTS.generator_improver
