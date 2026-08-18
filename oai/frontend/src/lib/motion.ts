import { useReducedMotion, type Transition } from 'framer-motion'

/** Snappy morph — small controls changing shape (tabs, pills, action buttons). */
export const MORPH_SPRING: Transition = { type: 'spring', stiffness: 420, damping: 34 }

/** Softer morph — large surfaces changing size (panels, media areas, collapsing sections). */
export const MORPH_SPRING_SOFT: Transition = { type: 'spring', stiffness: 260, damping: 30 }

/** Plain crossfade for content that should swap in place without sliding. */
export const MORPH_FADE: Transition = { duration: 0.18, ease: [0.22, 1, 0.36, 1] }

const INSTANT: Transition = { duration: 0 }

/** Height collapse for blocks that appear/disappear inside a form. Needs `overflow-hidden`. */
export const COLLAPSE_MORPH = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto' },
  exit: { opacity: 0, height: 0 },
} as const

/** Fade + scale for a single control coming and going inside a row. */
export const POP_MORPH = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.92 },
} as const

/**
 * Morph transitions that collapse to instant when the user asks for reduced motion.
 * Use instead of the raw constants inside components.
 */
export function useMorph() {
  const reduced = useReducedMotion()
  return {
    reduced: Boolean(reduced),
    spring: reduced ? INSTANT : MORPH_SPRING,
    soft: reduced ? INSTANT : MORPH_SPRING_SOFT,
    fade: reduced ? INSTANT : MORPH_FADE,
  }
}
