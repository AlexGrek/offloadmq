import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Highlighter,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Trash2,
  Type,
  Undo2,
  X,
  Zap,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { JobErrorBanner } from '@/components/JobErrorBanner'
import { DIMENSION_PRESETS, MODE_DEFAULTS } from '@/lib/imggen'
import { capabilityBaseLabel } from '@/lib/modelAvailability'
import {
  appendSegment,
  countWords,
  removeSegment,
  replaceSegment,
  splitSegments,
  type SegmentMode,
} from '@/lib/promptSegments'
import { cn } from '@/lib/utils'
import { clampGenerateCount, MAX_QUICK_GENERATE, useQuickTxt2Img } from '../imggen/useQuickTxt2Img'

const SIZE_KEY = 'oai_prompt_editor_size'
const MODE_KEY = 'oai_prompt_editor_mode'
/** `editing === NEW_SEGMENT` → the "add a sentence" field at the end. */
const NEW_SEGMENT = -1

type Size = readonly [number, number]

function loadSize(): Size {
  try {
    const raw = window.localStorage.getItem(SIZE_KEY)
    const match = raw ? /^(\d+)x(\d+)$/.exec(raw) : null
    if (match) {
      const size: Size = [Number(match[1]), Number(match[2])]
      if (DIMENSION_PRESETS.some(([w, h]) => w === size[0] && h === size[1])) return size
    }
  } catch { /* storage unavailable */ }
  return [MODE_DEFAULTS.txt2img.width, MODE_DEFAULTS.txt2img.height]
}

function loadMode(): SegmentMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'phrase' ? 'phrase' : 'sentence'
  } catch {
    return 'sentence'
  }
}

function persist(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch { /* storage unavailable */ }
}

const SIZE_GROUPS: { label: string; sizes: Size[] }[] = [
  { label: 'Square', sizes: DIMENSION_PRESETS.filter(([w, h]) => w === h) },
  { label: 'Landscape', sizes: DIMENSION_PRESETS.filter(([w, h]) => w > h) },
  { label: 'Portrait', sizes: DIMENSION_PRESETS.filter(([w, h]) => w < h) },
]

/**
 * Smart prompt editor (Prompt Studio): a full-screen workspace where the prompt is laid
 * out as highlightable sentences (or comma phrases). Hover highlights, click selects;
 * a selected segment can be edited in place or deleted. A side panel picks size/model
 * and starts txt2img right away, or hands the edited prompt to Image Generation.
 */
export function PromptEditor({
  open,
  onOpenChange,
  token,
  prompt,
  onUse,
  onApply,
  applyLabel = 'Apply',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string
  prompt: string
  /** Opens Image Generation with the edited prompt. */
  onUse: (prompt: string) => void
  /** Writes the edited prompt back to where it came from (e.g. the example prompt field). */
  onApply?: (prompt: string) => void
  applyLabel?: string
}) {
  const models = useQuickTxt2Img(token, open)
  const [text, setText] = useState(prompt.trim())
  const [past, setPast] = useState<string[]>([])
  const [future, setFuture] = useState<string[]>([])
  const [mode, setMode] = useState<SegmentMode>(loadMode)
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [rawMode, setRawMode] = useState(false)
  const rawStartRef = useRef('')
  const [size, setSize] = useState<Size>(loadSize)
  const [countInput, setCountInput] = useState('1')
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)

  const segments = useMemo(() => splitSegments(text, mode), [text, mode])
  const words = countWords(text)
  const count = clampGenerateCount(countInput)
  const canGenerate = models.ready && Boolean(text.trim()) && !generating && editing === null

  function commit(next: string) {
    const value = next.trim()
    if (value === text) return
    setPast(p => [...p, text])
    setFuture([])
    setText(value)
    setNotice(null)
  }

  function undo() {
    if (past.length === 0) return
    setFuture(f => [text, ...f])
    setText(past[past.length - 1])
    setPast(p => p.slice(0, -1))
    setSelected(null)
    setEditing(null)
  }

  function redo() {
    if (future.length === 0) return
    setPast(p => [...p, text])
    setText(future[0])
    setFuture(f => f.slice(1))
    setSelected(null)
    setEditing(null)
  }

  function startEdit(index: number) {
    setSelected(index)
    setEditing(index)
    setDraft(index === NEW_SEGMENT ? '' : segments[index]?.text ?? '')
  }

  function finishEdit(save: boolean) {
    if (editing === null) return
    if (save) {
      if (editing === NEW_SEGMENT) commit(appendSegment(segments, mode, draft))
      else commit(replaceSegment(segments, editing, draft))
    }
    setEditing(null)
    setSelected(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function deleteSegment(index: number) {
    commit(removeSegment(segments, index))
    const remaining = segments.length - 1
    setSelected(remaining > 0 ? Math.min(index, remaining - 1) : null)
    setEditing(null)
  }

  function changeMode(next: SegmentMode) {
    setMode(next)
    persist(MODE_KEY, next)
    setSelected(null)
    setEditing(null)
  }

  function toggleRaw() {
    if (rawMode) {
      // The whole free-text session becomes one undo step.
      const edited = text.trim()
      setText(edited)
      if (edited !== rawStartRef.current) {
        setPast(p => [...p, rawStartRef.current])
        setFuture([])
      }
    } else {
      rawStartRef.current = text
    }
    setRawMode(v => !v)
    setSelected(null)
    setEditing(null)
  }

  function pickSize(next: Size) {
    setSize(next)
    persist(SIZE_KEY, `${next[0]}x${next[1]}`)
  }

  async function generate() {
    if (!canGenerate) return
    setGenerating(true)
    setError(null)
    setNotice(null)
    try {
      const ids = await models.generate({ prompt: text, width: size[0], height: size[1], count })
      setNotice(
        `Started ${ids.length} ${ids.length === 1 ? 'image' : 'images'} at ${size[0]}×${size[1]} — follow ${ids.length === 1 ? 'it' : 'them'} in Progress.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start image generation')
    } finally {
      setGenerating(false)
    }
  }

  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  function onCanvasKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (editing !== null || rawMode) return
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
      return
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault()
      void generate()
      return
    }
    if (segments.length === 0) return
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        setSelected(s => (s === null ? 0 : Math.min(segments.length - 1, s + 1)))
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        setSelected(s => (s === null ? segments.length - 1 : Math.max(0, s - 1)))
        break
      case 'Delete':
      case 'Backspace':
        if (selected !== null) {
          event.preventDefault()
          deleteSegment(selected)
        }
        break
      case 'Enter':
        if (selected !== null) {
          event.preventDefault()
          startEdit(selected)
        }
        break
    }
  }

  // Keep the selected segment in view while stepping through with the arrow keys.
  useEffect(() => {
    if (selected === null) return
    canvasRef.current
      ?.querySelector(`[data-segment="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const hasSelection = selected !== null && editing === null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        data-testid="prompt-editor"
        className="left-0 top-0 h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 sm:w-full"
        onOpenAutoFocus={event => {
          event.preventDefault()
          canvasRef.current?.focus({ preventScroll: true })
        }}
        onEscapeKeyDown={event => {
          // Esc steps out of an edit / selection before it closes the editor.
          if (editing !== null) {
            event.preventDefault()
            finishEdit(false)
          } else if (selected !== null) {
            event.preventDefault()
            setSelected(null)
          }
        }}
      >
        {/* ── Header ── */}
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5 sm:px-5">
          <div className="flex min-w-[11rem] flex-1 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400">
              <Highlighter className="size-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="font-display text-sm font-semibold tracking-tight">
                Prompt editor
              </DialogTitle>
              <DialogDescription className="hidden truncate text-xs text-muted-foreground sm:block">
                Hover to highlight, click a {mode === 'sentence' ? 'sentence' : 'phrase'} to edit or delete it.
              </DialogDescription>
            </div>
          </div>

          <div
            role="radiogroup"
            aria-label="Split prompt into"
            className="flex rounded-lg border border-border p-0.5 text-xs"
          >
            {(['sentence', 'phrase'] as const).map(m => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m && !rawMode}
                disabled={rawMode}
                onClick={() => changeMode(m)}
                data-testid={`prompt-editor-mode-${m}`}
                className={cn(
                  'rounded-md px-2.5 py-1 font-medium transition-colors disabled:opacity-50',
                  mode === m && !rawMode
                    ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m === 'sentence' ? 'Sentences' : 'Phrases'}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-0.5">
            <IconButton
              label={rawMode ? 'Back to highlight mode' : 'Edit as plain text'}
              onClick={toggleRaw}
              active={rawMode}
              testId="prompt-editor-raw"
            >
              <Type className="size-4" />
            </IconButton>
            <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={past.length === 0 || rawMode} testId="prompt-editor-undo">
              <Undo2 className="size-4" />
            </IconButton>
            <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={future.length === 0 || rawMode} testId="prompt-editor-redo">
              <Redo2 className="size-4" />
            </IconButton>
            <IconButton
              label="Reset to the original prompt"
              onClick={() => { commit(prompt); setSelected(null); setEditing(null) }}
              disabled={text === prompt.trim() || rawMode}
              testId="prompt-editor-reset"
            >
              <RotateCcw className="size-4" />
            </IconButton>
            <IconButton label="Close editor" onClick={() => onOpenChange(false)} testId="prompt-editor-close">
              <X className="size-4" />
            </IconButton>
          </div>
        </header>

        {/* ── Body: canvas + generate panel ── */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          <section className="flex min-h-[45dvh] flex-1 flex-col lg:min-h-0">
            <div
              ref={canvasRef}
              tabIndex={-1}
              onKeyDown={onCanvasKeyDown}
              onClick={event => {
                if (event.target === event.currentTarget && editing === null) setSelected(null)
              }}
              className="flex-1 overflow-y-auto bg-gradient-to-b from-blue-500/5 via-transparent to-transparent px-4 pb-10 pt-14 outline-none sm:px-10 lg:px-16"
              data-testid="prompt-editor-canvas"
            >
              {rawMode ? (
                <textarea
                  autoFocus
                  value={text}
                  onChange={e => setText(e.target.value)}
                  className="mx-auto block min-h-[50dvh] w-full max-w-3xl resize-none rounded-xl border border-input bg-background/60 p-4 font-display text-lg leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 sm:text-xl"
                  data-testid="prompt-editor-raw-input"
                />
              ) : (
                <div
                  className={cn(
                    'mx-auto max-w-3xl whitespace-pre-wrap font-display text-lg leading-[2.1] sm:text-xl',
                    hasSelection && 'text-muted-foreground/70',
                  )}
                  onClick={event => {
                    if (event.target === event.currentTarget && editing === null) setSelected(null)
                  }}
                  data-testid="prompt-editor-text"
                >
                  {segments.length === 0 && editing === null && (
                    <p className="text-base text-muted-foreground">The prompt is empty — add a sentence below.</p>
                  )}
                  {segments.map((segment, index) =>
                    editing === index ? (
                      <SegmentEditor
                        key={`edit-${index}`}
                        value={draft}
                        onChange={setDraft}
                        onSave={() => finishEdit(true)}
                        onCancel={() => finishEdit(false)}
                      />
                    ) : (
                      <span key={index}>
                        <span className="relative">
                          {selected === index && editing === null && (
                            <span
                              className="absolute bottom-full left-0 z-10 mb-1 flex items-center gap-0.5 whitespace-nowrap rounded-lg border border-border bg-popover p-0.5 font-sans text-xs leading-none text-foreground shadow-lg"
                              data-testid="prompt-editor-segment-toolbar"
                            >
                              <ToolbarButton onClick={() => startEdit(index)} testId="prompt-editor-segment-edit">
                                <Pencil className="size-3.5" /> Edit
                              </ToolbarButton>
                              <ToolbarButton onClick={() => deleteSegment(index)} testId="prompt-editor-segment-delete" destructive>
                                <Trash2 className="size-3.5" /> Delete
                              </ToolbarButton>
                            </span>
                          )}
                          <span
                            role="button"
                            tabIndex={-1}
                            data-segment={index}
                            data-testid={`prompt-editor-segment-${index}`}
                            aria-pressed={selected === index}
                            onClick={() => (selected === index ? startEdit(index) : setSelected(index))}
                            className={cn(
                              'cursor-pointer rounded-md px-0.5 [box-decoration-break:clone] transition-colors',
                              'hover:bg-blue-500/15 hover:text-foreground',
                              selected === index &&
                                'bg-blue-500/20 text-foreground ring-2 ring-blue-500/50 hover:bg-blue-500/20',
                            )}
                          >
                            {segment.text}
                          </span>
                        </span>
                        {index < segments.length - 1 ? segment.sep : ''}
                      </span>
                    ),
                  )}
                  {editing === NEW_SEGMENT ? (
                    <SegmentEditor
                      value={draft}
                      onChange={setDraft}
                      onSave={() => finishEdit(true)}
                      onCancel={() => finishEdit(false)}
                      placeholder={mode === 'sentence' ? 'New sentence…' : 'New phrase…'}
                    />
                  ) : (
                    <span className="ml-2 inline-block align-middle">
                      <button
                        type="button"
                        onClick={() => startEdit(NEW_SEGMENT)}
                        className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 font-sans text-xs leading-5 text-muted-foreground transition-colors hover:border-blue-500/60 hover:text-blue-600 dark:hover:text-blue-400"
                        data-testid="prompt-editor-add"
                      >
                        <Plus className="size-3" />
                        Add {mode === 'sentence' ? 'sentence' : 'phrase'}
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground sm:px-10 lg:px-16">
              <span data-testid="prompt-editor-stats">
                {segments.length} {mode === 'sentence' ? 'sentences' : 'phrases'} · {words} words · {text.length} chars
              </span>
              {!rawMode && (
                <span className="hidden sm:inline">
                  ←/→ select · Enter edit · Del delete · Esc deselect · Ctrl+Enter generate
                </span>
              )}
            </footer>
          </section>

          {/* ── Generate panel ── */}
          <aside className="flex shrink-0 flex-col gap-5 border-t border-border bg-muted/20 p-4 lg:w-96 lg:overflow-y-auto lg:border-l lg:border-t-0">
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Size</h3>
              <div className="space-y-2.5" data-testid="prompt-editor-sizes">
                {SIZE_GROUPS.map(group => (
                  <div key={group.label}>
                    <p className="mb-1 text-[11px] text-muted-foreground">{group.label}</p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {group.sizes.map(([w, h]) => {
                        const active = size[0] === w && size[1] === h
                        const scale = 18 / Math.max(w, h)
                        return (
                          <button
                            key={`${w}x${h}`}
                            type="button"
                            aria-pressed={active}
                            onClick={() => pickSize([w, h])}
                            data-testid={`prompt-editor-size-${w}x${h}`}
                            className={cn(
                              'flex min-h-10 items-center gap-1.5 rounded-md border px-1.5 text-[11px] tabular-nums transition-colors',
                              active
                                ? 'border-blue-500/70 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                                : 'border-input bg-background hover:bg-muted/60',
                            )}
                          >
                            <span className="flex size-5 shrink-0 items-center justify-center">
                              <span
                                className={cn('rounded-[2px] border', active ? 'border-blue-500 bg-blue-500/30' : 'border-muted-foreground/60')}
                                style={{ width: Math.round(w * scale), height: Math.round(h * scale) }}
                              />
                            </span>
                            {w}×{h}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="prompt-editor-model" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Model
              </label>
              <div className="flex gap-1.5">
                <select
                  id="prompt-editor-model"
                  value={models.capability}
                  onChange={e => models.setCapability(e.target.value)}
                  disabled={models.status !== 'ready' || models.capabilities.length === 0}
                  className="min-h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  data-testid="prompt-editor-model"
                >
                  {models.capabilities.length === 0 && (
                    <option value="">{models.status === 'loading' ? 'Loading models…' : 'No models'}</option>
                  )}
                  {models.capabilities.map(cap => (
                    <option key={cap.raw} value={cap.base}>
                      {capabilityBaseLabel(cap.base)}{cap.online ? '' : ' (offline)'}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10"
                  onClick={models.refresh}
                  disabled={models.status === 'loading'}
                  title="Refresh models"
                  aria-label="Refresh models"
                >
                  <RefreshCw className="size-4" />
                </Button>
              </div>
              {models.status === 'error' && models.error && (
                <JobErrorBanner message={models.error} testId="prompt-editor-model-error" />
              )}
            </div>

            <div className="flex items-end gap-2">
              <div className="w-20 space-y-1.5">
                <label htmlFor="prompt-editor-count" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Images
                </label>
                <input
                  id="prompt-editor-count"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_QUICK_GENERATE}
                  value={countInput}
                  onChange={e => setCountInput(e.target.value)}
                  onBlur={() => setCountInput(String(count))}
                  className="min-h-10 w-full rounded-md border border-input bg-background px-2.5 font-mono text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="prompt-editor-count"
                />
              </div>
              <Button
                type="button"
                onClick={() => void generate()}
                disabled={!canGenerate}
                className="min-h-10 flex-1 gap-1.5 bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
                data-testid="prompt-editor-generate"
              >
                {generating ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
                {generating ? 'Starting…' : `Generate ${count === 1 ? '' : `${count} `}now`}
              </Button>
            </div>
            {notice && (
              <p className="rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300" data-testid="prompt-editor-notice">
                {notice}
              </p>
            )}
            {error && <JobErrorBanner message={error} testId="prompt-editor-error" />}

            <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
              <Button
                type="button"
                variant="outline"
                className="min-h-10 justify-start gap-2"
                onClick={() => onUse(text)}
                disabled={!text.trim() || editing !== null}
                data-testid="prompt-editor-use"
              >
                <ImagePlus className="size-4" />
                Open in Image Generation
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-10 flex-1 gap-2"
                  onClick={copy}
                  disabled={!text.trim()}
                  data-testid="prompt-editor-copy"
                >
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                {onApply && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-10 flex-1 gap-2"
                    onClick={() => { onApply(text); onOpenChange(false) }}
                    disabled={editing !== null}
                    data-testid="prompt-editor-apply"
                  >
                    <Check className="size-4" />
                    {applyLabel}
                  </Button>
                )}
              </div>
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SegmentEditor({
  value,
  onChange,
  onSave,
  onCancel,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <span className="my-2 block rounded-xl border border-blue-500/50 bg-background p-2 shadow-sm" data-testid="prompt-editor-segment-editor">
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        rows={1}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onSave()
          }
        }}
        className="block w-full resize-none overflow-hidden bg-transparent font-display text-lg leading-relaxed outline-none sm:text-xl"
        data-testid="prompt-editor-segment-input"
      />
      <span className="mt-1.5 flex items-center justify-end gap-1.5 font-sans text-xs leading-none">
        <span className="mr-auto text-muted-foreground">Enter to save · Esc to cancel · empty deletes</span>
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" className="h-7" onClick={onSave} data-testid="prompt-editor-segment-save">
          Save
        </Button>
      </span>
    </span>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  active,
  testId,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  testId: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        'flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
      )}
    >
      {children}
    </button>
  )
}

function ToolbarButton({
  onClick,
  testId,
  destructive,
  children,
}: {
  onClick: () => void
  testId: string
  destructive?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={event => { event.stopPropagation(); onClick() }}
      data-testid={testId}
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors',
        destructive ? 'text-destructive hover:bg-destructive/10' : 'hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}
