import { AnimatePresence, motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { COLLAPSE_MORPH, POP_MORPH, useMorph } from '@/lib/motion'

type MorphProps = {
  show: boolean
  children: ReactNode
  className?: string
  'data-testid'?: string
}

/**
 * Height collapse — for form sections that appear when a mode or toggle changes.
 * The wrapper clips its children while animating (see `COLLAPSE_MORPH`) and lets them
 * overflow once open, so popovers inside are not cut off. Pad the children, not this element.
 */
export function MorphCollapse({ show, children, className, 'data-testid': testId }: MorphProps) {
  const morph = useMorph()
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          {...COLLAPSE_MORPH}
          transition={morph.soft}
          className={className}
          data-testid={testId}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Fade + scale — for a single control that comes and goes inside a flex row. */
export function MorphIn({ show, children, className, 'data-testid': testId }: MorphProps) {
  const morph = useMorph()
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          layout
          {...POP_MORPH}
          transition={morph.spring}
          className={className}
          data-testid={testId}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
