import { useEffect, useRef, useState } from 'react'
import { Expand, Minimize, Pause, Play, Settings2, Sparkles, Star } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { listImgGenCapabilities, type ImgGenCapability } from '@/api/images'
import { listImgUtilsCapabilities, toolKey, toolsFromCapabilities, type ImgUtilTool } from '@/api/imgUtils'
import { recordRecentPrompt, starPrompt } from '@/api/prompts'
import { PromptTextarea } from '@/components/PromptTextarea'
import { SavedPromptsDrawer } from '@/components/prompts/SavedPromptsDrawer'
import { Button } from '@/components/ui/button'
import { WallpaperJobStatus } from '@/components/hallucinate/WallpaperJobStatus'
import { filterCapabilitiesByWorkflow } from '@/lib/imggen'
import { FADE_MS, HALLUCINATE_BUCKET, runWallpaper, wallpaperRequestSignal, WallpaperCleanupError, WALLPAPER_SIZES, isWallpaperJobTerminal, type WallpaperJobProgress } from '@/lib/hallucinate'

export default function HallucinatePage() {
  const { token } = useAuth()
  const [models, setModels] = useState<ImgGenCapability[]>([])
  const [tools, setTools] = useState<ImgUtilTool[]>([])
  const [model, setModel] = useState('')
  const [tool, setTool] = useState('')
  const [prompt, setPrompt] = useState('A dreamlike {color} landscape, intricate detail, cinematic light')
  const [size, setSize] = useState<readonly number[]>([1280, 720])
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
    if (!token || controller.current || !models.some(m => m.base === model) || !prompt.trim()) return
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
        prompt: prompt.trim(), capability: model, width: size[0], height: size[1], scale,
        upscaler: upscale ? upscaler : undefined,
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
      if (mounted.current && (!abort.signal.aborted || e instanceof WallpaperCleanupError)) setError(e instanceof Error ? e.message : String(e))
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
          <label className="block space-y-2 text-sm">Model
            <select aria-label="Model" value={model} disabled={running} onChange={e => setModel(e.target.value)} className="block min-h-11 w-full rounded-md border border-input bg-background px-3">
              {!models.length && <option value="">No txt2img models online</option>}
              {models.map(m => <option key={m.base} value={m.base}>{m.base.replace('imggen.', '')}</option>)}
            </select>
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
          <fieldset disabled={running} className="space-y-3">
            <legend className="mb-3 text-sm">Canvas size</legend>
            {WALLPAPER_SIZES.map(group => <div key={group.ratio} className="flex flex-wrap items-center gap-2">
              <span className="w-12 text-xs text-muted-foreground">{group.ratio}</span>
              {group.sizes.map(([w, h]) => <button key={`${w}x${h}`} type="button" aria-pressed={size[0] === w && size[1] === h} onClick={() => setSize([w, h])} className={`min-h-11 rounded-lg border px-3 text-xs transition-colors ${group.color} ${size[0] === w && size[1] === h ? 'bg-foreground text-background' : 'hover:bg-muted'}`}>{w} × {h}</button>)}
            </div>)}
          </fieldset>
          <div className="space-y-3">
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={upscale} disabled={running || !tools.length} onChange={e => setUpscale(e.target.checked)} /> Upscale before displaying</label>
            {!tools.length && <p className="text-xs text-muted-foreground">No upscaler is currently online.</p>}
            {upscale && <div className="flex flex-wrap gap-3">
              <select aria-label="Upscaler" value={tool} disabled={running} onChange={e => setTool(e.target.value)} className="min-h-11 max-w-full rounded-md border border-input bg-background px-3">{tools.map(t => <option key={toolKey(t)} value={toolKey(t)}>{t.pack} · {t.workflow}</option>)}</select>
              <label className="flex items-center gap-2 text-sm">Scale <select aria-label="Upscale multiplier" value={scale} disabled={running} onChange={e => setScale(Number(e.target.value))} className="min-h-11 rounded-md border border-input bg-background px-3">{[2, 3, 4, 6, 8].map(n => <option key={n} value={n}>×{n}</option>)}</select></label>
            </div>}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button className="min-h-11" onClick={() => void start()} disabled={running || !model || !prompt.trim() || (upscale && !tool)} data-testid="hallucinate-start"><Play className="size-4" /> Start dreaming</Button>
            {running && <Button variant="outline" onClick={stop}>Stop</Button>}
            {!!frames.length && <Button variant="outline" onClick={() => setDisplay(true)}>Return to wallpaper</Button>}
          </div>
          <p className="text-xs text-muted-foreground">Runs while this page is open. Hidden tabs pause new renders. Images are temporary; your prompt library is saved separately.</p>
          {!display && <p role="status" className="text-sm text-muted-foreground">{stage}</p>}
          {!display && error && <p role="alert" className="text-destructive">{error}</p>}
        </section>
      </div>
      {display && <div ref={surface} className="hallucinate-display fixed inset-0 z-50 overflow-hidden bg-black text-white" data-testid="hallucinate-display">
        {frames.map((url, i) => <img key={url} src={url} alt="Live generated wallpaper" className={`absolute inset-0 h-full w-full bg-black object-contain ${i === frames.length - 1 ? 'hallucinate-frame' : ''}`} style={{ animationDuration: `${FADE_MS}ms` }} />)}
        {!frames.length && <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-violet-950 via-black to-cyan-950"><Sparkles className="size-16 animate-pulse text-violet-300" /></div>}
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-4 bg-gradient-to-t from-black/85 to-transparent p-4 pt-16 sm:p-8 sm:pt-20">
          <div className="min-w-0 w-full space-y-3 sm:max-w-lg sm:flex-1">
            <div><p className="font-display text-xl">Hallucinate</p><p role="status" className="text-xs text-white/70">{stage}</p></div>
            {currentJob && <WallpaperJobStatus key={`${currentJob.kind}:${currentJob.submittedAt}`} job={currentJob} active={running} />}
            {error && <p role="alert" className="max-w-xl break-words text-sm text-rose-300">{error}</p>}
          </div>
          <div data-testid="hallucinate-controls" className={`hallucinate-controls flex gap-2 ${running && !error && !controlsVisible ? 'hallucinate-controls-hidden' : ''}`}>
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
