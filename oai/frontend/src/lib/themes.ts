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
  /** Emoji logo shown in the theme picker. */
  emoji: string
  mode: ThemeMode
  /** Background + accent colours shown as a preview dot in the theme picker. */
  swatch: [background: string, accent: string]
}

export const THEMES = [
  { id: 'light', label: 'Light', emoji: '☀️', mode: 'light', swatch: ['oklch(1 0 0)', 'oklch(0.205 0 0)'] },
  { id: 'sepia', label: 'Sepia', emoji: '📜', mode: 'light', swatch: ['oklch(0.96 0.02 85)', 'oklch(0.45 0.08 55)'] },
  { id: 'tangerine', label: 'Tangerine', emoji: '🍊', mode: 'light', swatch: ['oklch(1 0 0)', 'oklch(0.7 0.18 55)'] },
  { id: 'sky', label: 'Sky', emoji: '🌤️', mode: 'light', swatch: ['oklch(0.97 0.012 230)', 'oklch(0.52 0.14 245)'] },
  { id: 'ukraine', label: 'Ukraine', emoji: '🇺🇦', mode: 'light', swatch: ['oklch(0.985 0.025 95)', 'oklch(0.47 0.14 255)'] },
  { id: 'dark', label: 'Dark', emoji: '🌑', mode: 'dark', swatch: ['oklch(0.145 0 0)', 'oklch(0.922 0 0)'] },
  { id: 'graphite', label: 'Graphite', emoji: '🪨', mode: 'dark', swatch: ['oklch(0.3 0 0)', 'oklch(0.85 0 0)'] },
  { id: 'midnight', label: 'Midnight', emoji: '🌌', mode: 'dark', swatch: ['oklch(0.2 0.04 265)', 'oklch(0.7 0.14 250)'] },
  { id: 'amethyst', label: 'Amethyst', emoji: '🔮', mode: 'dark', swatch: ['oklch(0.18 0.05 300)', 'oklch(0.8 0.12 310)'] },
  { id: 'ember', label: 'Ember', emoji: '🔥', mode: 'dark', swatch: ['oklch(0.21 0.045 262)', 'oklch(0.74 0.17 55)'] },
] as const satisfies readonly ThemeDef[]

export type ThemeId = (typeof THEMES)[number]['id']

export const DEFAULT_LIGHT_THEME: ThemeId = 'light'
export const DEFAULT_DARK_THEME: ThemeId = 'dark'

export function findTheme(id: string | null | undefined): ThemeDef | undefined {
  return THEMES.find((t) => t.id === id)
}
