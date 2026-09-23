import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ImageIcon, RefreshCw, Search, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listImageLibrary } from '../../api/files'
import type { UserFile } from '../../api/files'
import { imageThumbnailUrl } from '../../api/images'
import type { UploadedImage } from '../../api/images'

type DirectionFilter = 'all' | 'input' | 'output'

const PAGE_SIZE = 60
const GRID_GAP = 8
const GRID_PADDING = 32
const GRID_OVERSCAN_ROWS = 2

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.18 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
}

const panelVariants = {
  hidden: { opacity: 0, y: 24, scale: 0.97 },
  visible: {
    opacity: 1, y: 0, scale: 1,
    transition: { type: 'spring' as const, stiffness: 380, damping: 30 },
  },
  exit: { opacity: 0, y: 16, scale: 0.97, transition: { duration: 0.15 } },
}

function userFileToUploadedImage(file: UserFile): UploadedImage {
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

interface ImagePickerModalProps {
  open: boolean
  onClose: () => void
  onSelect: (image: UploadedImage) => void
  token: string
}

export function ImagePickerModal({ open, onClose, onSelect, token }: ImagePickerModalProps) {
  const [files, setFiles] = useState<UserFile[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<DirectionFilter>('all')
  const [starredOnly, setStarredOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const filesRef = useRef<UserFile[]>([])
  const requestRef = useRef(0)

  const load = useCallback((reset: boolean) => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    listImageLibrary(token, {
      offset: reset ? 0 : filesRef.current.length,
      limit: PAGE_SIZE,
      direction: filter,
      query,
      starredOnly,
    })
      .then(page => {
        if (request !== requestRef.current) return
        setFiles(previous => {
          const next = reset
            ? page.files
            : [...previous, ...page.files.filter(file => !previous.some(existing => existing.id === file.id))]
          filesRef.current = next
          return next
        })
        setHasMore(page.has_more)
        if (reset) setScrollTop(0)
      })
      .catch((e: Error) => {
        if (request === requestRef.current) setError(e.message)
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false)
      })
  }, [filter, query, starredOnly, token])

  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setQuery('')
      setSelected(null)
    }
    prevOpenRef.current = open
  }, [open])

  // The API owns filtering, allowing every filter and search result to keep
  // loading past the old fixed file-list cap. Typing is debounced to avoid
  // sending a request for every character.
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => load(true), query.trim() ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [filter, load, open, query, starredOnly])

  useEffect(() => {
    const node = viewportRef.current
    if (!node || !open) return
    const update = () => setViewport({ width: node.clientWidth, height: node.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const columns = viewport.width >= 768 ? 5 : viewport.width >= 640 ? 4 : 3
  const gridWidth = Math.max(0, viewport.width - GRID_PADDING)
  const cellSize = gridWidth > 0 ? (gridWidth - GRID_GAP * (columns - 1)) / columns : 120
  const rowStride = cellSize + GRID_GAP
  const rowCount = Math.ceil(files.length / columns)
  const totalHeight = Math.max(0, rowCount * rowStride - GRID_GAP)
  const startRow = Math.max(0, Math.floor(scrollTop / rowStride) - GRID_OVERSCAN_ROWS)
  const endRow = Math.min(
    rowCount,
    Math.ceil((scrollTop + viewport.height) / rowStride) + GRID_OVERSCAN_ROWS,
  )
  const visibleRows = useMemo(
    () => Array.from({ length: Math.max(0, endRow - startRow) }, (_, index) => startRow + index),
    [endRow, startRow],
  )

  const loadMoreIfNeeded = useCallback((top: number, height: number) => {
    if (!hasMore || loading || top + height < totalHeight - rowStride * 2) return
    load(false)
  }, [hasMore, load, loading, rowStride, totalHeight])

  function confirm() {
    const file = files.find(item => item.id === selected)
    if (!file) return
    onSelect(userFileToUploadedImage(file))
    onClose()
  }

  const selectedFile = files.find(file => file.id === selected)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-auto"
          variants={backdropVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <motion.div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            className="relative z-10 flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
            variants={panelVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            data-testid="imggen-image-picker-modal"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <h2 className="font-display text-base font-semibold">Pick from library</h2>
              <span className="text-xs text-muted-foreground">
                {files.length} image{files.length !== 1 ? 's' : ''}{hasMore ? '+' : ''}
              </span>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-4 py-2.5">
              <div className="relative min-w-36 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search…" className="h-8 bg-background pl-8 text-sm" data-testid="imggen-picker-search" />
              </div>
              <div className="flex gap-1">
                {(['all', 'input', 'output'] as DirectionFilter[]).map(direction => (
                  <button key={direction} type="button" onClick={() => setFilter(direction)} className={cn(
                    'relative min-h-8 rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                    filter === direction ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                  )} data-testid={`imggen-picker-filter-${direction}`}>
                    {filter === direction && <motion.span layoutId="picker-filter-pill" className="absolute inset-0 rounded-md bg-primary" style={{ zIndex: -1 }} transition={{ type: 'spring' as const, stiffness: 400, damping: 30 }} />}
                    {direction}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setStarredOnly(value => !value)} className={cn(
                'flex min-h-8 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                starredOnly ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )} aria-pressed={starredOnly} data-testid="imggen-picker-filter-starred">
                <Star className={cn('size-3.5', starredOnly && 'fill-current')} />
                Starred
              </button>
              <motion.button type="button" onClick={() => load(true)} disabled={loading} className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40" title="Refresh" whileTap={{ scale: 0.85 }}>
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              </motion.button>
            </div>

            <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" onScroll={event => {
              const { scrollTop: top, clientHeight } = event.currentTarget
              setScrollTop(top)
              loadMoreIfNeeded(top, clientHeight)
            }} data-testid="imggen-picker-grid">
              {error && <p className="py-4 text-sm text-destructive">{error}</p>}
              {!error && !loading && files.length === 0 && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                  <ImageIcon className="size-9 opacity-30" />
                  <p className="text-sm">No images found</p>
                </motion.div>
              )}
              <div className="relative" style={{ height: totalHeight }}>
                {visibleRows.map(row => (
                  <div
                    key={row}
                    className="absolute left-0 grid w-full gap-2"
                    style={{
                      top: row * rowStride,
                      height: cellSize,
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    }}
                  >
                    {files.slice(row * columns, (row + 1) * columns).map(file => {
                      const isSelected = selected === file.id
                      return (
                        <motion.button key={file.id} type="button" whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={() => setSelected(previous => previous === file.id ? null : file.id)} className={cn(
                          'group relative min-w-0 overflow-hidden rounded-xl border-2 bg-muted/30 transition-colors',
                          isSelected ? 'border-primary' : 'border-transparent',
                        )} data-testid={`imggen-picker-file-${file.id}`}>
                          <img src={imageThumbnailUrl(file.id, token)} alt={file.filename} className="size-full object-cover" loading="lazy" />
                          <div className="absolute left-1.5 top-1.5"><span className={cn(
                            'rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white opacity-0 transition-opacity group-hover:opacity-100',
                            isSelected && 'opacity-100', file.direction === 'output' ? 'bg-violet-500/90' : 'bg-sky-500/90',
                          )}>{file.direction}</span></div>
                          <div className={cn(
                            'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1.5 pt-3 opacity-0 transition-opacity group-hover:opacity-100', isSelected && 'opacity-100',
                          )}><p className="text-[10px] text-white/90">{file.width}×{file.height}</p></div>
                          {isSelected && <div className="absolute right-1.5 top-1.5 rounded-full bg-primary p-0.5 shadow"><Check className="size-3 text-primary-foreground" strokeWidth={3} /></div>}
                        </motion.button>
                      )
                    })}
                  </div>
                ))}
              </div>
              {loading && files.length > 0 && <div className="flex justify-center py-3 text-xs text-muted-foreground">Loading more images…</div>}
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3">
              <AnimatePresence mode="wait">
                {selectedFile ? (
                  <motion.span key="selected" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.15 }} className="flex max-w-xs items-center gap-1.5 truncate text-xs text-foreground">
                    <Check className="size-3 shrink-0 text-primary" strokeWidth={3} />
                    <span className="truncate">{selectedFile.filename}</span>
                    <span className="shrink-0 text-muted-foreground">{selectedFile.width}×{selectedFile.height}</span>
                  </motion.span>
                ) : (
                  <motion.span key="hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-xs text-muted-foreground">Click an image to select it</motion.span>
                )}
              </AnimatePresence>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
                <motion.div whileTap={{ scale: selected ? 0.95 : 1 }}>
                  <Button size="sm" disabled={!selected} onClick={confirm} data-testid="imggen-picker-confirm">Use image</Button>
                </motion.div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
