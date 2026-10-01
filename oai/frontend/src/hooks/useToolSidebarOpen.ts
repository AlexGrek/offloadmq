import { useState } from 'react'

/**
 * Open state for a tool page's history sidebar: starts open on desktop, and
 * collapses whenever the viewport becomes narrow (on mobile the sidebar is a
 * full-screen overlay). The collapse is a render-phase adjustment — React's
 * "reset state when a value changes" pattern — rather than an effect, so it
 * never double-renders.
 */
export function useToolSidebarOpen(isMobile: boolean) {
  const [open, setOpen] = useState(() => !isMobile)
  const [prevIsMobile, setPrevIsMobile] = useState(isMobile)
  if (isMobile !== prevIsMobile) {
    setPrevIsMobile(isMobile)
    if (isMobile) setOpen(false)
  }
  return [open, setOpen] as const
}
