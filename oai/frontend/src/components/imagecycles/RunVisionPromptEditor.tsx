import { useState } from 'react'
import type { ImageCycleJob } from '../../api/imageCycles'
import { DESCRIBE_PROMPT_BUCKET } from '../../lib/describe'
import { PromptTextarea } from '../PromptTextarea'
import { Button } from '../ui/button'
import { Label } from '../ui/label'

export function RunVisionPromptEditor({
  job,
  token,
  busy,
  onSave,
}: {
  job: ImageCycleJob
  token: string | null
  busy: boolean
  onSave: (prompt: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(job.params.describe_prompt)
  if (!open)
    return (
      <Button
        variant="outline"
        className="min-h-11"
        disabled={busy}
        data-testid="cycles-edit-vision-prompt"
        onClick={() => {
          setDraft(job.params.describe_prompt)
          setOpen(true)
        }}
      >
        Edit vision prompt
      </Button>
    )
  return (
    <section
      className="space-y-3 rounded-lg bg-muted/30 p-4"
      data-testid="cycles-vision-prompt-editor"
    >
      <Label htmlFor="cycles-run-vision-prompt">
        Vision prompt for upcoming steps
      </Label>
      <p className="text-sm text-muted-foreground">
        Applies to vision tasks that haven’t been submitted and to restarts.
        Pause first to hold the next step while editing.
        {job.app === 'generator-improver' &&
          ' Required JSON assessment instructions are added automatically.'}
      </p>
      <PromptTextarea
        id="cycles-run-vision-prompt"
        data-testid="cycles-run-vision-prompt"
        value={draft}
        onChange={setDraft}
        bucket={DESCRIBE_PROMPT_BUCKET}
        token={token}
        disabled={busy}
        rows={6}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          className="min-h-11"
          disabled={busy || !draft.trim()}
          data-testid="cycles-save-vision-prompt"
          onClick={async () => {
            if (await onSave(draft.trim())) setOpen(false)
          }}
        >
          Save vision prompt
        </Button>
        <Button
          className="min-h-11"
          variant="ghost"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Discard prompt changes
        </Button>
      </div>
    </section>
  )
}
