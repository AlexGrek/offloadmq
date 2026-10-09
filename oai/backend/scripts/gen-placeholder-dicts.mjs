// Regenerates src/services/placeholder_dicts/*.txt from the web UI's
// `unique-names-generator` dictionaries (MIT), so the server-side prompt expander
// (services/prompt_expansion.rs, used by the MCP tools) draws {color}, {animal}, …
// from exactly the same word lists as frontend/src/lib/promptPlaceholders.ts.
//
// Run from oai/backend after `npm install` in oai/frontend:
//   node scripts/gen-placeholder-dicts.mjs
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '../../frontend/package.json'))
const u = require('unique-names-generator')

const dictionaries = {
  color: u.colors,
  animal: u.animals,
  adjective: u.adjectives,
  country: u.countries,
  language: u.languages,
  name: u.names,
  starwars: u.starWars,
}

const outDir = join(here, '../src/services/placeholder_dicts')
for (const [name, words] of Object.entries(dictionaries)) {
  const clean = words.map((w) => w.trim()).filter((w) => w && !/[\n{}]/.test(w))
  writeFileSync(join(outDir, `${name}.txt`), clean.join('\n') + '\n')
  console.log(`${name}: ${clean.length}`)
}
