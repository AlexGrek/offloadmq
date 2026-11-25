import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ThemeContext } from './ThemeContext'
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, THEMES, findTheme, type ThemeDef, type ThemeId } from '@/lib/themes'

const STORAGE_KEY = 'oai_theme'

function resolveInitialTheme(): ThemeDef {
  const stored = findTheme(localStorage.getItem(STORAGE_KEY))
  if (stored) return stored
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  return findTheme(prefersDark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME)!
}

function applyTheme(theme: ThemeDef) {
  const root = document.documentElement
  root.classList.toggle('dark', theme.mode === 'dark')
  root.dataset.theme = theme.id
  root.style.colorScheme = theme.mode
  localStorage.setItem(STORAGE_KEY, theme.id)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeDef>(() => {
    const t = resolveInitialTheme()
    applyTheme(t)
    return t
  })

  const setTheme = useCallback((id: ThemeId) => {
    const next = findTheme(id)
    if (!next) return
    applyTheme(next)
    setThemeState(next)
  }, [])

  const value = useMemo(
    () => ({ theme: theme.id as ThemeId, mode: theme.mode, themes: THEMES, setTheme }),
    [theme, setTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
