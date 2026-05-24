import { useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  cleanupFiles,
  type CleanupFilesResponse,
  type CleanupFilesScope,
} from '../../api/files'

type FilesCleanupDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string | null
  onCompleted: (result: CleanupFilesResponse, scope: CleanupFilesScope) => void
}

const SCOPE_LABELS: Record<CleanupFilesScope, string> = {
  uploads: 'all uploads',
  generated: 'all generated images',
  all: 'all files',
}

export function FilesCleanupDialog({
  open,
  onOpenChange,
  token,
  onCompleted,
}: FilesCleanupDialogProps) {
  const [keepStarred, setKeepStarred] = useState(true)
  const [busy, setBusy] = useState<CleanupFilesScope | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runCleanup(scope: CleanupFilesScope) {
    if (!token) return
    const label = SCOPE_LABELS[scope]
    if (
      !window.confirm(
        keepStarred
          ? `Delete ${label}, except starred items? This cannot be undone.`
          : `Delete ${label}, including starred items? This cannot be undone.`,
      )
    ) {
      return
    }
    setBusy(scope)
    setError(null)
    try {
      const res = await cleanupFiles(token, { scope, keep_starred: keepStarred })
      onCompleted(res, scope)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cleanup failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="files-cleanup-dialog">
        <DialogTitle>Cleanup</DialogTitle>
        <DialogDescription>
          Permanently remove files from your storage. Starred images can be kept when the option
          below is enabled.
        </DialogDescription>

        <label
          className="flex cursor-pointer items-center gap-2 text-sm"
          data-testid="files-cleanup-keep-starred"
        >
          <input
            type="checkbox"
            className="size-4 rounded border border-input accent-primary"
            checked={keepStarred}
            onChange={e => setKeepStarred(e.target.checked)}
            disabled={busy != null}
          />
          Keep starred
        </label>

        <div className="flex flex-col gap-2 pt-1">
          <CleanupButton
            testId="files-cleanup-uploads"
            label="Delete all uploads"
            loading={busy === 'uploads'}
            disabled={busy != null}
            onClick={() => void runCleanup('uploads')}
          />
          <CleanupButton
            testId="files-cleanup-generated"
            label="Delete all generated"
            loading={busy === 'generated'}
            disabled={busy != null}
            onClick={() => void runCleanup('generated')}
          />
          <CleanupButton
            testId="files-cleanup-all"
            label="Delete all"
            loading={busy === 'all'}
            disabled={busy != null}
            onClick={() => void runCleanup('all')}
          />
        </div>

        {error && (
          <p className="text-sm text-destructive" data-testid="files-cleanup-error">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CleanupButton({
  testId,
  label,
  loading,
  disabled,
  onClick,
}: {
  testId: string
  label: string
  loading: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="destructive"
      className="w-full justify-start"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {loading ? (
        <Loader2 className="mr-2 size-4 animate-spin" />
      ) : (
        <Trash2 className="mr-2 size-4" />
      )}
      {label}
    </Button>
  )
}
