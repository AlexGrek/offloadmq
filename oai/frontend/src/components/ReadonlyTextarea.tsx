import { useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export interface ReadonlyTextareaProps {
  value: string
  className?: string
  ariaLabel?: string
  testId?: string
}

/**
 * A `<textarea readOnly>` that grows to fit its full content — never clips,
 * still looks and behaves like an editable field (selectable, focusable),
 * just can't be typed into.
 */
export function ReadonlyTextarea({ value, className, ariaLabel, testId }: ReadonlyTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const lastWidthRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const borderHeight = el.offsetHeight - el.clientHeight
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + borderHeight}px`
  }, [value])

  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return

    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width == null) return
      if (lastWidthRef.current !== null && Math.abs(width - lastWidthRef.current) < 1) return
      lastWidthRef.current = width
      const borderHeight = el.offsetHeight - el.clientHeight
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight + borderHeight}px`
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  return (
    <textarea
      ref={ref}
      value={value}
      readOnly
      rows={1}
      spellCheck={false}
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        'block w-full resize-none overflow-hidden rounded-md border border-input bg-background/50 px-3 py-2 leading-relaxed outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        className,
      )}
    />
  )
}
