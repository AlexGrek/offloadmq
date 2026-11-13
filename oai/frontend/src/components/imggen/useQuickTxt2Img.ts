import { useCallback, useEffect, useMemo, useState } from 'react'
import { listImgGenCapabilities, startImageJob, type ImgGenCapability } from '../../api/images'
import { recordRecentPrompt } from '../../api/prompts'
import { useProgress } from '../../contexts/ProgressContext'
import { isListedCapability } from '../../lib/capability-picker'
import type { CapabilitiesStatus } from '../../lib/capabilitiesStatus'
import { filterCapabilitiesByWorkflow } from '../../lib/imggen'
import { sortCapabilitiesForPicker } from '../../lib/modelAvailability'

export const MAX_QUICK_GENERATE = 10

export function clampGenerateCount(raw: string | number): number {
  const count = typeof raw === 'number' ? raw : parseInt(raw, 10)
  if (!Number.isFinite(count)) return 1
  return Math.min(MAX_QUICK_GENERATE, Math.max(1, Math.trunc(count)))
}

/**
 * Quick txt2img from anywhere (Describe Image result, Prompt Studio): loads the txt2img
 * models while `enabled`, picks the first online one, and starts N independent jobs that
 * show up in Progress — the user stays on the current page.
 */
export function useQuickTxt2Img(token: string, enabled: boolean) {
  const { refreshRunningImageJobs } = useProgress()
  const [allCapabilities, setAllCapabilities] = useState<ImgGenCapability[]>([])
  const [status, setStatus] = useState<CapabilitiesStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [capability, setCapability] = useState('')

  const capabilities = useMemo(
    () => sortCapabilitiesForPicker(filterCapabilitiesByWorkflow(allCapabilities, 'txt2img')),
    [allCapabilities],
  )

  const onLoaded = useCallback((listed: ImgGenCapability[]) => {
    const eligible = filterCapabilitiesByWorkflow(listed, 'txt2img')
    setAllCapabilities(listed)
    setCapability(prev =>
      eligible.some(cap => cap.base === prev)
        ? prev
        : eligible.find(cap => cap.online)?.base ?? eligible[0]?.base ?? '',
    )
    setStatus('ready')
  }, [])

  const onError = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : 'Failed to load models')
    setStatus('error')
  }, [])

  useEffect(() => {
    if (!enabled) return
    let current = true
    void listImgGenCapabilities(token)
      .then(listed => { if (current) onLoaded(listed) })
      .catch(e => { if (current) onError(e) })
    return () => { current = false }
  }, [enabled, token, onLoaded, onError])

  const refresh = useCallback(() => {
    setStatus('loading')
    setError(null)
    void listImgGenCapabilities(token).then(onLoaded).catch(onError)
  }, [token, onLoaded, onError])

  const ready = status === 'ready' && isListedCapability(capability, capabilities)

  /** Starts `count` txt2img jobs; throws on the first failed submit. Returns started job ids. */
  const generate = useCallback(
    async ({ prompt, width, height, count }: { prompt: string; width: number; height: number; count: number }) => {
      const text = prompt.trim()
      const ids: string[] = []
      for (let index = 0; index < clampGenerateCount(count); index += 1) {
        const started = await startImageJob(token, {
          capability,
          prompt: text,
          prompt_template: text,
          width,
          height,
          workflow: 'txt2img',
          override_negative: false,
        })
        ids.push(started.job_id)
      }
      void recordRecentPrompt(token, 'imggen-prompt', text).catch(() => {})
      void refreshRunningImageJobs()
      return ids
    },
    [token, capability, refreshRunningImageJobs],
  )

  return { capabilities, status, error, capability, setCapability, refresh, ready, generate }
}
