import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  defaultResizeForm,
  listImgUtilsCapabilities,
  resizeFormError,
  resizeOptionsFromForm,
  toolKey,
  toolsFromCapabilities,
  DEFAULT_SCALE_MULTIPLIER,
  MAX_SCALE_MULTIPLIER,
  MIN_SCALE_MULTIPLIER,
  type ImgUtilTool,
  type ResizeFormState,
} from '../api/imgUtils'

/** Last-picked tool + its knobs, restored whenever a tool picker (the full
 *  page or the quick-transform modal) mounts. UI convenience only — never
 *  the source of truth for whether a tool is actually online. */
const STORAGE_KEY = 'oai_imgutils_last_tool'

interface StoredToolPrefs {
  selectedKey: string
  resizeForm: ResizeFormState
  scaleMultiplier: number
}

function readStoredPrefs(): Partial<StoredToolPrefs> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Partial<StoredToolPrefs>) : {}
  } catch {
    return {}
  }
}

function writeStoredPrefs(prefs: StoredToolPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // best-effort — quota/availability issues just mean the pick doesn't survive reload
  }
}

export interface ImgUtilsToolsState {
  tools: ImgUtilTool[]
  loading: boolean
  /** Capability-fetch failure, if any — surfaced by the caller. */
  error: string | null
  selectedKey: string
  setSelectedKey: (key: string) => void
  activeTool: ImgUtilTool | null
  needsSource: boolean
  takesScale: boolean
  isResize: boolean
  resizeState: ResizeFormState
  patchResize: (patch: Partial<ResizeFormState>) => void
  /** Why the resize form cannot be submitted, or null (also null for other tools). */
  resizeError: string | null
  scaleMultiplier: number
  setScaleMultiplier: (value: number) => void
  /** `options` for `startImgUtilsJob` — undefined when the tool has no knobs. */
  buildOptions: () => Record<string, unknown> | undefined
  reload: () => void
}

/** Online Image Tools plus the per-tool knob state, shared by the full page and
 *  the quick-transform popup. Pass `enabled: false` to hold the capability fetch
 *  back until a popup is actually opened; flipping it to true refetches, so a
 *  reopened popup sees agents that came online in the meantime. */
export function useImgUtilsTools(token: string | null, enabled = true): ImgUtilsToolsState {
  const [tools, setTools] = useState<ImgUtilTool[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  // Seeded from the last pick (any host: full page or quick modal) so a
  // reopened picker starts back where the user left off.
  const [initialPrefs] = useState(readStoredPrefs)
  const [selectedKey, setSelectedKey] = useState(() => initialPrefs.selectedKey ?? '')
  // Kept across tool switches so flipping back and forth never loses settings.
  const [resizeForm, setResizeForm] = useState<ResizeFormState>(
    () => initialPrefs.resizeForm ?? defaultResizeForm([]),
  )
  const [scaleMultiplier, setScaleRaw] = useState<number>(
    initialPrefs.scaleMultiplier ?? DEFAULT_SCALE_MULTIPLIER,
  )

  useEffect(() => {
    writeStoredPrefs({ selectedKey, resizeForm, scaleMultiplier })
  }, [selectedKey, resizeForm, scaleMultiplier])

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const res = await listImgUtilsCapabilities(token)
      const next = toolsFromCapabilities(res.capabilities)
      setTools(next)
      setSelectedKey(prev =>
        next.some(t => toolKey(t) === prev) ? prev : next[0] ? toolKey(next[0]) : '',
      )
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!enabled || !token) return
    let cancelled = false
    // Kick the fetch off a microtask so its setState lands in the async
    // continuation, never synchronously in the effect body.
    void (async () => {
      await Promise.resolve()
      if (!cancelled) await load()
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, token, load])

  const activeTool = useMemo(
    () => tools.find(t => toolKey(t) === selectedKey) ?? null,
    [tools, selectedKey],
  )
  const needsSource = activeTool?.needsSourceImage ?? false
  const takesScale = activeTool?.takesScale ?? false
  const isResize = activeTool?.kind === 'resize'

  // Agents publish their resampling filters in the capability brackets, so a
  // stored choice can go stale when the tool — or the agent behind it — changes.
  // Reconciled on read rather than written back, so no render cascade.
  const resizeState = useMemo<ResizeFormState>(() => {
    const methods = activeTool?.methods ?? []
    const method =
      resizeForm.method && methods.includes(resizeForm.method)
        ? resizeForm.method
        : defaultResizeForm(methods).method
    return method === resizeForm.method ? resizeForm : { ...resizeForm, method }
  }, [resizeForm, activeTool])

  const patchResize = useCallback((patch: Partial<ResizeFormState>) => {
    setResizeForm(prev => ({ ...prev, ...patch }))
  }, [])

  const setScaleMultiplier = useCallback((value: number) => {
    if (!Number.isFinite(value)) return
    setScaleRaw(Math.min(MAX_SCALE_MULTIPLIER, Math.max(MIN_SCALE_MULTIPLIER, value)))
  }, [])

  const resizeError = isResize ? resizeFormError(resizeState) : null

  const buildOptions = useCallback((): Record<string, unknown> | undefined => {
    // Resize carries its resize params here; upscale carries its multiplier;
    // depth/face_swap have no knobs from the UI.
    if (isResize) return resizeOptionsFromForm(resizeState)
    if (takesScale) return { scale_multiplier: scaleMultiplier }
    return undefined
  }, [isResize, resizeState, takesScale, scaleMultiplier])

  const reload = useCallback(() => {
    void load()
  }, [load])

  return {
    tools,
    loading,
    error,
    selectedKey,
    setSelectedKey,
    activeTool,
    needsSource,
    takesScale,
    isResize,
    resizeState,
    patchResize,
    resizeError,
    scaleMultiplier,
    setScaleMultiplier,
    buildOptions,
    reload,
  }
}
