import {
  adjectives,
  animals,
  colors,
  countries,
  languages,
  names,
  starWars,
  uniqueNamesGenerator,
} from 'unique-names-generator'

/**
 * `{category}` placeholders resolved client-side via unique-names-generator.
 * `{?}` is deliberately not here — that one stays a literal token so the server
 * (image_job_names::expand_prompt_placeholders) substitutes it instead.
 */
const CATEGORY_DICTIONARIES: Record<string, string[]> = {
  color: colors,
  animal: animals,
  adjective: adjectives,
  country: countries,
  language: languages,
  name: names,
  starwars: starWars,
}

export const PLACEHOLDER_CATEGORIES = Object.keys(CATEGORY_DICTIONARIES).sort()

/**
 * Names reserved for the 7 builtin categories above, plus the server-side `{?}`
 * two-word-name placeholder (expanded in image_job_names.rs, not here). Custom
 * placeholder names may not collide with these (case-insensitive). Keep in sync
 * with `RESERVED_PLACEHOLDER_NAMES` in
 * `oai/backend/src/db/prompt_placeholders.rs` by hand — there is no shared schema
 * between Rust and TypeScript here.
 */
export const RESERVED_PLACEHOLDER_NAMES: readonly string[] = [...PLACEHOLDER_CATEGORIES, '?']

export function isReservedPlaceholderName(name: string): boolean {
  return RESERVED_PLACEHOLDER_NAMES.includes(name.trim().toLowerCase())
}

/** Mirrors the backend's `^[A-Za-z0-9._-]{1,64}$` charset check (UX only — the server is authoritative). */
export function isValidPlaceholderName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name.trim())
}

/**
 * Matches `{token}` where token is 1+ chars of letters/digits/`.`/`-`/`_`. Custom
 * names may start with `.` or a digit (e.g. `{.cinematic}`, `{film.}`). `?` is
 * deliberately excluded from the charset, so `{?}` (expanded server-side) and
 * empty `{}` both fail to match and pass through untouched — no special casing
 * needed.
 */
const PLACEHOLDER_RE = /\{([A-Za-z0-9._-]+)\}/g

/** Tracks values already handed out per placeholder name so a batch never repeats one. */
export type PlaceholderUsage = Map<string, Set<string>>

export function createPlaceholderUsage(): PlaceholderUsage {
  return new Map()
}

/**
 * Recursion cap for custom placeholders whose variant text itself contains
 * placeholders (including cyclic definitions, e.g. `{a}` -> `{b}` -> `{a}`). Once
 * reached, remaining `{token}` text is left literal instead of expanding further.
 */
export const MAX_PLACEHOLDER_DEPTH = 5

function pickUnique(dict: string[], used: Set<string>): string {
  if (dict.length === 0) return ''
  if (used.size >= dict.length) {
    // Pool exhausted for this batch — start a fresh cycle rather than looping forever.
    used.clear()
  }
  let value: string
  let guard = 0
  do {
    value = uniqueNamesGenerator({ dictionaries: [dict] })
    guard += 1
  } while (used.has(value) && guard < dict.length * 4)
  used.add(value)
  return value
}

function usedSetFor(usage: PlaceholderUsage, key: string): Set<string> {
  let used = usage.get(key)
  if (!used) {
    used = new Set()
    usage.set(key, used)
  }
  return used
}

function expandLevel(
  text: string,
  usage: PlaceholderUsage,
  customDefs: Record<string, string[]>,
  depth: number,
): string {
  if (!text.includes('{')) return text
  if (depth >= MAX_PLACEHOLDER_DEPTH) return text
  return text.replace(PLACEHOLDER_RE, (match, rawToken: string) => {
    const token = rawToken.toLowerCase()

    const builtin = CATEGORY_DICTIONARIES[token]
    if (builtin) {
      // Builtin dictionary entries are plain words with no braces, so they never
      // need recursive re-expansion.
      return pickUnique(builtin, usedSetFor(usage, token))
    }

    const variants = customDefs[token]
    if (variants && variants.length > 0) {
      const picked = pickUnique(variants, usedSetFor(usage, token))
      return expandLevel(picked, usage, customDefs, depth + 1)
    }

    // Unknown placeholder name (including `{?}`, expanded server-side at submit
    // time) — leave it untouched.
    return match
  })
}

/**
 * Expand `{category}` and user-defined `{name}` placeholders in a prompt.
 * `customDefs` maps a lowercased custom placeholder name to its variant list
 * (fetched from `GET /api/prompt-placeholders`); omit it if unavailable — custom
 * placeholders are additive, never required for a submission to succeed. `usage`
 * tracks values already picked per placeholder name (at any recursion depth) so
 * repeated calls with the same map — e.g. across a "Generate multiple" batch —
 * avoid repeats until a dictionary/variant list is exhausted.
 */
export function expandPromptPlaceholders(
  prompt: string,
  usage: PlaceholderUsage,
  customDefs: Record<string, string[]> = {},
): string {
  return expandLevel(prompt, usage, customDefs, 0)
}
