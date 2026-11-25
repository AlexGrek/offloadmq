/**
 * Theme registry — the single list of selectable UI themes.
 *
 * Adding a theme:
 *   1. Append an entry here (`id` must be a unique kebab-case string).
 *   2. Add a `[data-theme='<id>'] { … }` block in `src/index.css` that overrides the
 *      CSS variables it needs. Unset variables fall back to the base palette of its
 *      `mode` (`:root` for light, `.dark` for dark), so a theme can stay small.
 *
 * Every theme is either light-ish or dark-ish (`mode`). Dark-mode themes get the
 * `.dark` class on <html>, so Tailwind `dark:` variants keep working unchanged.
 */
export type ThemeMode = 'light' | 'dark'

export interface ThemeDef {
  id: string
  label: string
  mode: ThemeMode
  /** Background + accent colours shown as a preview dot in the theme picker. */
  swatch: [background: string, accent: string]
}

export const THEMES = [
  { id: 'light', label: 'Light', mode: 'light', swatch: ['oklch(1 0 0)', 'oklch(0.205 0 0)'] },
  { id: 'sepia', label: 'Sepia', mode: 'light', swatch: ['oklch(0.96 0.02 85)', 'oklch(0.45 0.08 55)'] },
  { id: 'dark', label: 'Dark', mode: 'dark', swatch: ['oklch(0.145 0 0)', 'oklch(0.922 0 0)'] },
  { id: 'graphite', label: 'Graphite', mode: 'dark', swatch: ['oklch(0.3 0 0)', 'oklch(0.85 0 0)'] },
  { id: 'midnight', label: 'Midnight', mode: 'dark', swatch: ['oklch(0.2 0.04 265)', 'oklch(0.7 0.14 250)'] },
] as const satisfies readonly ThemeDef[]

export type ThemeId = (typeof THEMES)[number]['id']

export const DEFAULT_LIGHT_THEME: ThemeId = 'light'
export const DEFAULT_DARK_THEME: ThemeId = 'dark'

export function findTheme(id: string | null | undefined): ThemeDef | undefined {
  return THEMES.find((t) => t.id === id)
}
