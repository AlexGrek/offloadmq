import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type ReverseSubstitutionsButtonProps = {
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  'data-testid'?: string
}

/** Icon-only magic button: replaces values in the prompt with their `{placeholders}`. */
export function ReverseSubstitutionsButton({
  onClick,
  disabled,
  busy,
  'data-testid': testId = 'reverse-substitutions',
}: ReverseSubstitutionsButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled || busy}
      title="Magic: turn values like “red” into placeholders like {color}"
      aria-label="Reverse substitutions"
      data-testid={testId}
      className="text-violet-500 hover:bg-violet-500/10 hover:text-violet-400 dark:text-violet-400"
    >
      <Sparkles className={cn('size-4', busy && 'animate-pulse')} />
    </Button>
  )
}
