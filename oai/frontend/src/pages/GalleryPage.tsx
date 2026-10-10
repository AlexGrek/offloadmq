import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Copy, Loader2, Sparkles, Star, WandSparkles } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { listImageLibrary } from '../api/files'
import type { UserFile } from '../api/files'
import { imageFileUrl, imageThumbnailUrl } from '../api/images'
import type { UploadedImage } from '../api/images'
import type { ImggenRouteState } from '../lib/imggen'
import { ImageLightbox, type LightboxSlide } from '@/components/ImageLightbox'
import { LoadingImage } from '@/components/LoadingImage'
import { NudeDetectModal } from '@/components/nudedetect/NudeDetectModal'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 60
/** Start fetching the next page when the viewer is this close to the end. */
const PREFETCH_AHEAD = 4

type GalleryFilter = 'generated' | 'starred' | 'uploads' | 'all'

const FILTERS: { id: GalleryFilter; label: string }[] = [
  { id: 'generated', label: 'Generated' },
  { id: 'starred', label: 'Starred' },
  { id: 'uploads', label: 'Uploads' },
  { id: 'all', label: 'All' },
]

function filterParams(filter: GalleryFilter) {
  switch (filter) {
    case 'generated':
      return { direction: 'output' as const }
    case 'uploads':
      return { direction: 'input' as const }
    case 'starred':
      return { direction: 'all' as const, starredOnly: true }
    case 'all':
      return { direction: 'all' as const }
  }
}

function toUploadedImage(file: UserFile): UploadedImage {
  return {
    image_id: file.id,
    filename: file.filename,
    content_type: file.content_type,
    width: file.width,
    height: file.height,
    size_bytes: file.size_bytes,
    rescaled: false,
    reencoded: false,
  }
}

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})
const dayYearFormat = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(d: Date, now: Date): string {
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayKey(d) === dayKey(now)) return 'Today'
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday'
  return d.getFullYear() === now.getFullYear() ? dayFormat.format(d) : dayYearFormat.format(d)
}

type DayGroup = { key: string; label: string; items: { file: UserFile; index: number }[] }

function groupByDay(files: UserFile[]): DayGroup[] {
  const now = new Date()
  const groups: DayGroup[] = []
  files.forEach((file, index) => {
    const d = new Date(file.created_at)
    const key = dayKey(d)
    let group = groups[groups.length - 1]
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(d, now), items: [] }
      groups.push(group)
    }
    group.items.push({ file, index })
  })
  return groups
}

function promptSnippet(file: UserFile): string {
  return file.generation?.prompt ?? file.filename
}

export default function GalleryPage() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<GalleryFilter>('generated')
  const [files, setFiles] = useState<UserFile[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [nudeTarget, setNudeTarget] = useState<{ imageId: string; filename: string } | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  /** Bumped on every filter change / refresh so late pages of an old query are dropped. */
  const generationRef = useRef(0)
  const loadingRef = useRef(false)

  // Latest values for `loadPage`, which must stay referentially stable.
  const filesRef = useRef(files)
  const filterRef = useRef(filter)
  useEffect(() => {
    filesRef.current = files
  }, [files])

  const loadPage = useCallback(
    async (replace: boolean) => {
      if (!token) return
      if (replace) generationRef.current += 1
      else if (loadingRef.current) return
      const generation = generationRef.current
      loadingRef.current = true
      setLoading(true)
      try {
        // Appending resumes from however many rows are already shown.
        const offset = replace ? 0 : filesRef.current.length
        const page = await listImageLibrary(token, {
          offset,
          limit: PAGE_SIZE,
          ...filterParams(filterRef.current),
        })
        if (generation !== generationRef.current) return
        setFiles(prev => {
          if (replace) return page.files
          const seen = new Set(prev.map(f => f.id))
          return [...prev, ...page.files.filter(f => !seen.has(f.id))]
        })
        setHasMore(page.has_more)
        setError(null)
      } catch (e) {
        if (generation === generationRef.current) {
          setError(e instanceof Error ? e.message : 'Failed to load images')
        }
      } finally {
        if (generation === generationRef.current) {
          loadingRef.current = false
          setLoading(false)
        }
      }
    },
    [token],
  )

  useEffect(() => {
    filterRef.current = filter
    void loadPage(true)
  }, [filter, loadPage])

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) void loadPage(false)
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loadPage, files.length])

  const groups = useMemo(() => groupByDay(files), [files])

  const slides = useMemo<LightboxSlide[]>(
    () =>
      token
        ? files.map(f => ({
            id: f.id,
            src: imageFileUrl(f.id, token),
            alt: promptSnippet(f),
          }))
        : [],
    [files, token],
  )

  const onViewerIndex = useCallback(
    (next: number) => {
      setViewerIndex(next)
      if (hasMore && next >= filesRef.current.length - PREFETCH_AHEAD) void loadPage(false)
    },
    [hasMore, loadPage],
  )

  const onDeleted = useCallback((id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id))
  }, [])

  const onStarredChange = useCallback((id: string, starred: boolean) => {
    setFiles(prev => prev.map(f => (f.id === id ? { ...f, is_starred: starred } : f)))
  }, [])

  const openInGenerator = useCallback(
    (file: UserFile, mode: 'img2img' | 'img2video') => {
      const state: ImggenRouteState = {
        useInputImage: { mode, image: toUploadedImage(file) },
      }
      navigate('/app/images', { state })
    },
    [navigate],
  )

  const reusePrompt = useCallback(
    (prompt: string) => {
      const state: ImggenRouteState = { usePrompt: prompt }
      navigate('/app/images', { state })
    },
    [navigate],
  )

  const current = viewerIndex != null ? files[viewerIndex] : undefined

  return (
    <>
      <main
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        data-testid="gallery-page"
      >
        <header
          className="sticky top-0 z-20 flex flex-col gap-2 bg-background/85 px-3 pb-2 pt-3 backdrop-blur-md sm:px-6 sm:pt-4"
          data-testid="gallery-header"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="font-display text-2xl font-bold tracking-tight">Gallery</h1>
            {files.length > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground" data-testid="gallery-count">
                {files.length}
                {hasMore ? '+' : ''} {files.length === 1 && !hasMore ? 'image' : 'images'}
              </span>
            ) : null}
          </div>
          <div
            className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
            role="tablist"
            aria-label="Gallery filter"
            data-testid="gallery-filters"
          >
            {FILTERS.map(f => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={cn(
                  'inline-flex min-h-9 shrink-0 items-center rounded-full px-4 text-sm font-medium transition-colors',
                  filter === f.id
                    ? 'bg-foreground text-background'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                data-testid={`gallery-filter-${f.id}`}
              >
                {f.id === 'starred' ? <Star className="mr-1.5 size-3.5" /> : null}
                {f.label}
              </button>
            ))}
          </div>
        </header>

        {error ? (
          <div className="px-3 py-6 text-center sm:px-6" data-testid="gallery-error">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" className="mt-3" onClick={() => void loadPage(true)}>
              Try again
            </Button>
          </div>
        ) : null}

        {!error && !loading && files.length === 0 ? (
          <div
            className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-24 text-center"
            data-testid="gallery-empty"
          >
            <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/60">
              <Sparkles className="size-6 text-muted-foreground" />
            </div>
            <p className="font-display text-lg font-semibold">
              {filter === 'starred' ? 'No starred images yet' : 'Nothing here yet'}
            </p>
            <p className="text-sm text-muted-foreground">
              {filter === 'starred'
                ? 'Star an image in the viewer to keep it handy.'
                : 'Images you generate or upload show up here.'}
            </p>
            <Button onClick={() => navigate('/app/images')}>Generate an image</Button>
          </div>
        ) : null}

        <div className="pb-6" data-testid="gallery-grid">
          {groups.map(group => (
            <section key={group.key} className="mb-1" data-testid={`gallery-day-${group.key}`}>
              <h2 className="px-3 pb-1.5 pt-4 text-sm font-semibold text-foreground/90 sm:px-6">
                {group.label}
              </h2>
              <div className="grid grid-cols-3 gap-0.5 sm:grid-cols-4 sm:gap-1 sm:px-6 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                {group.items.map(({ file, index }) => (
                  <GalleryTile
                    key={file.id}
                    file={file}
                    token={token}
                    onOpen={() => setViewerIndex(index)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        <div ref={sentinelRef} className="h-px" aria-hidden />
        {loading && files.length > 0 ? (
          <div className="flex justify-center pb-8" data-testid="gallery-loading-more">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {loading && files.length === 0 && !error ? <GallerySkeleton /> : null}
      </main>

      {token && current ? (
        <ImageLightbox
          open
          onOpenChange={open => {
            if (!open) setViewerIndex(null)
          }}
          src={imageFileUrl(current.id, token)}
          alt={promptSnippet(current)}
          slides={slides}
          index={viewerIndex ?? 0}
          onIndexChange={onViewerIndex}
          promptPanel={<PromptSheet file={current} onUsePrompt={reusePrompt} />}
          actions={{
            imageId: current.id,
            filename: current.filename,
            direction: current.direction,
            token,
            onDeleted: () => onDeleted(current.id),
            onStarredChange: starred => onStarredChange(current.id, starred),
            onNudeDetect: () => setNudeTarget({ imageId: current.id, filename: current.filename }),
            onSendToImg2Img: () => openInGenerator(current, 'img2img'),
            onSendToImg2Video: () => openInGenerator(current, 'img2video'),
            imgUtils: { onResult: () => loadPage(true) },
          }}
        />
      ) : null}

      {nudeTarget && token ? (
        <NudeDetectModal
          open
          onOpenChange={open => {
            if (!open) setNudeTarget(null)
          }}
          token={token}
          imageId={nudeTarget.imageId}
          imageUrl={imageFileUrl(nudeTarget.imageId, token)}
          filename={nudeTarget.filename}
        />
      ) : null}
    </>
  )
}

function GalleryTile({
  file,
  token,
  onOpen,
}: {
  file: UserFile
  token: string | null
  onOpen: () => void
}) {
  const prompt = file.generation?.prompt
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-square cursor-zoom-in overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:rounded-md"
      aria-label={`Open ${prompt ?? file.filename}`}
      data-testid={`gallery-tile-${file.id}`}
    >
      <LoadingImage
        src={imageThumbnailUrl(file.id, token)}
        alt=""
        loading="lazy"
        draggable={false}
        width={file.width || undefined}
        height={file.height || undefined}
        className="size-full object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none"
      />
      {file.is_starred ? (
        <Star className="absolute right-1.5 top-1.5 size-4 fill-amber-300 text-amber-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)]" />
      ) : null}
      {prompt ? (
        // Hover-capable devices get a peek at the prompt; touch uses the viewer.
        <span className="pointer-events-none absolute inset-x-0 bottom-0 hidden bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-6 text-left text-[11px] leading-snug text-white opacity-0 transition-opacity duration-200 line-clamp-2 [@media(hover:hover)]:block group-hover:opacity-100">
          {prompt}
        </span>
      ) : null}
    </button>
  )
}

function GallerySkeleton() {
  return (
    <div
      className="grid grid-cols-3 gap-0.5 pt-4 sm:grid-cols-4 sm:gap-1 sm:px-6 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8"
      data-testid="gallery-skeleton"
    >
      {Array.from({ length: 18 }, (_, i) => (
        <div key={i} className="aspect-square animate-pulse bg-muted motion-reduce:animate-none sm:rounded-md" />
      ))}
    </div>
  )
}

/** Content of the lightbox's prompt sheet for one image. */
function PromptSheet({
  file,
  onUsePrompt,
}: {
  file: UserFile
  onUsePrompt: (prompt: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const generation = file.generation

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])

  const details: string[] = [
    ...(generation
      ? [generation.capability.replace(/^imggen\./, ''), generation.workflow]
      : []),
    file.width && file.height ? `${file.width}×${file.height}` : '',
    generation?.seed != null ? `seed ${generation.seed}` : '',
    dateTimeFormat.format(new Date(file.created_at)),
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-2 px-2 pt-1" data-testid="gallery-prompt-sheet">
      {generation ? (
        <>
          <div className="flex items-start gap-2">
            <p
              className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-white/95 select-text"
              data-testid="gallery-prompt-text"
            >
              {generation.prompt}
            </p>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(generation.prompt).then(() => setCopied(true))
                }}
                className="inline-flex size-8 items-center justify-center rounded-lg text-white/80 hover:bg-white/12 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                aria-label="Copy prompt"
                title="Copy prompt"
                data-testid="gallery-prompt-copy"
              >
                {copied ? <Check className="size-4 text-emerald-300" /> : <Copy className="size-4" />}
              </button>
              <button
                type="button"
                onClick={() => onUsePrompt(generation.prompt)}
                className="inline-flex size-8 items-center justify-center rounded-lg text-white/80 hover:bg-white/12 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                aria-label="Use this prompt"
                title="Use this prompt"
                data-testid="gallery-prompt-use"
              >
                <WandSparkles className="size-4" />
              </button>
            </div>
          </div>
          {generation.negative_prompt ? (
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-white/55 select-text">
              <span className="font-medium text-white/70">Negative · </span>
              {generation.negative_prompt}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-white/70" data-testid="gallery-prompt-none">
          {file.direction === 'input'
            ? 'Uploaded image — no prompt.'
            : 'No prompt recorded for this image.'}
        </p>
      )}
      <p className="text-[11px] text-white/45">{details.join(' · ')}</p>
    </div>
  )
}
