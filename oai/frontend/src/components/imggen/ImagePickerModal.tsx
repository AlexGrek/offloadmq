import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ImageIcon, RefreshCw, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listFiles } from '../../api/files'
import type { UserFile } from '../../api/files'
import { imageThumbnailUrl } from '../../api/images'
import type { UploadedImage } from '../../api/images'

type DirectionFilter = 'all' | 'input' | 'output'

// ── Animation variants ────────────────────────────────────────────────────────

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

const gridContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.03 } },
}

const gridItem = {
  hidden: { opacity: 0, scale: 0.88 },
  visible: {
    opacity: 1, scale: 1,
    transition: { type: 'spring' as const, stiffness: 400, damping: 28 },
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function userFileToUploadedImage(f: UserFile): UploadedImage {
  return {
    image_id: f.id,
    filename: f.filename,
    content_type: f.content_type,
    width: f.width,
    height: f.height,
    size_bytes: f.size_bytes,
    rescaled: false,
    reencoded: false,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ImagePickerModalProps {
  open: boolean
  onClose: () => void
  onSelect: (image: UploadedImage) => void
  token: string
}

export function ImagePickerModal({ open, onClose, onSelect, token }: ImagePickerModalProps) {
  const [files, setFiles] = useState<UserFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<DirectionFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    listFiles(token)
      .then(d => setFiles(d.files.filter(f => f.is_image)))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [token])

  // Reload whenever the modal opens; reset is done via resetRef on the open edge.
  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      // Reset on open edge — called before render via ref comparison, no extra render.
      setQuery('')
      setSelected(null)
      load()
    }
    prevOpenRef.current = open
  }, [open, load])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return files.filter(
      f =>
        (filter === 'all' || f.direction === filter) &&
        (q === '' || f.filename.toLowerCase().includes(q)),
    )
  }, [files, filter, query])

  function confirm() {
    const f = files.find(f => f.id === selected)
    if (!f) return
    onSelect(userFileToUploadedImage(f))
    onClose()
  }

  const selectedFile = files.find(f => f.id === selected)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          variants={backdropVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            className="relative z-10 flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
            variants={panelVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            data-testid="imggen-image-picker-modal"
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <h2 className="font-display text-base font-semibold">Pick from library</h2>
              <span className="text-xs text-muted-foreground">
                {files.length} image{files.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Toolbar */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-4 py-2.5">
              <div className="relative flex-1 min-w-36">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="h-8 pl-8 text-sm bg-background"
                  data-testid="imggen-picker-search"
                />
              </div>
              <div className="flex gap-1">
                {(['all', 'input', 'output'] as DirectionFilter[]).map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setFilter(d)}
                    className={cn(
                      'relative rounded-md px-2.5 py-1 text-xs font-medium transition-colors capitalize',
                      filter === d ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                    data-testid={`imggen-picker-filter-${d}`}
                  >
                    {filter === d && (
                      <motion.span
                        layoutId="picker-filter-pill"
                        className="absolute inset-0 rounded-md bg-primary"
                        style={{ zIndex: -1 }}
                        transition={{ type: 'spring' as const, stiffness: 400, damping: 30 }}
                      />
                    )}
                    {d}
                  </button>
                ))}
              </div>
              <motion.button
                type="button"
                onClick={load}
                disabled={loading}
                className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                title="Refresh"
                whileTap={{ scale: 0.85 }}
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              </motion.button>
            </div>

            {/* Grid */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {error && (
                <p className="text-sm text-destructive py-4">{error}</p>
              )}
              {!error && !loading && visible.length === 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground"
                >
                  <ImageIcon className="size-9 opacity-30" />
                  <p className="text-sm">No images found</p>
                </motion.div>
              )}

              <motion.div
                key={`${filter}-${query}`}
                className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5"
                variants={gridContainer}
                initial="hidden"
                animate="visible"
              >
                {visible.map(f => {
                  const isSelected = selected === f.id
                  return (
                    <motion.button
                      key={f.id}
                      type="button"
                      variants={gridItem}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => setSelected(prev => prev === f.id ? null : f.id)}
                      className={cn(
                        'group relative overflow-hidden rounded-xl border-2 bg-muted/30 transition-colors',
                        isSelected ? 'border-primary' : 'border-transparent',
                      )}
                      data-testid={`imggen-picker-file-${f.id}`}
                    >
                      <img
                        src={imageThumbnailUrl(f.id, token)}
                        alt={f.filename}
                        className="aspect-square w-full object-cover"
                        loading="lazy"
                      />

                      {/* Direction badge */}
                      <div className="absolute left-1.5 top-1.5">
                        <span className={cn(
                          'rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white opacity-0 transition-opacity group-hover:opacity-100',
                          isSelected && 'opacity-100',
                          f.direction === 'output' ? 'bg-violet-500/90' : 'bg-sky-500/90',
                        )}>
                          {f.direction}
                        </span>
                      </div>

                      {/* Dims overlay */}
                      <div className={cn(
                        'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1.5 pt-3 opacity-0 transition-opacity group-hover:opacity-100',
                        isSelected && 'opacity-100',
                      )}>
                        <p className="text-[10px] text-white/90">{f.width}×{f.height}</p>
                      </div>

                      {/* Check badge */}
                      <AnimatePresence>
                        {isSelected && (
                          <motion.div
                            initial={{ opacity: 0, scale: 0.5 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.5 }}
                            transition={{ type: 'spring' as const, stiffness: 500, damping: 30 }}
                            className="absolute right-1.5 top-1.5 rounded-full bg-primary p-0.5 shadow"
                          >
                            <Check className="size-3 text-primary-foreground" strokeWidth={3} />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.button>
                  )
                })}
              </motion.div>
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3">
              <AnimatePresence mode="wait">
                {selectedFile ? (
                  <motion.span
                    key="selected"
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -6 }}
                    transition={{ duration: 0.15 }}
                    className="flex items-center gap-1.5 text-xs text-foreground max-w-xs truncate"
                  >
                    <Check className="size-3 shrink-0 text-primary" strokeWidth={3} />
                    <span className="truncate">{selectedFile.filename}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {selectedFile.width}×{selectedFile.height}
                    </span>
                  </motion.span>
                ) : (
                  <motion.span
                    key="hint"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-xs text-muted-foreground"
                  >
                    Click an image to select it
                  </motion.span>
                )}
              </AnimatePresence>

              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={onClose}>
                  Cancel
                </Button>
                <motion.div whileTap={{ scale: selected ? 0.95 : 1 }}>
                  <Button
                    size="sm"
                    disabled={!selected}
                    onClick={confirm}
                    data-testid="imggen-picker-confirm"
                  >
                    Use image
                  </Button>
                </motion.div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
