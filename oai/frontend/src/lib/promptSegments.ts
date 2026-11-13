/**
 * Prompt Editor segmentation — splits a prompt into sentences (or comma phrases) that
 * can be highlighted, edited and deleted one at a time. The prompt text stays the
 * source of truth: segments are re-derived from it on every change, and each edit
 * produces a new text via {@link joinSegments}.
 */

export type SegmentMode = 'sentence' | 'phrase'

export type Segment = {
  /** Segment text, including its closing punctuation (`.`, `,` …). */
  text: string
  /** Whitespace that followed it in the source (kept so line breaks survive edits). */
  sep: string
}

const CLOSERS = `["'”’)\\]]*`
const BOUNDARY: Record<SegmentMode, RegExp> = {
  // A terminator only ends a sentence when whitespace or the end follows (`f/1.8`, `8.5mm` stay whole).
  sentence: new RegExp(`[.!?…]+${CLOSERS}(?=\\s|$)`, 'g'),
  phrase: new RegExp(`[.!?…]+${CLOSERS}(?=\\s|$)|[,;:](?=\\s|$)`, 'g'),
}
const ENDS_SENTENCE = new RegExp(`[.!?…]+${CLOSERS}$`)
const ENDS_PHRASE = /[,;:]$/

export function splitSegments(text: string, mode: SegmentMode): Segment[] {
  const segments: Segment[] = []
  const re = BOUNDARY[mode]
  let pos = /^\s*/.exec(text)![0].length
  while (pos < text.length) {
    re.lastIndex = pos
    const match = re.exec(text)
    const newline = text.indexOf('\n', pos)
    let end = match ? match.index + match[0].length : text.length
    if (newline >= 0 && newline < end) end = newline
    const raw = text.slice(pos, end)
    const ws = /^\s*/.exec(text.slice(end))![0]
    const body = raw.trimEnd()
    const sep = raw.slice(body.length) + ws
    if (body) segments.push({ text: body, sep })
    else if (segments.length > 0) segments[segments.length - 1].sep += sep
    pos = end + ws.length
    if (end === pos && ws.length === 0) pos += 1 // never stall
  }
  return segments
}

export function joinSegments(segments: Segment[]): string {
  return segments
    .map(s => s.text + s.sep)
    .join('')
    .trim()
    .replace(/[,;:]$/, '')
}

export function replaceSegment(segments: Segment[], index: number, text: string): string {
  const value = text.trim()
  if (!value) return removeSegment(segments, index)
  return joinSegments(segments.map((s, i) => (i === index ? { ...s, text: value } : s)))
}

/**
 * Drops one segment. Punctuation is repaired so phrase deletes read naturally:
 * removing the sentence-closing phrase of `a, b, c. Next` turns the dangling `b,` into `b.`,
 * and a paragraph break that followed the removed segment is kept.
 */
export function removeSegment(segments: Segment[], index: number): string {
  const next = segments.map(s => ({ ...s }))
  const [removed] = next.splice(index, 1)
  if (!removed) return joinSegments(segments)
  const prev = next[index - 1]
  if (prev) {
    const terminator = ENDS_SENTENCE.exec(removed.text)?.[0]
    if (terminator && ENDS_PHRASE.test(prev.text)) {
      prev.text = prev.text.replace(ENDS_PHRASE, terminator)
    }
    if (removed.sep.includes('\n') && !prev.sep.includes('\n')) prev.sep = removed.sep
  }
  return joinSegments(next)
}

/** Appends a new segment, adding the punctuation the current mode expects before it. */
export function appendSegment(segments: Segment[], mode: SegmentMode, text: string): string {
  const value = text.trim()
  if (!value) return joinSegments(segments)
  const current = joinSegments(segments)
  if (!current) return value
  if (mode === 'sentence') {
    return ENDS_SENTENCE.test(current) ? `${current} ${value}` : `${current}. ${value}`
  }
  return ENDS_SENTENCE.test(current) || ENDS_PHRASE.test(current)
    ? `${current} ${value}`
    : `${current}, ${value}`
}

export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}
