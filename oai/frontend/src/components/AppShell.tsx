import { Outlet } from 'react-router-dom'
import { ProgressProvider } from '../contexts/ProgressContext'
import { WorkloadProvider } from '../contexts/WorkloadContext'
import { GlobalProgressDrawer } from './GlobalProgressDrawer'
import { TopBar } from './TopBar'
import { UpdateBanner } from './UpdateBanner'

/** Authenticated app layout: shared top bar + page content below. */
export function AppShell() {
  return (
    <WorkloadProvider>
      <ProgressProvider>
        <div className="flex h-dvh min-h-0 flex-col overflow-hidden" data-testid="app-shell">
          <TopBar />
          <GlobalProgressDrawer />
          <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
            <Outlet />
          </div>
          <UpdateBanner />
        </div>
      </ProgressProvider>
    </WorkloadProvider>
  )
}
