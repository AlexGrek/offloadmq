import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, HardDrive, ImageIcon, Lock, RefreshCw } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { listFiles } from '../api/files'
import type { FileBrowserResponse, UserFile } from '../api/files'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type DirectionFilter = 'all' | 'input' | 'output'

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
    return all.filter(
      f =>
        (filter === 'all' || f.direction === filter) &&
        (q === '' || f.filename.toLowerCase().includes(q)),
    )
  }, [data, filter, query])

  const summary = data?.summary

  // The file-bytes endpoint authenticates via Authorization header, cookie, or
  // ?token= query. <img>/<a> can only use the query form.
  const withToken = (url: string) => `${url}?token=${encodeURIComponent(token ?? '')}`

  return (
    <main
      className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto overscroll-contain p-6"
      data-testid="files-page"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold">My Files</h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock className="h-3.5 w-3.5" />
            Read-only — files are created automatically by your tasks.
          </p>
        </div>
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
          {(['all', 'input', 'output'] as const).map(f => (
            <Button
              key={f}
              variant={filter === f ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilter(f)}
              data-testid={`files-filter-${f}`}
            >
              {f === 'all' ? 'All' : f === 'input' ? 'Uploads' : 'Generated'}
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

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {files.map(file => (
          <FileTile key={file.id} file={file} href={withToken(file.url)} />
        ))}
      </div>
    </main>
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

function FileTile({ file, href }: { file: UserFile; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group flex flex-col overflow-hidden rounded-xl border border-border transition-all hover:shadow-md hover:border-border/60"
      data-testid={`file-tile-${file.id}`}
    >
      <div className="relative flex aspect-square items-center justify-center bg-muted/40">
        {file.is_image ? (
          <img
            src={href}
            alt={file.filename}
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
      <div className="border-t border-border px-3 py-2">
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
    </a>
  )
}
