import { ImageSizePicker } from '@/components/ImageSizePicker'
import { rememberedImageSize, validImageSize } from '@/lib/imageSizes'
import { useWsChat } from '@/hooks/useWsChat'
import { useDefaultPrompts } from '@/hooks/useDefaultPrompts'
import { PROMPT_STUDIO_SYSTEM_BUCKET, PROMPT_STUDIO_TEMPLATE_BUCKET } from '@/lib/promptStudio'
import { useEffect, useRef, useState } from 'react'
import { Expand, Minimize, Pause, Play, Settings2, Sparkles, Star } from 'lucide-react'
import { useAdminStatus } from '@/hooks/useAdminStatus'
import { useAuth } from '@/contexts/AuthContext'
import { listImgGenCapabilities, type ImgGenCapability } from '@/api/images'
import { listImgUtilsCapabilities, toolKey, toolsFromCapabilities, type ImgUtilTool } from '@/api/imgUtils'
import { recordRecentPrompt, starPrompt } from '@/api/prompts'
import { PromptTextarea } from '@/components/PromptTextarea'
import { SavedPromptsDrawer } from '@/components/prompts/SavedPromptsDrawer'
import { Button } from '@/components/ui/button'
import { WallpaperJobStatus } from '@/components/hallucinate/WallpaperJobStatus'
import { filterCapabilitiesByWorkflow } from '@/lib/imggen'
import { FADE_MS, HALLUCINATE_BUCKET, runWallpaper, wallpaperRequestSignal, WallpaperCancellationError, isWallpaperJobTerminal, type WallpaperJobProgress } from '@/lib/hallucinate'

export default function HallucinatePage() {
  const { token } = useAuth()
  const { isAdmin } = useAdminStatus()
  const defaults = useDefaultPrompts()
  const [mode, setMode] = useState<'direct' | 'studio'>('direct')
  const ws = useWsChat(mode === 'studio' ? token : null)
  const [llm, setLlm] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(defaults.prompt_studio_system)
  const [template, setTemplate] = useState(defaults.prompt_studio_template)
  const onlineLlms = ws.capabilities.filter(c => c.online)
  const selectedLlm = onlineLlms.some(c => c.base === llm) ? llm : onlineLlms[0]?.base ?? ''
  const studioReady = mode === 'direct' || (ws.status === 'connected' && ws.capabilitiesStatus === 'ready' && !!selectedLlm && !!systemPrompt.trim() && !!template.trim())
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [models, setModels] = useState<ImgGenCapability[]>([])
  const [tools, setTools] = useState<ImgUtilTool[]>([])
  const [model, setModel] = useState('')
  const [tool, setTool] = useState('')
  const [prompt, setPrompt] = useState('A dreamlike {color} landscape, intricate detail, cinematic light')
  const [size, setSize] = useState<readonly number[]>(() => rememberedImageSize([1280, 720]))
  const [upscale, setUpscale] = useState(false)
  const [scale, setScale] = useState(2)
  const [running, setRunning] = useState(false)
  const [display, setDisplay] = useState(false)
  const [stage, setStage] = useState('Ready to dream')
  const [currentJob, setCurrentJob] = useState<WallpaperJobProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [frames, setFrames] = useState<string[]>([])
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const controller = useRef<AbortController | null>(null)
  const urls = useRef<string[]>([])
  const mounted = useRef(false)
  const surface = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mounted.current = true
    const stop = () => controller.current?.abort()
    window.addEventListener('pagehide', stop)
    return () => {
      mounted.current = false
      stop()
      window.removeEventListener('pagehide', stop)
      urls.current.forEach(url => URL.revokeObjectURL(url))
      urls.current = []
    }
  }, [])

  useEffect(() => {
    if (!token) return
    let stale = false
    listImgGenCapabilities(token).then(caps => {
      if (stale) return
      const available = filterCapabilitiesByWorkflow(caps, 'txt2img').filter(c => c.online)
      setModels(available)
      setModel(available[0]?.base ?? '')
    }).catch(e => { if (!stale) setError(String(e)) })
    listImgUtilsCapabilities(token).then(result => {
      if (stale) return
      const upscalers = toolsFromCapabilities(result.capabilities).filter(t => t.takesScale && !t.needsSourceImage)
      setTools(upscalers)
      setTool(upscalers[0] ? toolKey(upscalers[0]) : '')
    }).catch(e => { if (!stale) setError(String(e)) })
    return () => { stale = true }
  }, [token])

  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])

  useEffect(() => {
    if (!display || !running) return
    let timer = setTimeout(() => setControlsVisible(false), 4000)
    const reveal = () => {
      setControlsVisible(true)
      clearTimeout(timer)
      timer = setTimeout(() => setControlsVisible(false), 4000)
    }
    window.addEventListener('pointermove', reveal)
    window.addEventListener('pointerdown', reveal)
    window.addEventListener('keydown', reveal)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', reveal)
      window.removeEventListener('pointerdown', reveal)
      window.removeEventListener('keydown', reveal)
    }
  }, [display, running])

  async function start() {
    if (!validImageSize(size[0], size[1]) || !studioReady || !token || controller.current || !models.some(m => m.base === model) || !prompt.trim()) return
    const upscaler = tools.find(t => toolKey(t) === tool)
    if (upscale && !upscaler) return
    const abort = new AbortController()
    controller.current = abort
    setRunning(true)
    setDisplay(true)
    setControlsVisible(true)
    setError(null)
    setCurrentJob(null)
    try {
      await recordRecentPrompt(token, HALLUCINATE_BUCKET, prompt.trim(), wallpaperRequestSignal(abort.signal))
      await runWallpaper(token, {
        studio: mode === 'studio' ? { capability: selectedLlm, systemPrompt: systemPrompt.trim(), template: template.trim() } : undefined,
        prompt: prompt.trim(), capability: model, width: size[0], height: size[1], scale,
        upscaler: upscale ? upscaler : undefined,
        priority: priority === 'high' && !isAdmin ? 'normal' : priority,
      }, abort.signal, next => { if (mounted.current) setStage(next) }, url => {
        if (!mounted.current || abort.signal.aborted) { URL.revokeObjectURL(url); return }
        const previous = urls.current
        urls.current = [...previous.slice(-1), url]
        previous.slice(0, -1).forEach(old => URL.revokeObjectURL(old))
        setFrames(urls.current)
      }, job => {
        if (mounted.current) setCurrentJob(job && abort.signal.aborted && !isWallpaperJobTerminal(job.status)
          ? { ...job, status: 'cancelRequested' } : job)
      })
    } catch (e) {
      if (mounted.current && (!abort.signal.aborted || e instanceof WallpaperCancellationError)) setError(e instanceof Error ? e.message : String(e))
    } finally {
      controller.current = null
      if (mounted.current) { setRunning(false); setStage('Paused') }
    }
  }

  function stop() {
    if (!controller.current) return
    controller.current.abort()
    setStage('Stopping…')
    setCurrentJob(job => job && !isWallpaperJobTerminal(job.status) ? { ...job, status: 'cancelRequested' } : job)
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await surface.current?.requestFullscreen()
    } catch { setError('Browser fullscreen is unavailable. The wallpaper still fills this window.') }
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="hallucinate-page">
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-8">
        <header className="space-y-3">
          <Sparkles className="size-8 text-violet-400" />
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">An endless daydream</p>
          <h1 className="font-display text-4xl sm:text-6xl">Hallucinate</h1>
          <p className="max-w-xl text-muted-foreground">One idea. Infinite variations. Turn your screen into a living wallpaper, one new image at a time.</p>
        </header>
        <section className="space-y-5" aria-label="Wallpaper settings">
          <label className="block space-y-2 text-sm">Mode
            <select aria-label="Mode" data-testid="hallucinate-mode" value={mode} disabled={running} onChange={e => setMode(e.target.value as typeof mode)} className="block min-h-11 w-full rounded-md border border-input bg-background px-3">
              <option value="direct">Prompt variations</option>
              <option value="studio">Prompt Studio → image</option>
            </select>
            <span className="block text-xs text-muted-foreground">{mode === 'studio' ? 'An LLM creates a fresh prompt before every image. The slideshow and upscaling work as usual.' : 'Render your prompt directly, with fresh substitutions for every image.'}</span>
          </label>
          {mode === 'studio' && <fieldset disabled={running} className="min-w-0 space-y-4" data-testid="hallucinate-studio-settings">
            <legend className="sr-only">Prompt generation</legend>
            <label className="block space-y-2 text-sm">Prompt model
              <select aria-label="Prompt model" data-testid="hallucinate-prompt-model" value={selectedLlm} onChange={e => setLlm(e.target.value)} className="block min-h-11 w-full rounded-md border border-input bg-background px-3">
                {!onlineLlms.length && <option value="">No LLM models online</option>}
                {onlineLlms.map(m => <option key={m.base} value={m.base}>{m.base.replace('llm.', '')}</option>)}
              </select>
            </label>
            {ws.capabilitiesError && <p role="alert" className="text-sm text-destructive">{ws.capabilitiesError}</p>}
            <Button variant="ghost" onClick={ws.refreshCapabilities} disabled={running || ws.status !== 'connected'}>Refresh prompt models</Button>
            <div className="space-y-2">
              <label htmlFor="hallucinate-system" className="text-sm">System prompt</label>
              <PromptTextarea id="hallucinate-system" data-testid="hallucinate-system" token={token} bucket={PROMPT_STUDIO_SYSTEM_BUCKET} value={systemPrompt} onChange={setSystemPrompt} disabled={running} rows={4} />
              <Button variant="ghost" onClick={() => setSystemPrompt(defaults.prompt_studio_system)}>Reset system prompt</Button>
            </div>
            <div className="space-y-2">
              <label htmlFor="hallucinate-template" className="text-sm">Message template</label>
              <PromptTextarea id="hallucinate-template" data-testid="hallucinate-template" token={token} bucket={PROMPT_STUDIO_TEMPLATE_BUCKET} value={template} onChange={setTemplate} disabled={running} rows={3} />
              <p className="text-xs text-muted-foreground">{'{prompt}'} is replaced with your recurring dream below. Each image starts with a new LLM turn in the same Prompt Studio conversation.</p>
              <Button variant="ghost" onClick={() => setTemplate(defaults.prompt_studio_template)}>Reset message template</Button>
            </div>
          </fieldset>}
          <label className="block space-y-2 text-sm">Model
            <select aria-label="Model" value={model} disabled={running} onChange={e => setModel(e.target.value)} className="block min-h-11 w-full rounded-md border border-input bg-background px-3">
              {!models.length && <option value="">No txt2img models online</option>}
              {models.map(m => <option key={m.base} value={m.base}>{m.base.replace('imggen.', '')}</option>)}
            </select>
          </label>
          <label className="block space-y-2 text-sm">Priority
            <select aria-label="Priority" data-testid="hallucinate-priority" value={priority} disabled={running} onChange={e => setPriority(e.target.value as typeof priority)} className="block min-h-11 w-full rounded-md border border-input bg-background px-3">
              <option value="low">Low</option>
              <option value="normal">Normal (default)</option>
              {isAdmin && <option value="high">High</option>}
            </select>
            <span className="block text-xs text-muted-foreground">Applies to generation and upscaling. High priority is available to admins.</span>
          </label>
          <div className="space-y-2">
            <label htmlFor="hallucinate-prompt" className="text-sm">Your recurring dream</label>
            <PromptTextarea id="hallucinate-prompt" value={prompt} onChange={setPrompt} bucket={HALLUCINATE_BUCKET} token={token} disabled={running} rows={5} data-testid="hallucinate-prompt" />
            <p className="text-xs text-muted-foreground">Use {'{color}'}, {'{animal}'}, {'{?}'} or your custom placeholders. Substitutions and the seed change with every image.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" disabled={running || !token || !prompt.trim()} onClick={() => { if (token) void starPrompt(token, HALLUCINATE_BUCKET, prompt).then(() => setStage('Prompt starred')).catch(e => setError(String(e))) }}><Star className="size-4" /> Star prompt</Button>
              <Button variant="ghost" disabled={running} onClick={() => setImportOpen(true)} data-testid="hallucinate-import">Import from txt2img</Button>
            </div>
          </div>
          <ImageSizePicker width={size[0]} height={size[1]} disabled={running} testIdPrefix="hallucinate" onChange={setSize} onWidthChange={v => setSize([Number(v), size[1]])} onHeightChange={v => setSize([size[0], Number(v)])} />
          <div className="space-y-3">
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={upscale} disabled={running || !tools.length} onChange={e => setUpscale(e.target.checked)} /> Upscale before displaying</label>
            {!tools.length && <p className="text-xs text-muted-foreground">No upscaler is currently online.</p>}
            {upscale && <div className="flex flex-wrap gap-3">
              <select aria-label="Upscaler" value={tool} disabled={running} onChange={e => setTool(e.target.value)} className="min-h-11 max-w-full rounded-md border border-input bg-background px-3">{tools.map(t => <option key={toolKey(t)} value={toolKey(t)}>{t.pack} · {t.workflow}</option>)}</select>
              <label className="flex items-center gap-2 text-sm">Scale <select aria-label="Upscale multiplier" value={scale} disabled={running} onChange={e => setScale(Number(e.target.value))} className="min-h-11 rounded-md border border-input bg-background px-3">{[2, 3, 4, 6, 8].map(n => <option key={n} value={n}>×{n}</option>)}</select></label>
            </div>}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button className="min-h-11" onClick={() => void start()} disabled={running || !validImageSize(size[0], size[1]) || !studioReady || !model || !prompt.trim() || (upscale && !tool)} data-testid="hallucinate-start"><Play className="size-4" /> Start dreaming</Button>
            {running && <Button variant="outline" onClick={stop}>Stop</Button>}
            {!!frames.length && <Button variant="outline" onClick={() => setDisplay(true)}>Return to wallpaper</Button>}
          </div>
          <p className="text-xs text-muted-foreground">Runs while this page is open. Hidden tabs pause new renders. Images are saved in Image Generation and Image Tools history.</p>
          {!display && <p role="status" className="text-sm text-muted-foreground">{stage}</p>}
          {!display && error && <p role="alert" className="text-destructive">{error}</p>}
        </section>
      </div>
      {display && <div ref={surface} className="hallucinate-display fixed inset-0 z-50 overflow-hidden bg-black text-white" data-testid="hallucinate-display">
        {frames.map((url, i) => <img key={url} src={url} alt="Live generated wallpaper" className={`absolute inset-0 h-full w-full bg-black object-contain ${i === frames.length - 1 ? 'hallucinate-frame' : ''}`} style={{ animationDuration: `${FADE_MS}ms` }} />)}
        {!frames.length && <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-violet-950 via-black to-cyan-950"><Sparkles className="size-16 animate-pulse text-violet-300" /></div>}
        <div data-testid="hallucinate-controls" className={`hallucinate-controls absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-4 bg-gradient-to-t from-black/85 to-transparent p-4 pt-16 sm:p-8 sm:pt-20 ${running && !error && !controlsVisible ? 'hallucinate-controls-hidden' : ''}`}>
          <div className="min-w-0 w-full space-y-3 sm:max-w-lg sm:flex-1">
            <div><p className="font-display text-xl">Hallucinate</p><p role="status" className="text-xs text-white/70">{stage}</p></div>
            {currentJob && <WallpaperJobStatus key={`${currentJob.kind}:${currentJob.submittedAt}`} job={currentJob} active={running} />}
            {error && <p role="alert" className="max-w-xl break-words text-sm text-rose-300">{error}</p>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={running ? stop : () => void start()} disabled={stage === 'Stopping…'} aria-label={running ? 'Pause wallpaper' : 'Resume wallpaper'} data-testid="hallucinate-pause">{running ? <Pause /> : <Play />}</Button>
            <Button variant="secondary" aria-label="Wallpaper settings" onClick={() => { stop(); setDisplay(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}) }}><Settings2 /></Button>
            <Button variant="secondary" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? 'Exit browser fullscreen' : 'Enter browser fullscreen'}>{fullscreen ? <Minimize /> : <Expand />}</Button>
          </div>
        </div>
      </div>}
      <SavedPromptsDrawer open={importOpen} onOpenChange={setImportOpen} bucket="imggen-prompt" token={token} value="" previews onPick={content => { setPrompt(content); if (token) void recordRecentPrompt(token, HALLUCINATE_BUCKET, content).catch(e => setError(String(e))) }} />
    </main>
  )
}
