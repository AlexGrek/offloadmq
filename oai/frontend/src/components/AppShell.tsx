import { Outlet } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { DebugProvider, useDebug } from '../contexts/DebugContext'
import { DebugDrawer } from './DebugDrawer'
import { TopBar } from './TopBar'

function AppShellBody() {
  const { enabled, drawerOpen } = useDebug()
  return (
    <div className="flex min-h-dvh flex-col" data-testid="app-shell">
      <TopBar />
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col transition-[margin] duration-200',
          enabled && drawerOpen && 'md:mr-112',
        )}
      >
        <Outlet />
      </div>
      <DebugDrawer />
    </div>
  )
}

/** Authenticated app layout: shared top bar + page content below. */
export function AppShell() {
  return (
    <DebugProvider>
      <AppShellBody />
    </DebugProvider>
  )
}
