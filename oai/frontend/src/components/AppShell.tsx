import { Outlet } from 'react-router-dom'
import { TopBar } from './TopBar'

/** Authenticated app layout: shared top bar + page content below. */
export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col" data-testid="app-shell">
      <TopBar />
      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  )
}
