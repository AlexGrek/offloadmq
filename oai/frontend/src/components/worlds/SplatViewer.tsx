import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { SparkControls, SparkRenderer, SparkXr, SplatMesh } from '@sparkjsdev/spark'
import { Glasses, Loader2, LocateFixed, Maximize, Minimize } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

/**
 * Gaussian-splat world viewer (three.js + Spark) with WebXR.
 *
 * The scene PLY is in the 3DGS/OpenCV frame (y down, z forward) with the
 * painting's camera at the origin; it is flipped to three.js and the XR session
 * uses the `local` reference space, so the opening view in the headset is the
 * painting's own viewpoint. Heavy: lazy-load the pages that use it.
 */

export type SplatViewerProps = {
  url: string
  className?: string
  testId?: string
  /** Larger Enter VR button for the standalone (headset) page. */
  prominentVr?: boolean
}

type Stats = { loadMs: number; fps: number; worstMs: number }

const VR_SCALES = [
  { value: 0.5, label: 'VR 50%' },
  { value: 0.75, label: 'VR 75%' },
  { value: 1, label: 'VR 100%' },
]

export default function SplatViewer({ url, className, testId = 'worlds-viewer', prominentVr }: SplatViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const xrRef = useRef<SparkXr | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const recenterRef = useRef<() => void>(() => {})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [xrSupported, setXrSupported] = useState(false)
  const [inXr, setInXr] = useState(false)
  const [vrScale, setVrScale] = useState(0.75)
  const vrScaleRef = useRef(vrScale)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    setLoading(true)
    setError(null)
    setStats(null)

    const renderer = new THREE.WebGLRenderer({ antialias: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    const spark = new SparkRenderer({ renderer })
    scene.add(spark)
    const camera = new THREE.PerspectiveCamera(70, (container.clientWidth || 1) / (container.clientHeight || 1), 0.05, 500)
    const rig = new THREE.Group()
    rig.add(camera)
    scene.add(rig)
    const recenter = () => {
      rig.position.set(0, 0, 0)
      rig.quaternion.identity()
      camera.position.set(0, 0, 0)
      camera.quaternion.identity()
    }
    recenterRef.current = recenter

    const controls = new SparkControls({ canvas: renderer.domElement })
    controls.fpsMovement.moveSpeed = 1
    // Track letters ourselves as well as physical codes: Firefox can report a
    // localized key when the active keyboard layout is not English.
    const movement = controls.fpsMovement
    const letters = ['W', 'A', 'S', 'D', 'Q', 'E']
    for (const letter of letters) {
      movement.keycodeMoveMapping[`viewer-${letter}`] = movement.keycodeMoveMapping[`Key${letter}`]
      delete movement.keycodeMoveMapping[`Key${letter}`]
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (event.type === 'keydown' && target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      const physical = event.code.startsWith('Key') ? event.code.slice(3) : ''
      const letter = letters.includes(physical) ? physical : event.key.toUpperCase()
      if (!letters.includes(letter)) return
      movement.keycode[`viewer-${letter}`] = event.type === 'keydown'
      event.preventDefault()
    }
    const clearKeys = () => { for (const letter of letters) movement.keycode[`viewer-${letter}`] = false }
    document.addEventListener('keydown', onKey)
    document.addEventListener('keyup', onKey)
    window.addEventListener('blur', clearKeys)

    // A detached element: SparkXr wires its own click listener to it, which under
    // StrictMode's double effect would make one real click enter *and* exit VR.
    // Our React button calls toggleXr() on the live instance instead.
    const xr = new SparkXr({
      renderer,
      element: document.createElement('button'),
      mode: 'vr',
      referenceSpaceType: 'local',
      frameBufferScaleFactor: vrScaleRef.current,
      controllers: { moveSpeed: 0.6 },
      onReady: supported => {
        if (!disposed) setXrSupported(supported)
      },
      onEnterXr: () => {
        recenter()
        if (!disposed) setInXr(true)
      },
      onExitXr: () => {
        if (!disposed) setInXr(false)
      },
    })
    xrRef.current = xr

    const mesh = new SplatMesh({ url })
    mesh.quaternion.set(1, 0, 0, 0) // OpenCV → three.js
    scene.add(mesh)
    const t0 = performance.now()
    let loadMs = 0
    mesh.initialized
      .then(() => {
        if (disposed) {
          mesh.dispose()
          return
        }
        loadMs = performance.now() - t0
        if (!disposed) setLoading(false)
      })
      .catch((e: unknown) => {
        if (!disposed) {
          setLoading(false)
          setError(e instanceof Error ? e.message : String(e))
        }
      })

    let frames = 0
    let windowStart = performance.now()
    let last = windowStart
    let worst = 0
    renderer.setAnimationLoop(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
      frames++
      if (now - windowStart >= 1000) {
        if (!disposed && loadMs > 0) setStats({ loadMs, fps: (frames * 1000) / (now - windowStart), worstMs: worst })
        frames = 0
        worst = 0
        windowStart = now
      }
      if (renderer.xr.isPresenting) xr.updateControllers(camera)
      else controls.update(rig, camera)
      renderer.render(scene, camera)
    })

    const resize = new ResizeObserver(() => {
      if (renderer.xr.isPresenting) return
      const w = container.clientWidth || 1
      const h = container.clientHeight || 1
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    resize.observe(container)

    return () => {
      disposed = true
      resize.disconnect()
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', clearKeys)
      void xr.session?.end()
      renderer.setAnimationLoop(null)
      scene.remove(mesh)
      mesh.dispose()
      spark.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      xrRef.current = null
      rendererRef.current = null
    }
  }, [url])

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === viewerRef.current)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === viewerRef.current) await document.exitFullscreen()
      else await viewerRef.current?.requestFullscreen()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change fullscreen mode')
    }
  }

  function changeVrScale(value: number) {
    setVrScale(value)
    vrScaleRef.current = value
    const renderer = rendererRef.current
    // Only effective between sessions; three.js ignores it while presenting.
    if (renderer && !renderer.xr.isPresenting) renderer.xr.setFramebufferScaleFactor(value)
  }

  return (
    <div ref={viewerRef} className={cn('relative overflow-hidden bg-black fullscreen:rounded-none', className)} data-testid={testId}>
      <div ref={containerRef} className="absolute inset-0 touch-none" />

      {loading ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/80">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading world…
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-red-300">
          Could not load this world: {error}
        </div>
      ) : null}

      <div className="absolute left-2 top-2 flex flex-wrap items-center gap-2 text-[11px] text-white/80">
        {stats ? (
          <span className="rounded bg-black/60 px-2 py-1 font-mono" data-testid={`${testId}-stats`}>
            load {(stats.loadMs / 1000).toFixed(2)} s · {stats.fps.toFixed(0)} fps · worst {stats.worstMs.toFixed(1)} ms
          </span>
        ) : null}
      </div>

      <div className="absolute bottom-2 left-2 right-2 flex flex-wrap items-center justify-between gap-2">
        <span className="hidden rounded bg-black/60 px-2 py-1 text-[11px] text-white/70 sm:inline">
          Drag to look · WASD/QE to move · Shift = fast
        </span>
        <div className="ml-auto flex items-center gap-2">
          {document.fullscreenEnabled ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => void toggleFullscreen()} data-testid={`${testId}-fullscreen`}>
              {fullscreen ? <Minimize className="mr-1 size-4" /> : <Maximize className="mr-1 size-4" />}
              {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => recenterRef.current()}
            data-testid={`${testId}-recenter`}
          >
            <LocateFixed className="mr-1 size-4" /> Recenter
          </Button>
          {xrSupported ? (
            <>
              <select
                className="h-8 rounded-md bg-secondary px-2 text-xs text-secondary-foreground"
                value={vrScale}
                onChange={e => changeVrScale(Number(e.target.value))}
                disabled={inXr}
                aria-label="VR render resolution"
                data-testid={`${testId}-vr-scale`}
              >
                {VR_SCALES.map(s => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size={prominentVr ? 'lg' : 'sm'}
                onClick={() => void xrRef.current?.toggleXr()}
                data-testid="worlds-enter-vr"
              >
                <Glasses className="mr-1 size-4" /> {inXr ? 'Exit VR' : 'Enter VR'}
              </Button>
            </>
          ) : (
            <span
              className="rounded bg-black/60 px-2 py-1 text-[11px] text-white/70"
              data-testid="worlds-vr-unavailable"
              title="Open this page in the Quest browser, or on a PC with Quest Link running"
            >
              VR not available in this browser
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
