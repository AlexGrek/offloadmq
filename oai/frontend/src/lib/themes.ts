/**
 * Theme registry — the single list of selectable UI themes.
 *
 * Adding a theme:
 *   1. Append an entry here (`id` must be a unique kebab-case string).
 *   2. Add its CSS under `src/themes/`:
 *      - Palette theme: a `:root[data-theme='<id>'] { … }` block in `palettes.css`
 *        overriding colour variables. Unset variables fall back to the base palette
 *        of its `mode` (`:root` for light, `.dark` for dark).
 *      - Styled theme: its own `src/themes/<id>.css` (imported from `index.css`). It
 *        may also set `--radius`, `--app-font-sans` / `--app-font-display`, and
 *        restyle elements through their `data-slot` / `data-variant` hooks (see
 *        `win98.css`, `liquid-glass.css`).
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
  { id: 'ukraine', label: 'Ukraine', emoji: '🇺🇦', mode: 'light', swatch: ['oklch(0.47 0.14 255)', 'oklch(0.87 0.17 95)'] },
  { id: 'win98', label: 'Windows 98', emoji: '🪟', mode: 'light', swatch: ['#c0c0c0', '#000080'] },
  { id: 'liquid-glass', label: 'Liquid Glass', emoji: '🫧', mode: 'light', swatch: ['oklch(0.86 0.08 230)', 'oklch(0.58 0.2 258)'] },
  { id: 'dark', label: 'Dark', emoji: '🌑', mode: 'dark', swatch: ['oklch(0.145 0 0)', 'oklch(0.922 0 0)'] },
  { id: 'graphite', label: 'Graphite', emoji: '🪨', mode: 'dark', swatch: ['oklch(0.3 0 0)', 'oklch(0.85 0 0)'] },
  { id: 'midnight', label: 'Midnight', emoji: '🌌', mode: 'dark', swatch: ['oklch(0.2 0.04 265)', 'oklch(0.7 0.14 250)'] },
  { id: 'amethyst', label: 'Amethyst', emoji: '🔮', mode: 'dark', swatch: ['oklch(0.18 0.05 300)', 'oklch(0.8 0.12 310)'] },
  { id: 'ember', label: 'Ember', emoji: '🔥', mode: 'dark', swatch: ['oklch(0.21 0.045 262)', 'oklch(0.74 0.17 55)'] },
  { id: 'hacker-green', label: 'Hacker Green', emoji: '📟', mode: 'dark', swatch: ['oklch(0.14 0.02 150)', 'oklch(0.87 0.22 145)'] },
  { id: 'hacker-blue', label: 'Hacker Blue', emoji: '💠', mode: 'dark', swatch: ['oklch(0.14 0.035 255)', 'oklch(0.8 0.14 232)'] },
  { id: 'hacker-white', label: 'Hacker White', emoji: '💀', mode: 'dark', swatch: ['oklch(0.12 0 0)', 'oklch(0.96 0 0)'] },
] as const satisfies readonly ThemeDef[]

export type ThemeId = (typeof THEMES)[number]['id']

export const DEFAULT_LIGHT_THEME: ThemeId = 'light'
export const DEFAULT_DARK_THEME: ThemeId = 'dark'

export function findTheme(id: string | null | undefined): ThemeDef | undefined {
  return THEMES.find((t) => t.id === id)
}
