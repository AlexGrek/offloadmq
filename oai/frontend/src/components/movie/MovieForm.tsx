import { useState, type FormEvent } from 'react'
import { Clapperboard, FolderOpen, Loader2, Play, Upload, X } from 'lucide-react'
import { uploadImage, imageFileUrl, type UploadedImage } from '../../api/images'
import type { MovieCapability } from '../../api/movie'
import { CapabilityModelPicker } from '../CapabilityModelPicker'
import { ImagePickerModal } from '../imggen/ImagePickerModal'
import { JobErrorBanner } from '../JobErrorBanner'
import { PromptTextarea } from '../PromptTextarea'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import type { CapabilitiesStatus } from '../../lib/capabilitiesStatus'
import { capabilityBaseLabel } from '../../lib/modelAvailability'
import { filterCapabilitiesByWorkflow, parseVideoLength } from '../../lib/imggen'
import {
  MOVIE_DIRECTOR_SYSTEM_BUCKET,
  MOVIE_IDEA_BUCKET,
  MOVIE_SCENE_SYSTEM_BUCKET,
} from '../../lib/moviePromptBuckets'

export interface MovieFormProps {
  token: string | null

  llmCapabilities: MovieCapability[]
  videoCapabilities: MovieCapability[]
  capabilitiesStatus: CapabilitiesStatus
  capabilitiesError: string | null
  onRefreshCapabilities: () => void

  idea: string
  onIdeaChange: (v: string) => void
  width: number
  onWidthChange: (v: number) => void
  height: number
  onHeightChange: (v: number) => void
  sceneCount: number
  onSceneCountChange: (v: number) => void
  sceneLength: string
  onSceneLengthChange: (v: string) => void
  directorModel: string
  onDirectorModelChange: (v: string) => void
  sceneModel: string
  onSceneModelChange: (v: string) => void
  txt2VideoCapability: string
  onTxt2VideoCapabilityChange: (v: string) => void
  img2VideoCapability: string
  onImg2VideoCapabilityChange: (v: string) => void
  longShot: boolean
  onLongShotChange: (v: boolean) => void
  autoApprove: boolean
  onAutoApproveChange: (v: boolean) => void
  expandPrompt: boolean
  onExpandPromptChange: (v: boolean) => void
  directorSystem: string
  onDirectorSystemChange: (v: string) => void
  sceneSystem: string
  onSceneSystemChange: (v: string) => void
  initialImage: UploadedImage | null
  onInitialImageChange: (img: UploadedImage | null) => void

  onSubmit: () => void
  submitting: boolean
  canSubmit: boolean
  error: string | null
}

export function MovieForm({
  token,
  llmCapabilities,
  videoCapabilities,
  capabilitiesStatus,
  capabilitiesError,
  onRefreshCapabilities,
  idea,
  onIdeaChange,
  width,
  onWidthChange,
  height,
  onHeightChange,
  sceneCount,
  onSceneCountChange,
  sceneLength,
  onSceneLengthChange,
  directorModel,
  onDirectorModelChange,
  sceneModel,
  onSceneModelChange,
  txt2VideoCapability,
  onTxt2VideoCapabilityChange,
  img2VideoCapability,
  onImg2VideoCapabilityChange,
  longShot,
  onLongShotChange,
  autoApprove,
  onAutoApproveChange,
  expandPrompt,
  onExpandPromptChange,
  directorSystem,
  onDirectorSystemChange,
  sceneSystem,
  onSceneSystemChange,
  initialImage,
  onInitialImageChange,
  onSubmit,
  submitting,
  canSubmit,
  error,
}: MovieFormProps) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  async function onUpload(file: File) {
    if (!token) return
    setUploading(true)
    setUploadError(null)
    try {
      const img = await uploadImage(token, file)
      onInitialImageChange(img)
    } catch (e) {
      setUploadError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSubmit()
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-3 py-4 sm:px-6 sm:py-5" data-testid="movie-new-panel">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
          <Clapperboard className="size-4 text-rose-400" />
          Movie Studio
        </h2>
        <p className="text-sm text-muted-foreground">
          One idea becomes a multi-scene film: a director LLM writes the outline, a scene
          model expands each shot, and a video model renders every clip.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="movie-idea">Idea</Label>
          <PromptTextarea
            id="movie-idea"
            value={idea}
            onChange={onIdeaChange}
            bucket={MOVIE_IDEA_BUCKET}
            token={token}
            rows={3}
            placeholder="A lone astronaut discovers a garden growing on a derelict space station…"
            data-testid="movie-idea-input"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="movie-width">Width</Label>
            <Input
              id="movie-width"
              type="number"
              min={64}
              value={width}
              onChange={e => onWidthChange(Number(e.target.value) || 1024)}
              data-testid="movie-width"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="movie-height">Height</Label>
            <Input
              id="movie-height"
              type="number"
              min={64}
              value={height}
              onChange={e => onHeightChange(Number(e.target.value) || 576)}
              data-testid="movie-height"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Director model</Label>
            <CapabilityModelPicker
              capabilities={llmCapabilities}
              selected={directorModel}
              onSelect={onDirectorModelChange}
              onRefresh={onRefreshCapabilities}
              capabilitiesStatus={capabilitiesStatus}
              capabilitiesError={capabilitiesError}
              formatLabel={cap => capabilityBaseLabel(cap.base)}
              testIdPrefix="movie-director-model"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Scene director model</Label>
            <CapabilityModelPicker
              capabilities={llmCapabilities}
              selected={sceneModel}
              onSelect={onSceneModelChange}
              onRefresh={onRefreshCapabilities}
              capabilitiesStatus={capabilitiesStatus}
              capabilitiesError={capabilitiesError}
              formatLabel={cap => capabilityBaseLabel(cap.base)}
              testIdPrefix="movie-scene-model"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Text-to-video model</Label>
            <CapabilityModelPicker
              capabilities={filterCapabilitiesByWorkflow(videoCapabilities, 'txt2video')}
              selected={txt2VideoCapability}
              onSelect={onTxt2VideoCapabilityChange}
              onRefresh={onRefreshCapabilities}
              capabilitiesStatus={capabilitiesStatus}
              capabilitiesError={capabilitiesError}
              formatLabel={cap => capabilityBaseLabel(cap.base)}
              testIdPrefix="movie-txt2video-model"
            />
          </div>
          {(longShot || initialImage) && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Image-to-video model</Label>
              <p className="text-xs text-muted-foreground">
                Needed because long-shot mode and/or an initial image are enabled.
              </p>
              <CapabilityModelPicker
                capabilities={filterCapabilitiesByWorkflow(videoCapabilities, 'img2video')}
                selected={img2VideoCapability}
                onSelect={onImg2VideoCapabilityChange}
                onRefresh={onRefreshCapabilities}
                capabilitiesStatus={capabilitiesStatus}
                capabilitiesError={capabilitiesError}
                formatLabel={cap => capabilityBaseLabel(cap.base)}
                testIdPrefix="movie-img2video-model"
              />
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="movie-scene-count">Number of scenes</Label>
            <Input
              id="movie-scene-count"
              type="number"
              min={1}
              max={50}
              value={sceneCount}
              onChange={e =>
                onSceneCountChange(Math.min(50, Math.max(1, parseInt(e.target.value, 10) || 1)))
              }
              data-testid="movie-scene-count"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="movie-scene-length">Scene length (frames)</Label>
            <Input
              id="movie-scene-length"
              type="number"
              min={1}
              max={300}
              value={sceneLength}
              onChange={e => onSceneLengthChange(e.target.value)}
              onBlur={() => onSceneLengthChange(String(parseVideoLength(sceneLength)))}
              data-testid="movie-scene-length"
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-muted/15 p-3">
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={longShot}
              onChange={e => onLongShotChange(e.target.checked)}
              className="accent-rose-500"
              data-testid="movie-long-shot"
            />
            Long shot mode
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={e => onAutoApproveChange(e.target.checked)}
              className="accent-rose-500"
              data-testid="movie-auto-approve"
            />
            Auto-approve outline
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={expandPrompt}
              onChange={e => onExpandPromptChange(e.target.checked)}
              className="accent-rose-500"
              data-testid="movie-expand-prompt"
            />
            Expand scene prompts
          </label>
        </div>

        <div className="space-y-2">
          <Label>Initial image (optional)</Label>
          <div className="flex flex-wrap items-start gap-2">
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/50">
              <Upload className="h-3.5 w-3.5" />
              {uploading ? 'Uploading…' : 'Upload'}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={uploading}
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) void onUpload(file)
                  e.target.value = ''
                }}
                data-testid="movie-initial-image-input"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setPickerOpen(true)}
              data-testid="movie-pick-from-library"
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
              From library
            </Button>
            {initialImage && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {initialImage.filename} ({initialImage.width}×{initialImage.height})
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onInitialImageChange(null)}
                  data-testid="movie-initial-image-clear"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
          {initialImage && (
            <img
              src={imageFileUrl(initialImage.image_id, token)}
              alt="Initial frame preview"
              className="max-h-40 w-full max-w-xs rounded-lg bg-muted/30 object-contain"
              data-testid="movie-initial-image-preview"
            />
          )}
          {uploadError && <JobErrorBanner message={uploadError} testId="movie-upload-error" />}
        </div>

        <div className="space-y-3 rounded-2xl border border-border bg-muted/15 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="movie-director-system">Director system prompt</Label>
            <PromptTextarea
              id="movie-director-system"
              value={directorSystem}
              onChange={onDirectorSystemChange}
              bucket={MOVIE_DIRECTOR_SYSTEM_BUCKET}
              token={token}
              rows={2}
              placeholder="Leave empty to use the backend default"
              data-testid="movie-director-system"
              textareaClassName="text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="movie-scene-system">Scene director system prompt</Label>
            <PromptTextarea
              id="movie-scene-system"
              value={sceneSystem}
              onChange={onSceneSystemChange}
              bucket={MOVIE_SCENE_SYSTEM_BUCKET}
              token={token}
              rows={2}
              placeholder="Leave empty to use the backend default"
              data-testid="movie-scene-system"
              textareaClassName="text-xs"
            />
          </div>
        </div>

        <Button
          type="submit"
          disabled={!canSubmit}
          className="w-full sm:w-auto"
          data-testid="movie-submit"
        >
          {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}
          Generate movie
        </Button>

        {error && <JobErrorBanner message={error} testId="movie-error" />}
      </form>

      {token && (
        <ImagePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={img => onInitialImageChange(img)}
          token={token}
        />
      )}
    </div>
  )
}
