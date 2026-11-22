import { useEffect, useState } from 'react'
import { ImagePlus, Loader2, Star } from 'lucide-react'
import { imageFileUrl, pollImageJob, type ImageRef, type PollImageJobResponse } from '../../api/images'
import {
  DEFAULT_SCALE_MULTIPLIER,
  listImgUtilsCapabilities,
  prettyLabel,
  toolKey,
  toolsFromCapabilities,
  type ImgUtilTool,
} from '../../api/imgUtils'
import { useProgress } from '../../contexts/ProgressContext'
import { useReverseSubstitutions } from '../../hooks/useReverseSubstitutions'
import { IMAGE_SIZE_PRESETS, rememberedImageSize, type ImageSize } from '../../lib/imageSizes'
import { imageJobStatusLabel } from '../../lib/imggen'
import { IMGGEN_PROMPT_BUCKET } from '../../lib/promptStudio'
import { ImageSizePicker } from '../ImageSizePicker'
import { JobErrorBanner } from '../JobErrorBanner'
import { PromptTextarea } from '../PromptTextarea'
import { ImgGenModelPicker } from '../imggen/ImgGenModelPicker'
import { JobProgressBar } from '../imggen/JobProgressBar'
import { RecentPlaceholders } from '../imggen/RecentPlaceholders'
import { ReverseSubstitutionsButton } from '../imggen/ReverseSubstitutionsButton'
import { useQuickTxt2Img } from '../imggen/useQuickTxt2Img'
import { SavedPromptsDrawer } from '../prompts/SavedPromptsDrawer'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog'
import { Label } from '../ui/label'

const SIZE_PRESETS = IMAGE_SIZE_PRESETS.filter(([w, h]) => w * 3 === h * 2)
const DEFAULT_SIZE: ImageSize = [1024, 1536]
const SIZE_STORAGE_KEY = 'oai_world_picture_size'
const POLL_MS = 5000
const UPSCALE_SCALES = [1.5, 2, 3] as const
const selectClass = 'min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm'

export function WorldImageGenerator({ token, disabled, onPick }: {
  token: string
  disabled: boolean
  onPick: (picture: ImageRef) => void
}) {
  const [open, setOpen] = useState(false)
  const [starredOpen, setStarredOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<ImageSize>(() => {
    const [width, height] = rememberedImageSize(DEFAULT_SIZE, 8192, 1, SIZE_STORAGE_KEY)
    return SIZE_PRESETS.find(([w, h]) => w === width && h === height) ?? DEFAULT_SIZE
  })
  const [upscaleEnabled, setUpscaleEnabled] = useState(false)
  const [scale, setScale] = useState(DEFAULT_SCALE_MULTIPLIER)
  const [upscalers, setUpscalers] = useState<ImgUtilTool[]>([])
  const [upscalerKey, setUpscalerKey] = useState('')
  const [loadingUpscalers, setLoadingUpscalers] = useState(false)
  const [upscalerError, setUpscalerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState<PollImageJobResponse | null>(null)
  const [picture, setPicture] = useState<ImageRef | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { setForegroundJob } = useProgress()
  const models = useQuickTxt2Img(token, open && !jobId && !picture)
  const reverse = useReverseSubstitutions(token, prompt, setPrompt)
  const upscaler = upscalers.find(tool => toolKey(tool) === upscalerKey)
  const upscale = upscaleEnabled && upscaler
    ? { capability: upscaler.capability, workflow: upscaler.workflow, scale }
    : undefined
  const canGenerate = models.ready && Boolean(prompt.trim()) && !reverse.busy && !submitting && !jobId
    && (!upscaleEnabled || (Boolean(upscale) && !loadingUpscalers && !upscalerError))

  async function loadUpscalers() {
    if (loadingUpscalers) return
    setLoadingUpscalers(true)
    setUpscalerError(null)
    try {
      const { capabilities } = await listImgUtilsCapabilities(token)
      const tools = toolsFromCapabilities(capabilities).filter(tool => tool.takesScale)
      setUpscalers(tools)
      setUpscalerKey(previous => tools.some(tool => toolKey(tool) === previous)
        ? previous
        : tools[0] ? toolKey(tools[0]) : '')
    } catch (e) {
      setUpscalerError((e as Error).message)
    } finally {
      setLoadingUpscalers(false)
    }
  }

  useEffect(() => {
    if (!open || !jobId) return
    const controller = new AbortController()
    let timer: number | undefined
    setForegroundJob('image', jobId)

    async function poll(id: string) {
      try {
        const result = await pollImageJob(token, id, controller.signal)
        if (controller.signal.aborted) return
        setError(null)
        if (result.status === 'completed' || result.status === 'failed' || result.status === 'canceled') {
          const output = result.status === 'completed' ? result.output_images.at(-1) : undefined
          setJobId(null)
          setProgress(null)
          if (output) {
            setPicture(output)
          } else {
            const fallback = result.status === 'completed'
              ? 'The image job finished without a picture.'
              : `Image generation ${result.status}.`
            setError(result.error || fallback)
          }
          return
        }
        setProgress(result)
      } catch (e) {
        if (controller.signal.aborted) return
        setError((e as Error).message)
      }
      timer = window.setTimeout(() => void poll(id), POLL_MS)
    }

    void poll(jobId)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      setForegroundJob('image', null)
    }
  }, [jobId, open, setForegroundJob, token])

  async function generate() {
    if (!canGenerate) return
    setSubmitting(true)
    setError(null)
    try {
      const [id] = await models.generate({ prompt, width: size[0], height: size[1], count: 1, upscale })
      setJobId(id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  function usePicture() {
    if (!picture || disabled) return
    onPick(picture)
    setPicture(null)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!submitting) setOpen(next) }}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="min-h-11 w-full sm:w-auto"
          data-testid="worlds-generate-open"
        >
          <ImagePlus className="size-4" />
          {jobId ? 'View image generation' : picture ? 'View generated picture' : 'Generate picture'}
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="worlds-generate-dialog" showClose={!submitting}>
        <DialogHeader>
          <DialogTitle>Generate world picture</DialogTitle>
          <DialogDescription>Generate a 2:3 source picture for your world.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {picture ? (
            <img
              src={imageFileUrl(picture.image_id, token)}
              alt="Generated world picture"
              className="mx-auto max-h-[48dvh] rounded-lg object-contain"
              data-testid="worlds-generated-picture"
            />
          ) : jobId ? (
            <div role="status" data-testid="worlds-generate-progress">
              <JobProgressBar
                status={progress?.status ?? 'submitted'}
                stage={progress?.stage}
                startedAt={progress?.started_at}
                typicalRuntimeSeconds={progress?.typical_runtime_seconds}
                submittedAt={progress?.submitted_at}
                label={imageJobStatusLabel(progress?.status ?? 'submitted')}
              />
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-x-2">
                  <div className="flex items-center gap-1">
                    <Label htmlFor="worlds-prompt">Prompt</Label>
                    <ReverseSubstitutionsButton
                      onClick={() => void reverse.run()}
                      disabled={submitting || !prompt.trim()}
                      busy={reverse.busy}
                      data-testid="worlds-reverse-substitutions"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={submitting || reverse.busy}
                    onClick={() => setStarredOpen(true)}
                    data-testid="worlds-starred-prompts-open"
                  >
                    <Star className="size-3.5" /> Starred prompts
                  </Button>
                </div>
                <PromptTextarea
                  id="worlds-prompt"
                  value={prompt}
                  onChange={setPrompt}
                  bucket={IMGGEN_PROMPT_BUCKET}
                  token={token}
                  previews
                  disabled={submitting || reverse.busy}
                  textareaClassName={reverse.effectClass}
                  data-testid="worlds-prompt"
                />
                <fieldset disabled={submitting || reverse.busy}>
                  <RecentPlaceholders onInsert={placeholder => {
                    setPrompt(value => !value || /\s$/.test(value) ? value + placeholder : `${value} ${placeholder}`)
                  }} />
                </fieldset>
                <SavedPromptsDrawer
                  open={starredOpen}
                  onOpenChange={setStarredOpen}
                  value={prompt}
                  onPick={setPrompt}
                  bucket={IMGGEN_PROMPT_BUCKET}
                  token={token}
                  previews
                  initialKind="starred"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Model</Label>
                <ImgGenModelPicker
                  capabilities={models.capabilities}
                  selected={models.capability}
                  onSelect={models.setCapability}
                  onRefresh={models.refresh}
                  capabilitiesStatus={models.status}
                  capabilitiesError={models.error}
                  testIdPrefix="worlds-image-model"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Size (2:3)</Label>
                <ImageSizePicker
                  width={size[0]}
                  height={size[1]}
                  onChange={setSize}
                  presets={SIZE_PRESETS}
                  storageKey={SIZE_STORAGE_KEY}
                  testIdPrefix="worlds-image"
                  disabled={submitting}
                />
              </div>
              <fieldset className="min-w-0 space-y-2" disabled={submitting}>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={upscaleEnabled}
                    onChange={event => {
                      setUpscaleEnabled(event.target.checked)
                      if (event.target.checked) void loadUpscalers()
                    }}
                    data-testid="worlds-image-upscale"
                  />
                  Upscale
                </label>
                {upscaleEnabled && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                      <div className="min-w-0 space-y-1.5">
                        <Label htmlFor="worlds-upscale-model">Upscaler model</Label>
                        <select
                          id="worlds-upscale-model"
                          className={selectClass}
                          value={upscalerKey}
                          onChange={event => setUpscalerKey(event.target.value)}
                          disabled={loadingUpscalers || !!upscalerError || upscalers.length === 0}
                          data-testid="worlds-upscale-model"
                        >
                          {upscalers.length === 0 && (
                            <option value="">{loadingUpscalers ? 'Loading models…' : 'No upscaler models'}</option>
                          )}
                          {upscalers.map(tool => (
                            <option key={toolKey(tool)} value={toolKey(tool)}>
                              {prettyLabel(tool.pack)}{tool.workflow !== 'upscale' && ` · ${prettyLabel(tool.workflow)}`}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="worlds-upscale-scale">Scale multiplier</Label>
                        <select
                          id="worlds-upscale-scale"
                          className={selectClass}
                          value={scale}
                          onChange={event => setScale(Number(event.target.value))}
                          data-testid="worlds-upscale-scale"
                        >
                          {UPSCALE_SCALES.map(value => <option key={value} value={value}>×{value}</option>)}
                        </select>
                      </div>
                    </div>
                    {upscalerError && <JobErrorBanner message={upscalerError} testId="worlds-upscale-error" />}
                    <Button type="button" variant="ghost" size="sm" disabled={loadingUpscalers} onClick={() => void loadUpscalers()}>
                      Refresh upscaler models
                    </Button>
                  </>
                )}
              </fieldset>
            </>
          )}
          {error && <JobErrorBanner message={error} testId="worlds-generate-error" />}
        </DialogBody>
        <DialogFooter>
          {picture ? (
            <>
              <Button type="button" variant="outline" onClick={() => setPicture(null)} className="min-h-11">
                Generate another
              </Button>
              <Button type="button" onClick={usePicture} disabled={disabled} className="min-h-11" data-testid="worlds-use-picture">
                Use picture
              </Button>
            </>
          ) : jobId ? (
            <Button type="button" variant="outline" onClick={() => setOpen(false)} className="min-h-11">
              Continue in background
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void generate()}
              disabled={!canGenerate}
              className="min-h-11"
              data-testid="worlds-generate-submit"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting ? 'Starting…' : 'Generate picture'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
