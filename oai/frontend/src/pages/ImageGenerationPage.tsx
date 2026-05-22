import { useEffect, useMemo, useState } from 'react'
import { ImagePlus, Loader2, RefreshCw, Sparkles, Upload, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '../contexts/AuthContext'
import { getSettings } from '../api/admin'
import {
  getImageJob,
  imageFileUrl,
  listImgGenCapabilities,
  listImageJobs,
  pollImageJob,
  startImageJob,
  type ImgGenCapability,
  type ImageJobDetails,
  type PollImageJobResponse,
  type UploadedImage,
  uploadImage,
} from '../api/images'

type Mode = 'txt2img' | 'img2img'

export default function ImageGenerationPage() {
  const { token } = useAuth()
  const [mode, setMode] = useState<Mode>('txt2img')
  const [prompt, setPrompt] = useState('A cinematic portrait of a cyberpunk fox in neon rain')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [capability, setCapability] = useState('imggen.flux')
  const [capabilities, setCapabilities] = useState<ImgGenCapability[]>([])
  const [width, setWidth] = useState(1024)
  const [height, setHeight] = useState(1024)
  const [seed, setSeed] = useState('')
  const [uploadedInput, setUploadedInput] = useState<UploadedImage | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [activePoll, setActivePoll] = useState<PollImageJobResponse | null>(null)
  const [jobs, setJobs] = useState<ImageJobDetails[]>([])
  const [selectedJob, setSelectedJob] = useState<ImageJobDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const canSubmit = useMemo(() => {
    if (!prompt.trim()) return false
    if (!capability.trim().startsWith('imggen.')) return false
    if (mode === 'img2img' && !uploadedInput) return false
    return true
  }, [prompt, capability, mode, uploadedInput])

  useEffect(() => {
    if (!token) return
    ;(async () => {
      try {
        const settings = await getSettings(token)
        if (!settings.client_api_token) {
          setInfo('Admin should configure OffloadMQ client token in Settings -> Server.')
        }
      } catch {
        // non-fatal
      }
      try {
        const list = await listImageJobs(token)
        setJobs(list)
      } catch (e) {
        setError((e as Error).message)
      }
      try {
        const caps = await listImgGenCapabilities(token)
        setCapabilities(caps)
        if (caps.length > 0) {
          setCapability(caps[0].base)
        }
      } catch {
        // non-fatal
      }
    })()
  }, [token])

  async function onUpload(file: File) {
    if (!token) return
    setUploading(true)
    setError(null)
    setInfo('Uploading and normalizing image (EXIF-aware, max 1920px).')
    try {
      const img = await uploadImage(token, file)
      setUploadedInput(img)
      setInfo(`Uploaded ${img.filename} as ${img.width}x${img.height}.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  async function onSubmit() {
    if (!token || !canSubmit) return
    setSubmitting(true)
    setError(null)
    setInfo('Submitting image generation task to OffloadMQ.')
    try {
      const res = await startImageJob(token, {
        capability: capability.trim(),
        prompt: prompt.trim(),
        negative_prompt: negativePrompt.trim() || null,
        width,
        height,
        seed: seed.trim() ? Number(seed) : null,
        workflow: mode,
        input_image_id: uploadedInput?.image_id ?? null,
      })
      setActiveJobId(res.job_id)
      const details = await getImageJob(token, res.job_id)
      setSelectedJob(details)
      setJobs(prev => [details, ...prev.filter(j => j.job_id !== details.job_id)])
      setInfo(`Job ${res.job_id} submitted. Use Poll to update status.`)
      setActivePoll(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function onPoll() {
    if (!token || !activeJobId) return
    setPolling(true)
    setError(null)
    try {
      const poll = await pollImageJob(token, activeJobId)
      setActivePoll(poll)
      const details = await getImageJob(token, activeJobId)
      setSelectedJob(details)
      setJobs(prev => [details, ...prev.filter(j => j.job_id !== details.job_id)])
      setInfo(`Job ${activeJobId}: ${poll.status}${poll.stage ? ` (${poll.stage})` : ''}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPolling(false)
    }
  }

  async function selectJob(jobId: string) {
    if (!token) return
    setActiveJobId(jobId)
    setError(null)
    try {
      const details = await getImageJob(token, jobId)
      setSelectedJob(details)
      setActivePoll(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 gap-6 px-6 py-6" data-testid="image-generation-page">
      <section className="min-w-0 flex-1 space-y-5">
        <div>
          <h1 className="font-display text-2xl font-bold">Image Generation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manual polling workflow with durable pipeline tracking and permanent file storage.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Wand2 className="h-4 w-4" />New Job</CardTitle>
            <CardDescription>Modeled after sandbox apps, adapted for OAI production flow.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button variant={mode === 'txt2img' ? 'default' : 'outline'} size="sm" onClick={() => setMode('txt2img')}>
                <Sparkles className="mr-1 h-3.5 w-3.5" />Txt2Img
              </Button>
              <Button variant={mode === 'img2img' ? 'default' : 'outline'} size="sm" onClick={() => setMode('img2img')}>
                <ImagePlus className="mr-1 h-3.5 w-3.5" />Img2Img
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="capability">Capability</Label>
                {capabilities.length > 0 ? (
                  <select
                    id="capability"
                    value={capability}
                    onChange={e => setCapability(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    data-testid="imggen-capability-select"
                  >
                    {capabilities.map(cap => (
                      <option key={cap.raw} value={cap.base}>
                        {cap.base}
                        {cap.tags.length ? ` [${cap.tags.join(', ')}]` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id="capability"
                    value={capability}
                    onChange={e => setCapability(e.target.value)}
                    placeholder="imggen.flux"
                    data-testid="imggen-capability"
                  />
                )}
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="prompt">Prompt</Label>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  data-testid="imggen-prompt"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="negative-prompt">Negative Prompt</Label>
                <textarea
                  id="negative-prompt"
                  value={negativePrompt}
                  onChange={e => setNegativePrompt(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  data-testid="imggen-negative-prompt"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="width">Width</Label>
                <Input id="width" type="number" value={width} onChange={e => setWidth(Number(e.target.value) || 1024)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="height">Height</Label>
                <Input id="height" type="number" value={height} onChange={e => setHeight(Number(e.target.value) || 1024)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="seed">Seed (optional)</Label>
                <Input id="seed" value={seed} onChange={e => setSeed(e.target.value)} placeholder="empty = random" />
              </div>
            </div>

            {mode === 'img2img' && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <Label>Input Image</Label>
                <div className="flex items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
                    <Upload className="h-4 w-4" />
                    {uploading ? 'Uploading...' : 'Choose image'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      disabled={uploading}
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) void onUpload(file)
                      }}
                      data-testid="imggen-upload-input"
                    />
                  </label>
                  {uploadedInput && (
                    <span className="text-xs text-muted-foreground">
                      {uploadedInput.filename} ({uploadedInput.width}x{uploadedInput.height})
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={onSubmit} disabled={!canSubmit || submitting} data-testid="imggen-submit-job">
                {submitting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                Submit Job
              </Button>
              <Button variant="outline" onClick={onPoll} disabled={!activeJobId || polling} data-testid="imggen-poll-job">
                {polling ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                Poll
              </Button>
            </div>

            {info && <p className="text-xs text-muted-foreground">{info}</p>}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </CardContent>
        </Card>

        {selectedJob && (
          <Card>
            <CardHeader>
              <CardTitle>Job {selectedJob.job_id}</CardTitle>
              <CardDescription>Status: {activePoll?.status ?? selectedJob.status}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!!selectedJob.error && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {selectedJob.error}
                </p>
              )}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Pipeline Timeline</p>
                <div className="rounded-lg border border-border p-3">
                  {selectedJob.events.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No events yet.</p>
                  ) : (
                    <ol className="space-y-2">
                      {selectedJob.events.map((event, idx) => (
                        <li key={`${event.created_at}-${idx}`} className="flex gap-2 text-xs">
                          <div className="mt-1.5 h-2 w-2 rounded-full bg-primary/70" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium">{event.step}</span>
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                {event.state}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                {new Date(event.created_at).toLocaleString()}
                              </span>
                            </div>
                            {event.details && <p className="mt-0.5 text-muted-foreground">{event.details}</p>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {selectedJob.files.filter(f => f.direction === 'output').map(file => (
                  <a
                    key={file.image_id}
                    href={imageFileUrl(file.image_id)}
                    target="_blank"
                    rel="noreferrer"
                    className="group overflow-hidden rounded-lg border border-border"
                  >
                    <img
                      src={imageFileUrl(file.image_id)}
                      alt={file.filename}
                      className="h-52 w-full object-cover transition-transform group-hover:scale-[1.02]"
                    />
                    <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                      {file.filename} - {file.width}x{file.height}
                    </div>
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      <aside className="w-full max-w-sm space-y-4" data-testid="imggen-jobs-sidebar">
        <Card>
          <CardHeader>
            <CardTitle>Recent Jobs</CardTitle>
            <CardDescription>Select a job to inspect full pipeline state.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {jobs.length === 0 && <p className="text-xs text-muted-foreground">No jobs yet.</p>}
            {jobs.map(job => (
              <button
                key={job.job_id}
                onClick={() => void selectJob(job.job_id)}
                className="w-full rounded-md border border-border px-3 py-2 text-left text-xs hover:bg-muted"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{job.prompt}</span>
                  <span className="shrink-0 text-muted-foreground">{job.status}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{job.job_id}</div>
              </button>
            ))}
          </CardContent>
        </Card>
      </aside>
    </main>
  )
}
