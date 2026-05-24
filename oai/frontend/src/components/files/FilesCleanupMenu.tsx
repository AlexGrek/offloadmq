import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  cleanupFiles,
  type CleanupFilesResponse,
  type CleanupFilesScope,
} from '../../api/files'

type FilesCleanupMenuProps = {
  token: string | null
  onCompleted: (result: CleanupFilesResponse, scope: CleanupFilesScope) => void
}

const SCOPE_LABELS: Record<CleanupFilesScope, string> = {
  uploads: 'all uploads',
  generated: 'all generated images',
  all: 'all files',
}

export function FilesCleanupMenu({ token, onCompleted }: FilesCleanupMenuProps) {
  const [open, setOpen] = useState(false)
  const [keepStarred, setKeepStarred] = useState(true)
  const [busy, setBusy] = useState<CleanupFilesScope | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

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
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cleanup failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="relative" ref={ref} data-testid="files-cleanup-menu">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        data-testid="files-cleanup-open"
      >
        Cleanup
        <ChevronDown
          className={cn('ml-1 h-3.5 w-3.5 opacity-60 transition-transform', open && 'rotate-180')}
        />
      </Button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-border bg-popover p-4 text-sm shadow-md"
          role="menu"
          data-testid="files-cleanup-panel"
        >
          <p className="font-medium text-foreground">Cleanup</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Permanently remove files from storage. Starred images are skipped when enabled below.
          </p>

          <label
            className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm"
            data-testid="files-cleanup-keep-starred"
          >
            <input
              type="checkbox"
              className="size-4 shrink-0 rounded border border-input accent-primary"
              checked={keepStarred}
              onChange={e => setKeepStarred(e.target.checked)}
              disabled={busy != null}
            />
            Keep starred
          </label>

          <div className="mt-4 flex flex-col gap-2">
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
            <p className="mt-3 text-xs text-destructive" data-testid="files-cleanup-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
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
      size="sm"
      className="w-full justify-start px-3"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {loading ? (
        <Loader2 className="mr-2 size-4 shrink-0 animate-spin" />
      ) : (
        <Trash2 className="mr-2 size-4 shrink-0" />
      )}
      {label}
    </Button>
  )
}
