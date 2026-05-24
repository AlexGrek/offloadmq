import { Clock, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToolDebugHeaderButton } from '../ToolDebugModal'
import { WsStatusDot } from './WsStatusDot'

/** Chat main-column topbar: sidebar toggle, title, timing/debug actions, WS status. */
export function ChatHeader({
  sidebarOpen,
  onToggleSidebar,
  title,
  hasActiveChat,
  onOpenTimeout,
  onOpenDebug,
  debugActive,
  wsStatus,
}: {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  title: string
  hasActiveChat: boolean
  onOpenTimeout: () => void
  onOpenDebug: () => void
  debugActive: boolean
  wsStatus: string
}) {
  return (
    <header className="flex items-center gap-2 px-3 h-11 border-b border-border shrink-0">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleSidebar}
        title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
      >
        {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
      </Button>
      <span className="text-sm font-medium text-muted-foreground truncate">{title}</span>
      <span className="flex-1" />
      {hasActiveChat && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenTimeout}
            title="Timing settings"
            data-testid="timeout-settings-btn"
          >
            <Clock />
          </Button>
          <ToolDebugHeaderButton onClick={onOpenDebug} active={debugActive} />
        </>
      )}
      <WsStatusDot status={wsStatus} />
    </header>
  )
}
