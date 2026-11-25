import { useTheme } from '@/contexts/ThemeContext'
import { findTheme, type ThemeDef, type ThemeId } from '@/lib/themes'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

function Swatch({ theme }: { theme: ThemeDef }) {
  const [bg, accent] = theme.swatch
  return (
    <span
      aria-hidden
      className="size-4 shrink-0 rounded-full ring-1 ring-foreground/20"
      style={{ background: `linear-gradient(135deg, ${bg} 50%, ${accent} 50%)` }}
    />
  )
}

/** TopBar theme drop-down: themes grouped into light-ish and dark-ish. */
export function ThemePicker() {
  const { theme, themes, setTheme } = useTheme()
  const current = findTheme(theme)
  const label = current?.label ?? theme
  const groups = [
    { mode: 'light', title: 'Light' },
    { mode: 'dark', title: 'Dark' },
  ] as const

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Theme: ${label}`}
          title={`Theme: ${label}`}
          data-testid="theme-picker"
        >
          <span aria-hidden className="text-base leading-none">{current?.emoji}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" data-testid="theme-picker-menu">
        <DropdownMenuRadioGroup value={theme} onValueChange={(id) => setTheme(id as ThemeId)}>
          {groups.map((g, i) => (
            <div key={g.mode}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{g.title}</DropdownMenuLabel>
              {themes
                .filter((t) => t.mode === g.mode)
                .map((t) => (
                  <DropdownMenuRadioItem key={t.id} value={t.id} data-testid={`theme-option-${t.id}`}>
                    <span aria-hidden className="w-5 text-center text-base leading-none">{t.emoji}</span>
                    <Swatch theme={t} />
                    {t.label}
                  </DropdownMenuRadioItem>
                ))}
            </div>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
