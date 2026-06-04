import { useEffect, useState } from 'react'

/** Tailwind `sm` breakpoint is 640px; below it we treat the viewport as mobile. */
const MOBILE_QUERY = '(max-width: 639px)'

function matches(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
}

/**
 * Reactive mobile-viewport flag. Initialized synchronously from `matchMedia`
 * (correct on first paint) and updated when the viewport crosses the breakpoint.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(matches)

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
