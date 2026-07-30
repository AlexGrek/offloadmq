import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface AiProcessingFrameProps {
  children: ReactNode
  className?: string
  testId?: string
}

const ROTOR_GRADIENT =
  'conic-gradient(from 0deg, transparent 0%, #8b5cf6 15%, #d946ef 30%, #22d3ee 45%, transparent 60%)'

/**
 * Wraps content with an animated rotating gradient border — used to mark the
 * one element actively being worked on by an AI agent.
 */
export function AiProcessingFrame({ children, className, testId }: AiProcessingFrameProps) {
  const reducedMotion = useReducedMotion()

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl p-px shadow-[0_0_28px_-8px_theme(colors.violet.500/0.55)]',
        className,
      )}
      data-testid={testId}
    >
      <motion.div
        aria-hidden
        className="absolute -inset-[100%]"
        style={{ background: ROTOR_GRADIENT }}
        animate={reducedMotion ? undefined : { rotate: 360 }}
        transition={reducedMotion ? undefined : { duration: 4, repeat: Infinity, ease: 'linear' }}
      />
      <div className="relative rounded-2xl bg-card bg-gradient-to-br from-violet-500/8 via-transparent to-cyan-500/8">
        {children}
      </div>
    </div>
  )
}
