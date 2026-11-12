/** Prompt Studio (`/app/prompt-studio`) — shared constants and pure helpers. */

export const PROMPT_STUDIO_PATH = '/app/prompt-studio'

/** Prompt-library bucket for Prompt Studio system prompts (separate from Chat's `llm-system`). */
export const PROMPT_STUDIO_SYSTEM_BUCKET = 'prompt-studio-system'
/** Prompt-library bucket for Prompt Studio message templates (`{prompt}` = example prompt). */
export const PROMPT_STUDIO_TEMPLATE_BUCKET = 'prompt-studio-user'
/** Where the example prompt is picked from — the txt2img prompt library. */
export const IMGGEN_PROMPT_BUCKET = 'imggen-prompt'

/** Canned follow-up offered after every reply. */
export const ANOTHER_ONE_MESSAGE = 'Good, now create another one'

export const TEMPLATE_TOKEN = '{prompt}'

/** `navigate(PROMPT_STUDIO_PATH, { state })` — opens a new session seeded with this example. */
export type PromptStudioRouteState = {
  examplePrompt?: string
}

/**
 * Fills a message template with the example prompt. Every `{prompt}` is replaced;
 * a template without the token gets the example appended after a blank line.
 * An empty example yields an empty string — the composer stays freeform.
 */
export function renderTemplate(template: string, example: string): string {
  const ex = example.trim()
  if (!ex) return ''
  const tpl = template.trim()
  if (!tpl) return ex
  if (tpl.includes(TEMPLATE_TOKEN)) return tpl.split(TEMPLATE_TOKEN).join(ex)
  return `${tpl}\n\n${ex}`
}

const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g
const WRAPPING_QUOTES: [string, string][] = [['"', '"'], ['“', '”'], ["'", "'"], ['«', '»']]

/**
 * The image prompt inside an LLM reply: the body of the only fenced code block if
 * there is exactly one, otherwise the whole reply — trimmed, with one pair of
 * wrapping quotes removed.
 */
export function extractPrompt(reply: string): string {
  const blocks = [...reply.matchAll(FENCE_RE)]
  let text = blocks.length === 1 ? blocks[0][1] : reply
  text = text.trim()
  for (const [open, close] of WRAPPING_QUOTES) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, -close.length).trim()
      break
    }
  }
  return text
}
