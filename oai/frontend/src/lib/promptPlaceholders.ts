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
const REFERENCE_TOKEN_RE = /^([A-Za-z0-9._-]+)(?::([1-9][0-9]*))?$/

type PlaceholderReferences = {
  bareNames: Set<string>
  values: Map<string, string>
}

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
  } while (used.has(value) && guard < Math.min(dict.length * 4, 64))
  if (used.has(value)) {
    const available = dict.filter(entry => !used.has(entry))
    if (available.length > 0) {
      value = uniqueNamesGenerator({ dictionaries: [available] })
    } else {
      used.clear()
    }
  }
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
  references: PlaceholderReferences,
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
      out += expandLevel(picked, usage, customDefs, references, depth + 1)
      i = close + 1
      continue
    }
    const matchedToken = REFERENCE_TOKEN_RE.exec(text.slice(open + 1, close))
    if (!matchedToken) {
      out += '{'
      i = open + 1
      continue
    }
    const token = matchedToken[1].toLowerCase()
    let slot = matchedToken[2]
    if (slot === undefined && !references.bareNames.has(token)) {
      references.bareNames.add(token)
      slot = '1'
    }
    const key = slot === undefined ? undefined : `${token}:${slot}`
    let value = key === undefined ? undefined : references.values.get(key)

    if (value === undefined) {
      const builtin = Object.hasOwn(CATEGORY_DICTIONARIES, token) ? CATEGORY_DICTIONARIES[token] : undefined
      const custom = Object.hasOwn(customDefs, token) ? customDefs[token] : undefined
      const variants = builtin ?? custom
      if (token === RANDOM_PLACEHOLDER) {
        const pool = [
          ...PLACEHOLDER_CATEGORIES,
          '?',
          ...Object.keys(customDefs).filter(name => name !== RANDOM_PLACEHOLDER && customDefs[name]?.length),
        ]
        const name = pool[Math.floor(Math.random() * pool.length)]
        value = expandLevel(`{${name}}`, usage, customDefs, references, depth + 1)
      } else if (variants?.length) {
        const picked = pickUnique(variants, usedSetFor(usage, token))
        value = expandLevel(picked, usage, customDefs, references, depth + 1)
      }
      if (key !== undefined && value !== undefined) references.values.set(key, value)
    }

    out += value ?? text.slice(open, close + 1)
    i = close + 1
  }
  return out
}

/** Reverse substitution only considers dictionary/variant entries up to this many words. */
export const REVERSE_MAX_WORDS = 2

/**
 * The user's reverse-substitution registry: `words` are never replaced, and
 * `placeholders` (names like `color` or `{color}`) are never tried at all.
 */
export interface ReverseExclusions {
  words: string[]
  placeholders: string[]
}

export const NO_REVERSE_EXCLUSIONS: ReverseExclusions = { words: [], placeholders: [] }

/** Builtin categories in matching priority: `adjective` is a catch-all of everyday words, so it goes last. */
const REVERSE_BUILTIN_ORDER = [
  ...PLACEHOLDER_CATEGORIES.filter(name => name !== 'adjective'),
  'adjective',
]

function normalizeWord(word: string): string {
  return word.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** `{Color}`, ` color `, `color` -> `color`. */
export function normalizePlaceholderName(name: string): string {
  return name.trim().replace(/^\{|\}$/g, '').trim().toLowerCase()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Inverse of expansion: replaces literal values that appear in `prompt` with the
 * `{placeholder}` they could have come from — "red" -> `{color}`. Case-insensitive,
 * whole-word, longest value first. Covers the builtin categories and the user's
 * custom placeholders; when a value belongs to several, custom wins, then the
 * builtins alphabetically, and `{adjective}` last. The server-side `{?}` and
 * `{random}` have no value list, so they never match. Entries longer than
 * `REVERSE_MAX_WORDS` words, and custom variants that are themselves templates
 * (contain `{`, `}` or `|`), are skipped, as is anything in `exclusions`.
 * Existing `{...}` tokens are left untouched.
 */
export function reversePromptSubstitutions(
  prompt: string,
  customDefs: Record<string, string[]> = {},
  exclusions: ReverseExclusions = NO_REVERSE_EXCLUSIONS,
): { text: string; count: number } {
  const skipWords = new Set(exclusions.words.map(normalizeWord))
  const skipNames = new Set(exclusions.placeholders.map(normalizePlaceholderName))
  const lookup = new Map<string, string>()
  const add = (name: string, value: string) => {
    const v = normalizeWord(value)
    if (!v || /[{}|]/.test(v) || v.split(' ').length > REVERSE_MAX_WORDS || skipWords.has(v)) return
    if (!lookup.has(v)) lookup.set(v, name)
  }
  for (const [name, variants] of Object.entries(customDefs)) {
    if (!TOKEN_RE.test(name) || name === RANDOM_PLACEHOLDER || CATEGORY_DICTIONARIES[name]) continue
    if (skipNames.has(name)) continue
    for (const v of variants) add(name, v)
  }
  for (const name of REVERSE_BUILTIN_ORDER) {
    if (skipNames.has(name)) continue
    for (const v of CATEGORY_DICTIONARIES[name]) add(name, v)
  }
  if (lookup.size === 0) return { text: prompt, count: 0 }

  const alternation = [...lookup.keys()]
    .sort((a, b) => b.length - a.length)
    .map(v => escapeRegExp(v).replace(/ /g, '\\s+'))
    .join('|')
  const valueRe = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, 'giu')

  let count = 0
  // Odd indices are existing `{...}` tokens/choices — keep them verbatim.
  const text = prompt
    .split(/(\{[^{}]*\})/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(valueRe, match => {
            const name = lookup.get(normalizeWord(match))
            if (!name) return match
            count += 1
            return `{${name}}`
          }),
    )
    .join('')
  return { text, count }
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
 * Numbered references replay a value within this prompt. The first bare occurrence
 * shares slot 1, and subsequent bare occurrences draw independently.
 */
export function expandPromptPlaceholders(
  prompt: string,
  usage: PlaceholderUsage,
  customDefs: Record<string, string[]> = {},
): string {
  return expandLevel(prompt, usage, customDefs, { bareNames: new Set(), values: new Map() }, 0)
}
