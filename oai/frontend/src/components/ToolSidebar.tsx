import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Shared collapsible tool sidebar shell (chat, image gen, and the offload-job
 * feature pages).
 *
 * - **Desktop** (`sm`+): inline column that collapses by width (`w-64` / `w-0`).
 * - **Mobile**: full-screen overlay over the page content with a close button;
 *   the page auto-collapses it on selection. Requires the page root to be
 *   `relative` so the overlay is contained below the global TopBar.
 */
export function ToolSidebar({
  title,
  open,
  isMobile,
  onClose,
  testId,
  headerAction,
  children,
}: {
  title: string
  open: boolean
  isMobile: boolean
  onClose: () => void
  testId?: string
  /** Optional control rendered in the header before the mobile close button. */
  headerAction?: ReactNode
  children: ReactNode
}) {
  return (
    <aside
      className={cn(
        'flex min-h-0 flex-col overflow-hidden border-r border-border bg-sidebar',
        isMobile
          ? open
            ? 'absolute inset-0 z-40 w-full'
            : 'hidden'
          : cn('shrink-0 transition-[width] duration-200', open ? 'w-64' : 'w-0'),
      )}
      data-testid={testId}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-semibold text-sidebar-foreground">{title}</span>
        <div className="flex items-center gap-1">
          {headerAction}
          {isMobile && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              title="Close"
              aria-label="Close sidebar"
              data-testid={testId ? `${testId}-close` : undefined}
            >
              <X />
            </Button>
          )}
        </div>
      </div>
      {children}
    </aside>
  )
}
