import { useState } from 'react'
import type {
  ImageCycleJob,
  ImageCycleModelChanges,
} from '../../api/imageCycles'
import type { LlmCapabilityInfo } from '../../types/ws'
import type { CapabilitiesStatus } from '../../lib/capabilitiesStatus'
import { isListedCapability } from '../../lib/capability-picker'
import { CapabilityModelPicker } from '../CapabilityModelPicker'
import { Button } from '../ui/button'
import { Label } from '../ui/label'

/** Drafts stay independent of the new-run form and background job polling. */
export function RunModelsEditor({
  job,
  visionModels,
  imageModels,
  bootstrapModels,
  status,
  error,
  busy,
  onRefresh,
  onSave,
}: {
  job: ImageCycleJob
  visionModels: LlmCapabilityInfo[]
  imageModels: LlmCapabilityInfo[]
  bootstrapModels: LlmCapabilityInfo[]
  status: CapabilitiesStatus
  error: string | null
  busy: boolean
  onRefresh: () => void
  onSave: (models: ImageCycleModelChanges) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [vision, setVision] = useState(job.params.vision_model)
  const [image, setImage] = useState(job.params.image_model)
  const [bootstrap, setBootstrap] = useState(job.params.bootstrap_model ?? '')
  const needsBootstrap =
    job.app === 'generator-improver' && !!job.params.initial_prompt
  const valid =
    status === 'ready' &&
    isListedCapability(vision, visionModels) &&
    isListedCapability(image, imageModels) &&
    (!needsBootstrap || isListedCapability(bootstrap, bootstrapModels))
  if (!open)
    return (
      <Button
        variant="outline"
        disabled={busy}
        data-testid="cycles-change-models"
        onClick={() => {
          setVision(job.params.vision_model)
          setImage(job.params.image_model)
          setBootstrap(job.params.bootstrap_model ?? '')
          setOpen(true)
        }}
      >
        Change models
      </Button>
    )
  return (
    <section
      className="space-y-4 rounded-lg bg-muted/30 p-4"
      data-testid="cycles-model-editor"
    >
      <p className="text-sm text-muted-foreground">
        Model changes apply to the next steps. A submitted task keeps its
        original model. Pause first to hold the next step while you choose.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Vision model</Label>
          <CapabilityModelPicker
            capabilities={visionModels}
            selected={vision}
            onSelect={setVision}
            onRefresh={onRefresh}
            capabilitiesStatus={status}
            capabilitiesError={error}
            testIdPrefix="cycles-edit-vision-model"
          />
        </div>
        <div className="space-y-2">
          <Label>
            {job.app === 'generator-improver'
              ? `Improvement model · ${job.params.improvement_workflow ?? 'img2img'}`
              : 'Image generation model'}
          </Label>
          <CapabilityModelPicker
            capabilities={imageModels}
            selected={image}
            onSelect={setImage}
            onRefresh={onRefresh}
            capabilitiesStatus={status}
            capabilitiesError={error}
            testIdPrefix="cycles-edit-image-model"
          />
        </div>
        {needsBootstrap && (
          <div className="space-y-2">
            <Label>Starting image model · txt2img</Label>
            <CapabilityModelPicker
              capabilities={bootstrapModels}
              selected={bootstrap}
              onSelect={setBootstrap}
              onRefresh={onRefresh}
              capabilitiesStatus={status}
              capabilitiesError={error}
              testIdPrefix="cycles-edit-bootstrap-model"
            />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !valid}
          data-testid="cycles-save-models"
          onClick={async () => {
            if (
              await onSave({
                vision_model: vision,
                image_model: image,
                ...(needsBootstrap ? { bootstrap_model: bootstrap } : {}),
              })
            )
              setOpen(false)
          }}
        >
          Save models
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Discard changes
        </Button>
      </div>
    </section>
  )
}
