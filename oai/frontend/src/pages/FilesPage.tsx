import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  FileText,
  HardDrive,
  ImageIcon,
  Info,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Volume2,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { listFiles } from '../api/files'
import type { CleanupFilesScope, FileBrowserResponse, UserFile } from '../api/files'
import { FilesCleanupMenu } from '../components/files/FilesCleanupMenu'
import { imageFileUrl, imageThumbnailUrl } from '../api/images'
import { deleteTtsJob, ttsAudioUrl } from '../api/tts'
import { FilePropertiesDialog } from '../components/files/FilePropertiesDialog'
import { ImageLightbox } from '@/components/ImageLightbox'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type DirectionFilter = 'all' | 'input' | 'output' | 'audio'

const SCOPE_LABELS: Record<CleanupFilesScope, string> = {
  uploads: 'upload(s)',
  generated: 'generated file(s)',
  all: 'file(s)',
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export default function FilesPage() {
  const { token } = useAuth()
  const [data, setData] = useState<FileBrowserResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<DirectionFilter>('all')
  const [query, setQuery] = useState('')
  const [mediaRevision, setMediaRevision] = useState(0)
  const [info, setInfo] = useState<string | null>(null)
  const [propsFilename, setPropsFilename] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!token) return
    setLoading(true)
    listFiles(token)
      .then(d => {
        setData(d)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [token])

  useEffect(() => load(), [load])

  const files = useMemo(() => {
    const all = data?.files ?? []
    const q = query.trim().toLowerCase()
    return all.filter(f => {
      if (q !== '' && !f.filename.toLowerCase().includes(q)) return false
      switch (filter) {
        case 'all':
          return true
        case 'audio':
          return f.is_audio
        case 'input':
        case 'output':
          return !f.is_audio && f.direction === filter
      }
    })
  }, [data, filter, query])

  const imageFiles = useMemo(() => files.filter(f => !f.is_audio), [files])
  const audioFiles = useMemo(() => files.filter(f => f.is_audio), [files])
  const summary = data?.summary

  return (
    <main
      className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto overscroll-contain p-6"
      data-testid="files-page"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold">My Files</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Files are created by image tasks. Use cleanup to remove uploads or generated outputs.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <FilesCleanupMenu
            token={token}
            onCompleted={(res, scope) => {
              const skipped =
                res.skipped_starred > 0 ? ` (${res.skipped_starred} starred kept)` : ''
              setInfo(`Deleted ${res.deleted_count} ${SCOPE_LABELS[scope]}${skipped}.`)
              setError(null)
              load()
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={load}
            disabled={loading}
            data-testid="files-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="ml-1.5 hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Storage summary */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="files-summary">
        <SummaryStat label="Used space" value={formatBytes(summary?.used_bytes ?? 0)} accent />
        <SummaryStat label="Files" value={String(summary?.file_count ?? 0)} />
        <SummaryStat label="Uploads" value={formatBytes(summary?.input_bytes ?? 0)} />
        <SummaryStat label="Generated" value={formatBytes(summary?.output_bytes ?? 0)} />
      </div>

      {/* Controls */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1">
          {(['all', 'input', 'output', 'audio'] as const).map(f => (
            <Button
              key={f}
              variant={filter === f ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilter(f)}
              data-testid={`files-filter-${f}`}
            >
              {f === 'all'
                ? 'All'
                : f === 'input'
                  ? 'Uploads'
                  : f === 'output'
                    ? 'Generated'
                    : 'Audio'}
            </Button>
          ))}
        </div>
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by filename…"
          className="sm:max-w-xs"
          data-testid="files-search"
        />
      </div>

      {info && (
        <div
          className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
          data-testid="files-info"
        >
          {info}
        </div>
      )}

      {error && (
        <div
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          data-testid="files-error"
        >
          {error}
        </div>
      )}

      {!loading && files.length === 0 && !error && (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          No files yet.
        </div>
      )}

      {imageFiles.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {imageFiles.map(file => (
            <FileTile
              key={file.id}
              file={file}
              token={token}
              mediaRevision={mediaRevision}
              thumbSrc={
                file.is_image ? imageThumbnailUrl(file.id, token, mediaRevision) : undefined
              }
              fullSrc={file.is_image ? imageFileUrl(file.id, token, mediaRevision) : undefined}
              onImageMutated={() => {
                setMediaRevision(v => v + 1)
                load()
              }}
              onShowProperties={() => setPropsFilename(file.filename)}
            />
          ))}
        </div>
      )}

      {audioFiles.length > 0 && (
        <section
          className={imageFiles.length > 0 ? 'mt-8' : ''}
          data-testid="files-audio-section"
        >
          {filter === 'all' && imageFiles.length > 0 && (
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <Volume2 className="size-4" />
              Audio
            </h2>
          )}
          <AudioList
            files={audioFiles}
            token={token}
            onChanged={() => load()}
            onError={msg => setError(msg)}
            onShowProperties={fn => setPropsFilename(fn)}
          />
        </section>
      )}

      <FilePropertiesDialog
        open={propsFilename != null}
        onOpenChange={open => {
          if (!open) setPropsFilename(null)
        }}
        filename={propsFilename}
        token={token}
      />
    </main>
  )
}

function AudioList({
  files,
  token,
  onChanged,
  onError,
  onShowProperties,
}: {
  files: UserFile[]
  token: string | null
  onChanged: () => void
  onError: (msg: string) => void
  onShowProperties: (filename: string) => void
}) {
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
        audioRef.current = null
      }
    }
  }, [])

  function stopPlayback() {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }
    setPlayingId(null)
    setLoadingId(null)
  }

  function togglePlay(file: UserFile) {
    if (playingId === file.id) {
      stopPlayback()
      return
    }
    stopPlayback()
    setLoadingId(file.id)
    const audio = new Audio(ttsAudioUrl(file.id, token))
    audioRef.current = audio
    audio.onplaying = () => {
      setLoadingId(null)
      setPlayingId(file.id)
    }
    audio.onended = () => {
      if (audioRef.current === audio) audioRef.current = null
      setPlayingId(prev => (prev === file.id ? null : prev))
    }
    audio.onerror = () => {
      if (audioRef.current === audio) audioRef.current = null
      setLoadingId(null)
      setPlayingId(prev => (prev === file.id ? null : prev))
      onError('Audio playback failed')
    }
    void audio.play().catch((e: Error) => {
      setLoadingId(null)
      onError(e.message || 'Audio playback failed')
    })
  }

  async function handleDelete(file: UserFile) {
    if (!token) return
    if (!window.confirm(`Delete "${file.filename}"? This cannot be undone.`)) return
    setDeletingId(file.id)
    try {
      if (playingId === file.id) stopPlayback()
      await deleteTtsJob(token, file.id)
      onChanged()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <ul
      className="divide-y divide-border overflow-hidden rounded-xl border border-border"
      data-testid="files-audio-list"
    >
      {files.map(file => {
        const isPlaying = playingId === file.id
        const isLoading = loadingId === file.id
        const isDeleting = deletingId === file.id
        return (
          <li
            key={file.id}
            className="flex items-center gap-3 bg-background px-3 py-2 hover:bg-muted/40 transition-colors"
            data-testid={`files-audio-row-${file.id}`}
          >
            <button
              type="button"
              onClick={() => togglePlay(file)}
              disabled={isLoading || isDeleting}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 transition-colors disabled:opacity-50"
              title={isPlaying ? 'Stop' : 'Play'}
              data-testid={`files-audio-play-${file.id}`}
            >
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : isPlaying ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4 translate-x-px" fill="currentColor" />
              )}
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={file.filename}>
                {file.filename}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {formatBytes(file.size_bytes)} · {file.content_type}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onShowProperties(file.filename)}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Show generation properties"
              data-testid={`files-audio-info-${file.id}`}
              aria-label="Show generation properties"
            >
              <Info className="size-4" />
            </button>
            <a
              href={ttsAudioUrl(file.id, token)}
              download={file.filename}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Download"
              data-testid={`files-audio-download-${file.id}`}
            >
              <Download className="size-4" />
            </a>
            <button
              type="button"
              onClick={() => void handleDelete(file)}
              disabled={isDeleting}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
              title="Delete"
              data-testid={`files-audio-delete-${file.id}`}
            >
              {isDeleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`rounded-lg p-2 ${accent ? 'bg-emerald-500/20' : 'bg-muted'}`}>
          <HardDrive className={`h-4 w-4 ${accent ? 'text-emerald-400' : 'text-muted-foreground'}`} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function FileTile({
  file,
  token,
  mediaRevision,
  thumbSrc,
  fullSrc,
  onImageMutated,
  onShowProperties,
}: {
  file: UserFile
  token: string | null
  mediaRevision: number
  /** Grid preview — stored thumbnail JPEG. */
  thumbSrc?: string
  /** Lightbox / open full size. */
  fullSrc?: string
  onImageMutated: () => void
  onShowProperties: () => void
}) {
  const showInfo = file.direction === 'output'
  const meta = (
    <div className="flex items-start gap-2 border-t border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={file.filename}>
          {file.is_image ? (
            <ImageIcon className="mr-1 inline h-3 w-3 align-text-bottom text-muted-foreground" />
          ) : null}
          {file.filename}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {file.width > 0 && file.height > 0 ? `${file.width}×${file.height} · ` : ''}
          {formatBytes(file.size_bytes)}
        </p>
      </div>
      {showInfo && (
        <button
          type="button"
          onClick={e => {
            e.preventDefault()
            e.stopPropagation()
            onShowProperties()
          }}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="Show generation properties"
          data-testid={`file-tile-info-${file.id}`}
          aria-label="Show generation properties"
        >
          <Info className="size-3.5" />
        </button>
      )}
    </div>
  )

  const thumb = (
    <div className="relative flex aspect-square items-center justify-center bg-muted/40">
      {file.is_image && thumbSrc ? (
        <img
          src={thumbSrc}
          alt=""
          aria-hidden
          loading="lazy"
          className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
        />
      ) : (
        <FileText className="h-10 w-10 text-muted-foreground" />
      )}
      <span className="absolute left-2 top-2 rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-medium capitalize backdrop-blur">
        {file.direction === 'output' ? 'Generated' : 'Upload'}
      </span>
    </div>
  )

  const tileClass =
    'group flex flex-col overflow-hidden rounded-xl border border-border transition-all hover:shadow-md hover:border-border/60'

  if (file.is_image && fullSrc && token) {
    const caption =
      file.width > 0 && file.height > 0
        ? `${file.filename} — ${file.width}×${file.height}`
        : file.filename
    return (
      <div className={tileClass} data-testid={`file-tile-${file.id}`}>
        <ImageLightbox
          src={fullSrc}
          alt={file.filename}
          caption={caption}
          triggerClassName="w-full"
          testId={`file-tile-${file.id}`}
          actions={{
            imageId: file.id,
            filename: file.filename,
            direction: file.direction,
            token,
            onDeleted: onImageMutated,
          }}
        >
          <div className="relative flex aspect-square items-center justify-center bg-muted/40">
            <img
              key={`${file.id}-${mediaRevision}`}
              src={thumbSrc}
              alt=""
              aria-hidden
              loading="lazy"
              className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
            />
            <span className="absolute left-2 top-2 rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-medium capitalize backdrop-blur">
              {file.direction === 'output' ? 'Generated' : 'Upload'}
            </span>
          </div>
        </ImageLightbox>
        {meta}
      </div>
    )
  }

  return (
    <div className={tileClass} data-testid={`file-tile-${file.id}`}>
      {thumb}
      {meta}
    </div>
  )
}
