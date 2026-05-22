import { Outlet } from 'react-router-dom'
import { ProgressProvider } from '../contexts/ProgressContext'
import { WorkloadProvider } from '../contexts/WorkloadContext'
import { GlobalProgressDrawer } from './GlobalProgressDrawer'
import { TopBar } from './TopBar'

/** Authenticated app layout: shared top bar + page content below. */
export function AppShell() {
  return (
    <WorkloadProvider>
      <ProgressProvider>
        <div className="flex min-h-dvh flex-col" data-testid="app-shell">
          <TopBar />
          <GlobalProgressDrawer />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </div>
        </div>
      </ProgressProvider>
    </WorkloadProvider>
  )
}
