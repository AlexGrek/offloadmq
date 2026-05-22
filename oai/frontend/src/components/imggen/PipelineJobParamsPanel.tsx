import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ImageJobDetails } from '../../api/images'
import { modelNameFromCapability, pipelineParamsFromJob } from '../../lib/imggen'

type PipelineJobParamsPanelProps = {
  job: ImageJobDetails
}

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[8rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-xs text-foreground break-words">{value}</dd>
    </div>
  )
}

export function PipelineJobParamsPanel({ job }: PipelineJobParamsPanelProps) {
  const [open, setOpen] = useState(false)
  const p = pipelineParamsFromJob(job)

  const rescaleLine = p.rescale
    ? p.rescale.enabled
      ? p.rescale.mode === 'max'
        ? `max${p.rescale.px != null ? ` px=${p.rescale.px}` : ''}${p.rescale.mp != null ? ` mp=${p.rescale.mp}` : ''}`
        : `exact ${p.rescale.width}×${p.rescale.height}`
      : 'disabled'
    : '—'

  const dataPrep =
    p.data_preparation && Object.keys(p.data_preparation).length > 0
      ? JSON.stringify(p.data_preparation)
      : '—'

  return (
    <div data-testid="imggen-job-params">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
        aria-expanded={open}
        data-testid="imggen-job-params-toggle"
      >
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open ? 'rotate-0' : '-rotate-90',
          )}
          aria-hidden
        />
        <span className="text-sm font-medium">Parameters</span>
      </button>
      {open && (
        <dl className="mt-2 space-y-2 rounded-lg border border-border bg-muted/20 px-3 py-3">
          <ParamRow label="Model" value={modelNameFromCapability(p.capability)} />
          <ParamRow label="Workflow" value={p.workflow} />
          <ParamRow label="Resolution" value={`${p.width} × ${p.height}`} />
          <ParamRow
            label="Seed"
            value={p.seed != null ? String(p.seed) : 'random'}
          />
          <ParamRow
            label="Negative prompt"
            value={
              p.override_negative
                ? (p.negative_prompt?.trim() || '(empty override)')
                : 'workflow default'
            }
          />
          <ParamRow label="Rescale" value={rescaleLine} />
          <ParamRow label="Data preparation" value={dataPrep} />
          {p.input_image_id && (
            <ParamRow label="Input image" value={p.input_image_id} />
          )}
          {job.display_name.trim() ? (
            <ParamRow label="Pipeline name" value={job.display_name.trim()} />
          ) : null}
          <ParamRow label="Pipeline id" value={job.job_id} />
        </dl>
      )}
    </div>
  )
}
