import { lazy, Suspense, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { publicWorldUrls } from '../api/worlds'

const SplatViewer = lazy(() => import('../components/worlds/SplatViewer'))

/**
 * Public, login-free full-screen viewer for a shared VR world
 * (`/worlds/view/:jobId?u=…&exp=…&sig=…`). Built for the Quest browser: the
 * signed query authorizes the PLY download, so no session or token is needed.
 */
export default function WorldViewerPage() {
  const { jobId } = useParams()
  const { search } = useLocation()
  const [openedAt] = useState(() => Date.now())
  const query = new URLSearchParams(search)
  const valid = jobId && query.get('u') && query.get('exp') && query.get('sig')

  if (!valid) {
    return (
      <div className="flex h-dvh items-center justify-center bg-black p-6 text-center text-white/80">
        This world link is incomplete. Ask for a new link from VR Worlds.
      </div>
    )
  }
  const signed = new URLSearchParams({ u: query.get('u')!, exp: query.get('exp')!, sig: query.get('sig')! })
  const expiry = Number(query.get('exp')) * 1000
  const expired = !Number.isFinite(expiry) || expiry <= openedAt

  return (
    <div className="h-dvh bg-black" data-testid="world-viewer-page">
      {expired ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-white/80">
          This world link has expired. Ask for a new link from VR Worlds.
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-white/70">
              <Loader2 className="mr-2 size-5 animate-spin" /> Loading viewer…
            </div>
          }
        >
          <SplatViewer url={publicWorldUrls(jobId, signed.toString()).scene} className="h-full w-full" prominentVr />
        </Suspense>
      )}
    </div>
  )
}
