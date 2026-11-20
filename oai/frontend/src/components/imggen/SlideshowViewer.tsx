import { useCallback, useEffect, useRef, useState } from 'react'
import { Expand, Minimize, MonitorPlay, Pause, Play, X } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type SlideshowViewerProps = {
  image: { src: string; alt: string; caption: string } | null
  paused: boolean
  onTogglePause: () => void
  onClose: () => void
}

export function SlideshowViewer({ image, paused, onTogglePause, onClose }: SlideshowViewerProps) {
  const surface = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setControlsVisible(false), 4000)
  }, [])

  useEffect(() => {
    timer.current = setTimeout(() => setControlsVisible(false), 4000)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [])

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === surface.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])

  async function toggleFullscreen() {
    setError(null)
    try {
      if (document.fullscreenElement === surface.current) await document.exitFullscreen()
      else await surface.current?.requestFullscreen()
    } catch {
      setError('Browser fullscreen is unavailable. The slideshow still fills this window.')
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent
        ref={surface}
        showClose={false}
        overlayClassName="bg-black"
        className="!fixed !inset-0 !left-0 !top-0 !h-dvh !max-h-none !w-dvw !max-w-none !translate-x-0 !translate-y-0 overflow-hidden rounded-none border-0 bg-black p-0 text-white shadow-none data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100"
        onPointerMove={revealControls}
        onPointerDown={revealControls}
        onKeyDown={revealControls}
        data-testid="imggen-slideshow"
      >
        <DialogTitle className="sr-only">Live image slideshow</DialogTitle>
        <DialogDescription className="sr-only">New generated images appear automatically. Pause to hold the current image. Generation continues while paused.</DialogDescription>
        {image ? (
          <img src={image.src} alt={image.alt} className="absolute inset-0 h-full w-full select-none object-contain" draggable={false} data-testid="imggen-slideshow-image" />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gradient-to-br from-violet-950 via-black to-cyan-950 px-6 text-center">
            <MonitorPlay className="size-12 text-violet-300" />
            <p className="text-sm text-white/70">Waiting for new images</p>
          </div>
        )}
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-4 bg-gradient-to-t from-black/90 to-transparent px-4 pt-20 pb-[max(1rem,env(safe-area-inset-bottom))] transition-opacity duration-300 sm:px-8 sm:pb-8',
            controlsVisible || paused || error ? 'opacity-100' : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100',
          )}
          data-testid="imggen-slideshow-controls"
        >
          <div className="min-w-0 flex-1 basis-48 space-y-2">
            <p className="font-display text-xl">Slideshow</p>
            <p role="status" className="text-xs text-white/70">{paused ? 'Paused · generation continues' : image ? 'Live · new images appear automatically' : 'Waiting for new images'}</p>
            {image && <p className="max-w-xl break-words text-xs text-white/60">{image.caption}</p>}
            {error && <p role="alert" className="max-w-xl text-sm text-rose-300">{error}</p>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" className="min-h-11 min-w-11" onClick={onTogglePause} aria-label={paused ? 'Resume slideshow' : 'Pause slideshow'} aria-pressed={paused} data-testid="imggen-slideshow-pause">{paused ? <Play /> : <Pause />}</Button>
            <Button variant="secondary" className="min-h-11 min-w-11" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? 'Exit browser fullscreen' : 'Enter browser fullscreen'} data-testid="imggen-slideshow-fullscreen">{fullscreen ? <Minimize /> : <Expand />}</Button>
            <Button variant="secondary" className="min-h-11 min-w-11" onClick={onClose} aria-label="Close slideshow" data-testid="imggen-slideshow-close"><X /></Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
