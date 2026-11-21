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
 * `{random}` expands into another random placeholder — any builtin category,
 * `{?}`, or one of the user's non-empty custom placeholders — which is then
 * expanded as if it had been written in the prompt.
 */
export const RANDOM_PLACEHOLDER = 'random'

/**
 * Names reserved for the 7 builtin categories above, `{random}`, plus the server-side `{?}`
 * two-word-name placeholder (expanded in image_job_names.rs, not here). Custom
 * placeholder names may not collide with these (case-insensitive). Keep in sync
 * with `RESERVED_PLACEHOLDER_NAMES` in
 * `oai/backend/src/db/prompt_placeholders.rs` by hand — there is no shared schema
 * between Rust and TypeScript here.
 */
export const RESERVED_PLACEHOLDER_NAMES: readonly string[] = [...PLACEHOLDER_CATEGORIES, RANDOM_PLACEHOLDER, '?']

export function isReservedPlaceholderName(name: string): boolean {
  return RESERVED_PLACEHOLDER_NAMES.includes(name.trim().toLowerCase())
}

/** Mirrors the backend's `^[A-Za-z0-9._-]{1,64}$` charset check (UX only — the server is authoritative). */
export function isValidPlaceholderName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name.trim())
}

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

const TOKEN_RE = /^[A-Za-z0-9._-]+$/

/**
 * Matches a `{...}` block starting at `start` (where `text[start] === '{'`),
 * balancing nested `{...}` pairs. Returns the matching closing `}` index and the
 * top-level `|` choices (if any `|` appears at brace depth 1), or `null` if the
 * brace is unclosed.
 */
function matchBraced(text: string, start: number): { close: number; choices: string[] | null } | null {
  let depth = 1
  let choiceStart = start + 1
  let choices: string[] | null = null
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        if (choices !== null) {
          choices.push(text.slice(choiceStart, i))
        }
        return { close: i, choices }
      }
    } else if (ch === '|' && depth === 1) {
      if (choices === null) choices = []
      choices.push(text.slice(choiceStart, i))
      choiceStart = i + 1
    }
  }
  return null
}

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

  let out = ''
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open === -1) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, open)
    const matched = matchBraced(text, open)
    if (!matched) {
      out += '{'
      i = open + 1
      continue
    }
    const { close, choices } = matched
    if (choices !== null) {
      const picked = choices[Math.floor(Math.random() * choices.length)].trim()
      out += expandLevel(picked, usage, customDefs, depth + 1)
      i = close + 1
      continue
    }
    const rawToken = text.slice(open + 1, close)
    if (!TOKEN_RE.test(rawToken)) {
      out += '{'
      i = open + 1
      continue
    }
    const token = rawToken.toLowerCase()

    const builtin = CATEGORY_DICTIONARIES[token]
    if (builtin) {
      // Builtin dictionary entries are plain words with no braces, so they never
      // need recursive re-expansion.
      out += pickUnique(builtin, usedSetFor(usage, token))
      i = close + 1
      continue
    }

    if (token === RANDOM_PLACEHOLDER) {
      const pool = [
        ...PLACEHOLDER_CATEGORIES,
        '?',
        ...Object.keys(customDefs).filter(name => name !== RANDOM_PLACEHOLDER && customDefs[name]?.length),
      ]
      const name = pool[Math.floor(Math.random() * pool.length)]
      // `{?}` is expanded server-side, so hand it back literally.
      if (name === '?') {
        out += '{?}'
      } else {
        out += expandLevel(`{${name}}`, usage, customDefs, depth + 1)
      }
      i = close + 1
      continue
    }

    const variants = customDefs[token]
    if (variants && variants.length > 0) {
      const picked = pickUnique(variants, usedSetFor(usage, token))
      out += expandLevel(picked, usage, customDefs, depth + 1)
      i = close + 1
      continue
    }

    // Unknown placeholder name (including `{?}`, expanded server-side at submit
    // time) — leave it untouched.
    out += text.slice(open, close + 1)
    i = close + 1
  }
  return out
}

/**
 * Expand `{category}`, `{random}`, user-defined `{name}`, and inline `{a|b|c}` choices.
 * Each choice occurrence is an independent random draw, including across a batch;
 * the chosen alternative may itself contain `{placeholders}` or nested choices.
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
