import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Square, Volume2 } from 'lucide-react'
import {
  listTtsCapabilities,
  pollTtsJob,
  startTtsJob,
  ttsAudioUrl,
  type TtsCapability,
} from '../api/tts'
import { useAuth } from '../contexts/AuthContext'
import { pickListedCapability } from '../lib/capability-picker'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Label } from './ui/label'

const VOICE_STORAGE_KEY = 'oai-tts-voice'
const CAPABILITY_STORAGE_KEY = 'oai-tts-capability'
const DEFAULT_CAPABILITY = 'tts.kokoro'
const POLL_MS = 1500

type SpeechListenWidgetProps = {
  text: string
  disabled?: boolean
  testIdPrefix?: string
  className?: string
  /** `inline` matches chat copy-link row; `ghost` matches describe result header buttons. */
  triggerVariant?: 'inline' | 'ghost'
}

function pickDefaultCapability(caps: TtsCapability[]): string {
  const stored = localStorage.getItem(CAPABILITY_STORAGE_KEY) ?? ''
  const fromList = pickListedCapability(stored, caps)
  if (fromList) return fromList
  const kokoro = caps.find(c => c.base === DEFAULT_CAPABILITY)
  if (kokoro) return kokoro.base
  return caps[0]?.base ?? ''
}

async function waitForTtsCompletion(
  token: string,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const job = await pollTtsJob(token, jobId)
    if (job.status === 'completed') return
    if (job.status === 'failed') {
      throw new Error(job.error?.trim() || 'Speech synthesis failed')
    }
    if (job.status === 'canceled') {
      throw new Error('Speech synthesis canceled')
    }
    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(resolve, POLL_MS)
      signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(t)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    })
  }
  throw new DOMException('Aborted', 'AbortError')
}

/** Compact read-aloud control: speaker trigger opens a popup with voice + play (OAI TTS API). */
export function SpeechListenWidget({
  text,
  disabled = false,
  testIdPrefix = 'speech-listen',
  className,
  triggerVariant = 'inline',
}: SpeechListenWidgetProps) {
  const { token } = useAuth()
  const rootRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const [open, setOpen] = useState(false)
  const [capabilities, setCapabilities] = useState<TtsCapability[]>([])
  const [capsLoading, setCapsLoading] = useState(false)
  const [capsChecked, setCapsChecked] = useState(false)
  const [capsError, setCapsError] = useState<string | null>(null)
  const [capability, setCapability] = useState('')
  const [voice, setVoice] = useState(() => localStorage.getItem(VOICE_STORAGE_KEY) ?? '')
  const [isLoading, setIsLoading] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedText = text.trim()
  const voices = useMemo(() => {
    const cap = capabilities.find(c => c.base === capability)
    return cap?.voices ?? []
  }, [capabilities, capability])

  const ttsOnline = capabilities.length > 0
  const unavailable = capsChecked && !ttsOnline && !capsLoading && !capsError
  const triggerTitle =
    capsLoading && open
      ? 'Checking TTS availability…'
      : unavailable
        ? 'No TTS agent online'
        : 'Read aloud'

  const stopPlayback = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }
    setIsPlaying(false)
    setIsLoading(false)
  }, [])

  // Re-check OffloadMQ TTS availability every time the popover opens.
  useEffect(() => {
    if (!open || !token) return
    let active = true
    setCapsLoading(true)
    setCapsError(null)
    setError(null)
    setCapabilities([])
    setCapability('')

    void listTtsCapabilities(token)
      .then(res => {
        if (!active) return
        const online = res.capabilities.filter(c => c.online)
        setCapabilities(online)
        const picked = pickDefaultCapability(online)
        setCapability(picked)
        if (!picked) setVoice('')
      })
      .catch(err => {
        if (!active) return
        setCapabilities([])
        setCapability('')
        setCapsError((err as Error).message)
      })
      .finally(() => {
        if (active) {
          setCapsLoading(false)
          setCapsChecked(true)
        }
      })

    return () => {
      active = false
    }
  }, [open, token])

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  useEffect(() => {
    if (voices.length > 0 && !voices.includes(voice)) {
      setVoice(voices[0])
    }
  }, [voices, voice])

  useEffect(() => {
    if (capability) localStorage.setItem(CAPABILITY_STORAGE_KEY, capability)
  }, [capability])

  useEffect(() => {
    if (voice) localStorage.setItem(VOICE_STORAGE_KEY, voice)
  }, [voice])

  useEffect(() => () => {
    stopPlayback()
  }, [stopPlayback])

  useEffect(() => {
    if (!open) stopPlayback()
  }, [open, stopPlayback])

  const handlePlay = async () => {
    if (isPlaying) {
      stopPlayback()
      return
    }
    if (!token) {
      setError('Not signed in')
      return
    }
    if (!trimmedText) {
      setError('No text to speak')
      return
    }
    if (!capability || !voice) {
      setError(unavailable ? 'No TTS models online' : 'Pick a voice')
      return
    }

    setError(null)
    setIsLoading(true)
    const ac = new AbortController()
    abortRef.current = ac

    try {
      const { job_id: jobId } = await startTtsJob(token, {
        capability,
        voice,
        text: trimmedText,
      })
      await waitForTtsCompletion(token, jobId, ac.signal)
      if (ac.signal.aborted) return

      abortRef.current = null
      const url = ttsAudioUrl(jobId, token)
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        setIsPlaying(false)
        audioRef.current = null
      }
      audio.onerror = () => {
        setError('Audio playback failed')
        setIsPlaying(false)
        audioRef.current = null
      }
      setIsLoading(false)
      setIsPlaying(true)
      await audio.play()
    } catch (err) {
      abortRef.current = null
      if ((err as Error).name === 'AbortError') return
      setError((err as Error).message || 'Request failed')
      setIsLoading(false)
      setIsPlaying(false)
    }
  }

  const btnDisabled =
    disabled ||
    !token ||
    !trimmedText ||
    capsLoading ||
    unavailable ||
    !voice ||
    (isLoading && !isPlaying)

  const triggerLabel = isLoading ? 'Generating…' : isPlaying ? 'Stop' : 'Listen'

  const trigger =
    triggerVariant === 'ghost' ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => setOpen(v => !v)}
        disabled={disabled || !trimmedText}
        data-testid={`${testIdPrefix}-trigger`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={triggerTitle}
      >
        <Volume2 className="size-3.5" />
        Listen
      </Button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={disabled || !trimmedText}
        data-testid={`${testIdPrefix}-trigger`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Read aloud"
        title={triggerTitle}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-45"
      >
        <Volume2 className="size-3" />
        Listen
      </button>
    )

  return (
    <div ref={rootRef} className={cn('relative', className)} data-testid={testIdPrefix}>
      {trigger}
      {open && (
        <div
          role="dialog"
          aria-label="Read aloud"
          data-testid={`${testIdPrefix}-popover`}
          className="absolute bottom-full left-0 z-50 mb-1 w-[min(16rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-3 shadow-md"
        >
          <p className="mb-2 text-xs font-medium text-foreground">Read aloud</p>
          {capsLoading && (
            <p
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid={`${testIdPrefix}-checking`}
            >
              <Loader2 className="size-3.5 animate-spin" />
              Checking TTS availability…
            </p>
          )}
          {capsError && (
            <p className="text-xs text-destructive">{capsError}</p>
          )}
          {unavailable && (
            <p className="text-xs text-muted-foreground" data-testid={`${testIdPrefix}-offline`}>
              No TTS agent online. Start a <code className="text-[10px]">tts.*</code> agent (e.g.
              kokoro) and ensure it is connected to OffloadMQ.
            </p>
          )}
          {!capsLoading && capabilities.length > 0 && (
            <div className="space-y-2">
              {capabilities.length > 1 && (
                <div className="space-y-1">
                  <Label htmlFor={`${testIdPrefix}-model`} className="text-xs text-muted-foreground">
                    Model
                  </Label>
                  <select
                    id={`${testIdPrefix}-model`}
                    value={capability}
                    onChange={e => setCapability(e.target.value)}
                    disabled={isLoading || isPlaying}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    data-testid={`${testIdPrefix}-model`}
                  >
                    {capabilities.map(c => (
                      <option key={c.base} value={c.base}>
                        {c.base.replace(/^tts\./, '')}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor={`${testIdPrefix}-voice`} className="text-xs text-muted-foreground">
                  Voice
                </Label>
                <select
                  id={`${testIdPrefix}-voice`}
                  value={voice}
                  onChange={e => setVoice(e.target.value)}
                  disabled={isLoading || isPlaying || voices.length === 0}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  data-testid={`${testIdPrefix}-voice`}
                >
                  {voices.length === 0 && <option value="">(no voices)</option>}
                  {voices.map(v => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant={isPlaying ? 'destructive' : 'default'}
                  className="h-8 gap-1.5"
                  onClick={() => void handlePlay()}
                  disabled={btnDisabled && !isPlaying}
                  data-testid={`${testIdPrefix}-play`}
                  title={
                    unavailable
                      ? 'No TTS capability online'
                      : isLoading
                        ? 'Generating audio…'
                        : isPlaying
                          ? 'Stop playback'
                          : 'Play speech'
                  }
                >
                  {isLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : isPlaying ? (
                    <Square className="size-3.5" fill="currentColor" />
                  ) : (
                    <Volume2 className="size-3.5" />
                  )}
                  {triggerLabel}
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p className="mt-2 text-xs text-destructive" data-testid={`${testIdPrefix}-error`}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
