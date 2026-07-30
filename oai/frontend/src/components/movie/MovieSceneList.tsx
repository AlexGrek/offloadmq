import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/imggen'
import { imageFileUrl } from '../../api/images'
import type { SceneView } from '../../api/movie'
import { AiProcessingFrame } from '../AiProcessingFrame'
import { JobProgressBar } from '../imggen/JobProgressBar'
import { ReadonlyTextarea } from '../ReadonlyTextarea'
import { VideoLightbox } from '../VideoLightbox'

export interface MovieSceneListProps {
  scenes: SceneView[]
  token: string | null
  currentScene: number
  activeLog?: string | null
  stage?: string | null
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'text-muted-foreground bg-muted/40',
  prompting: 'text-sky-500 bg-sky-500/10',
  rendering: 'text-amber-500 bg-amber-500/10',
  completed: 'text-emerald-500 bg-emerald-500/10',
  failed: 'text-destructive bg-destructive/10',
}

function StatusPill({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? 'text-muted-foreground bg-muted/40'
  const spinning = status === 'prompting' || status === 'rendering'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
        cls,
      )}
    >
      {spinning && <Loader2 className="size-2.5 animate-spin" />}
      {status}
    </span>
  )
}

export function MovieSceneList({ scenes, token, currentScene, activeLog, stage }: MovieSceneListProps) {
  if (scenes.length === 0) return null

  return (
    <div className="space-y-3" data-testid="movie-scene-list">
      {scenes.map(scene => {
        const isActive =
          scene.index === currentScene &&
          (scene.status === 'prompting' || scene.status === 'rendering')

        const cardBody = (
          <div className="space-y-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">Scene {scene.index + 1}</span>
              <div className="flex items-center gap-2">
                {scene.status === 'completed' && scene.execution_seconds != null && (
                  <span className="text-[10px] text-muted-foreground">
                    Ran {formatDuration(scene.execution_seconds)}
                  </span>
                )}
                <StatusPill status={scene.status} />
              </div>
            </div>
            <p className="text-sm text-foreground/90">{scene.outline}</p>
            {isActive && (
              <JobProgressBar
                label={null}
                status={scene.status}
                stage={stage}
                startedAt={scene.started_at}
                typicalRuntimeSeconds={scene.typical_runtime_seconds}
                submittedAt={scene.submitted_at}
                className="max-w-none"
              />
            )}
            {scene.prompt && (
              <ReadonlyTextarea
                value={scene.prompt}
                className="text-xs text-muted-foreground"
                ariaLabel={`Scene ${scene.index + 1} video prompt`}
                testId={`movie-scene-${scene.index}-prompt`}
              />
            )}
            {isActive && activeLog && (
              <ReadonlyTextarea
                value={activeLog}
                className="font-mono text-[10px] text-muted-foreground/80"
                ariaLabel={`Scene ${scene.index + 1} log`}
                testId={`movie-scene-${scene.index}-log`}
              />
            )}
            {scene.error && <p className="text-xs text-destructive">{scene.error}</p>}
            {scene.video_file_id && (
              <VideoLightbox
                src={imageFileUrl(scene.video_file_id, token)}
                alt={`Scene ${scene.index + 1} clip`}
                triggerClassName="block w-full max-w-xs overflow-hidden rounded-lg bg-muted/30"
                testId={`movie-scene-${scene.index}-clip`}
              >
                <video
                  src={imageFileUrl(scene.video_file_id, token)}
                  className="max-h-48 w-full object-contain bg-muted/30"
                  muted
                  loop
                  playsInline
                />
              </VideoLightbox>
            )}
          </div>
        )

        return isActive ? (
          <AiProcessingFrame key={scene.index} testId={`movie-scene-${scene.index}`}>
            {cardBody}
          </AiProcessingFrame>
        ) : (
          <div
            key={scene.index}
            className="rounded-2xl border border-border bg-muted/15 transition-colors"
            data-testid={`movie-scene-${scene.index}`}
          >
            {cardBody}
          </div>
        )
      })}
    </div>
  )
}
