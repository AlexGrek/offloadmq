import { createContext, useContext } from 'react'
import type { ThemeDef, ThemeId, ThemeMode } from '@/lib/themes'

export interface ThemeContextValue {
  /** Selected theme id (see `THEMES` in `lib/themes.ts`). */
  theme: ThemeId
  /** Light-ish or dark-ish — use this, not `theme`, for light/dark decisions. */
  mode: ThemeMode
  themes: readonly ThemeDef[]
  setTheme: (id: ThemeId) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
