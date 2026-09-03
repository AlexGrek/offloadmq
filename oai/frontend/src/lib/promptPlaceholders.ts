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

const PLACEHOLDER_RE = /\{([a-zA-Z][\w-]*)\}/g

/** Tracks values already handed out per category so a batch never repeats one. */
export type PlaceholderUsage = Map<string, Set<string>>

export function createPlaceholderUsage(): PlaceholderUsage {
  return new Map()
}

function pickUnique(dict: string[], used: Set<string>): string {
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

/**
 * Expands `{color}`, `{animal}`, `{adjective}`, `{country}`, `{language}`, `{name}` and
 * `{starwars}` placeholders in-place. Unknown `{...}` tokens (including `{?}`) are left
 * untouched. Pass the same `usage` map across a multi-image/video batch so every job in
 * the batch gets a distinct value per category, not just distinct within one prompt.
 */
export function expandPromptCategoryPlaceholders(prompt: string, usage: PlaceholderUsage): string {
  if (!prompt.includes('{')) return prompt
  return prompt.replace(PLACEHOLDER_RE, (match, rawCategory: string) => {
    const category = rawCategory.toLowerCase()
    const dict = CATEGORY_DICTIONARIES[category]
    if (!dict) return match
    let used = usage.get(category)
    if (!used) {
      used = new Set()
      usage.set(category, used)
    }
    return pickUnique(dict, used)
  })
}
