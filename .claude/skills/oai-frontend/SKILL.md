---
name: oai-frontend
description: >-
  Frontend engineer context for the OAI web app. Use when working on oai/frontend/**
  — pages, components, routing, API clients, styling, AppShell layout, or adding
  new UI features. Stack with oai-chat or oai-img when editing feature-specific files.
---

# OAI Frontend — Engineering Context

OAI is a standalone AI workspace SPA: users log in, chat with LLMs, submit image generation/analysis tasks. The frontend lives in `oai/frontend/` and talks to a Rust/Axum backend at `oai/backend/`.

---

## Running Locally

```bash
# From oai/ — starts Postgres, backend (port 3001), and Vite (port 5174) concurrently
task dev

# Teardown
task kill    # kills ports 3001 + 5174, stops Docker infra

# Frontend only (backend already running)
cd oai/frontend && npm run dev   # http://localhost:5174

# Backend only
cd oai/backend && cargo run
```

Vite proxies `/api/*` → `http://localhost:3001`. The backend reads config from `oai/backend/.env`.

---

## File Map

```
oai/frontend/src/
  App.tsx                     # router root
  index.css                   # Tailwind v4 theme + font imports
  main.tsx

  api/
    auth.ts                   # register, login, me
    admin.ts                  # amIAdmin, getSettings, updateSettings
    chats.ts                  # listChats, createChat, deleteChat, getChatMessages

  contexts/
    AuthContext.tsx            # user + token state, login/register/logout

  hooks/
    useAdminStatus.ts          # calls amIAdmin once on mount; errors → isAdmin=false
    useWsChat.ts               # WebSocket chat + capability list
    usePromptLibrary.ts        # paged saved-prompts loader: debounced server search, keyset loadMore, stale-page guard

  components/
    RequireAuth.tsx            # redirect to /login if not authenticated
    AppShell.tsx               # h-dvh shell: TopBar + Outlet (overflow-hidden)
    TopBar.tsx                 # logo, Progress drawer, theme, account
    ThemePicker.tsx            # TopBar theme drop-down (registry: lib/themes.ts)
    GlobalProgressDrawer.tsx   # global running jobs (chat + images)
    ToolDebugModal.tsx         # per-tool OffloadMQ poll debug (modal, icon trigger)
    PromptTextarea.tsx         # textarea + list icon → SavedPromptsDrawer (`previews` prop for image buckets)
    prompts/                   # SavedPromptsDrawer (right Sheet: tabs, server search, view modes, infinite scroll), PromptEntryCard
    chat/                      # SystemPromptStudio, SystemPromptBlock
    imggen/                    # ImageJobHistorySidebar, RescaleControls
    ui/                        # shadcn: button, card, input, dialog, sheet, label, alert

  pages/
    LandingPage.tsx            # public landing — non-interactive, see below
    LoginPage.tsx
    RegisterPage.tsx
    DashboardPage.tsx          # app home, app grid
    ChatPage.tsx               # LLM chat (sidebar + transcript + pinned input)
    ImageGenerationPage.tsx    # pipelines sidebar: New + jobs
    FilesPage.tsx              # read-only file browser
    SettingsPage.tsx           # user settings + admin section
    ServerConfigPage.tsx       # admin-only server configuration
```

---

## Routes

Public routes are top-level. Authenticated app routes live under `/app` and share `AppShell` (single `TopBar` at the outer layout).

| Path | Auth | Component |
|------|------|-----------|
| `/` | public | `LandingPage` |
| `/login` | public | `LoginPage` |
| `/register` | public | `RegisterPage` |
| `/app/dashboard` | required | `DashboardPage` |
| `/app/chat` | required | `ChatPage` |
| `/app/images` | required | `ImageGenerationPage` |
| `/app/gallery` | required | `GalleryPage` |
| `/app/files` | required | `FilesPage` |
| `/app/settings` | required | `SettingsPage` |
| `/app/settings/server` | required + admin | `ServerConfigPage` |

Legacy paths (`/dashboard`, `/chat`, `/settings`, …) redirect to `/app/*`.

`RequireAuth` wraps `/app` and redirects to `/login` with a `from` state. Post-login/register default: `/app/dashboard`.

**Layout rule:** Do not mount `<TopBar />` inside individual pages — it lives in `AppShell` only. The outlet area is `flex-1 min-h-0 overflow-hidden` — each page must declare how it scrolls:

- **Full-height tools** (chat, images): page root `flex min-h-0 flex-1 overflow-hidden` with internal scroll panes.
- **Document-style pages** (settings, dashboard, files, admin): page root `min-h-0 flex-1 overflow-y-auto overscroll-contain` on `<main>`.

---

## Backend API Reference

All routes are proxied through Vite in dev; in production, the Rust backend serves both.

### Public
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/auth/register` | `{ login, password }` → `{ token, user_id }` |
| POST | `/api/auth/login` | `{ login, password }` → `{ token, user_id }` |

### Authenticated (Bearer token)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/me` | Returns current `User` object |
| GET | `/api/admin/am_i_admin` | Returns `{ is_admin: boolean }` |
| GET | `/api/chats` | List user's chats |
| POST | `/api/chats` | Create chat → `ChatSummary` |
| DELETE | `/api/chats/{id}` | Delete chat (204) |
| GET | `/api/chats/{id}/messages` | Message history |

### WebSocket
| Method | Path | Description |
|--------|------|-------------|
| WS | `/api/ws/chat` | LLM chat stream — Bearer token |

### Admin only
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/settings` | `AdminSettings` |
| POST | `/api/admin/settings` | Update `AdminSettings` |

All API clients are in `src/api/`. Add new endpoint groups as new files there.

---

## Tech Stack

- **React 19** + TypeScript + Vite 8
- **Tailwind CSS v4** — `@theme` in `index.css`, no `tailwind.config.js`
- **shadcn/ui** — `src/components/ui/`; add with `npx shadcn add <name>`
- **react-router-dom v7** — nested routes under `/app`
- **lucide-react** — icons

---

## Design Conventions

### Fonts

| Class | Font | Use for |
|-------|------|---------|
| `font-display` | **Syne** | Page titles, hero headings, brand mark |
| `font-sans` (default) | **Geist Variable** | Body, labels, inputs |

### Themes (light-ish / dark-ish)

OAI has multiple named themes, each with a `mode` of `light` or `dark`. There are two kinds:

- **Palette themes** only recolour: Light, Sepia, Tangerine, Sky (light); Dark, Graphite, Midnight, Amethyst, Ember (dark).
- **Styled themes** also change radius, fonts and how elements look: **Windows 98** (`win98`: bevels, title-bar dialogs, square corners, Tahoma) and **Liquid Glass** (`liquid-glass` light / `liquid-glass-dark`: frosted translucent panes over a wallpaper, pill buttons; one file — the dark variant only overrides tokens and the `--lg-*` / `--glass-*` knobs), **Windows 8 Dark** (`win8-dark`: Metro — flat, square, Segoe UI Light headings, 2px-outlined buttons, white text boxes, accent-band dialogs), **Crimson** (`crimson`, dark: red on near-black, glowing red top-bar rule), **Windows Aero** (`aero`, light: Win7 glass frames over a sky wallpaper, glossy split-gradient buttons with blue hover glow), **Material** (`material`, light: indigo app bar — it re-points `--foreground`/`--muted*` on the top bar so its children turn white — elevation shadows, uppercase buttons, filled underline fields, Roboto), **Love** (`love`, light: blush + red/rose, tiled-heart `<body>` wallpaper, pill gradient buttons, Dancing Script headings, ♥ dialog titles), **Parry Hotter** (`parry-hotter`, light: parchment + ink, scarlet/gold, Cinzel / Cinzel Decorative / EB Garamond from Google Fonts in `index.html`, gold double-ruled panes, ✦ dialog titles), **Ukraine** (`ukraine`: blue/yellow palette with a flag stripe under the top bar), and **Hacker Green / Blue / White** (`hacker-*`, dark: monospace, phosphor glow, scanlines; one shared `hacker.css` where each variant sets only `--hk`, `--hk-dim`, `--hk-bg`, so a new colour is three lines plus a registry entry), and **Gradients** (`aurora`, `synthwave`, `nebula` dark; `sherbet`, `lagoon` light: multi-colour radial wallpaper painted as a `<body>` background, frosted cards, gradient-sweep primary buttons, gradient top-bar hairline; one shared `gradients.css` where each variant sets `--g1..--g3`, `--g-bg`, `--g-fg`, `--g-on`, `--g-wash`). No theme may lay a fixed overlay (`::before`/`::after`) over content or `filter` it — it tints generated images; e2e checks this.

| Piece | Where | Role |
|-------|-------|------|
| Registry | `src/lib/themes.ts` | `THEMES` array: `{ id, label, emoji, mode, swatch: [bg, accent] }` is the single source of truth. `emoji` is required (shown in the picker) |
| Base tokens | `src/index.css` | `:root` = base light, `.dark` = base dark. Also `--radius`, `--app-font-sans`, `--app-font-display` |
| Theme CSS | `src/themes/` | `palettes.css` holds one `:root[data-theme='<id>']` block per palette theme. Each styled theme has its own `<id>.css`. All are imported at the top of `index.css` |
| State | `contexts/ThemeContext.ts` + `ThemeProvider.tsx` | `useTheme()` returns `{ theme, mode, themes, setTheme }`. `localStorage` key `oai_theme` stores the theme **id** |
| Picker | `components/ThemePicker.tsx` | `TopBar` drop-down (`components/ui/dropdown-menu.tsx`, radix), grouped Light / Dark, each item with its emoji and swatch |

On `<html>` the provider sets `data-theme="<id>"` and `color-scheme`, and toggles `.dark` for every dark-mode theme, so Tailwind `dark:` variants work unchanged in all dark themes. An unknown stored id falls back to `light` or `dark` according to `prefers-color-scheme`.

**What a theme can change**, everything scoped under `:root[data-theme='<id>']`:

1. **Colours**: the shadcn variables (`--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--border`, `--input`, `--ring`, `--sidebar-*`). Anything not overridden falls back to the base palette of the theme's mode. Keep `--background`, `--popover` and `--sidebar*` **opaque**: components use them as covers (`bg-background/80` badges, image-tile overlays like `from-background/72`, custom `bg-popover` pickers), and a translucent token turns those see-through. Put translucency on surfaces via slot rules instead (Liquid Glass makes `<body>` transparent and frosts cards, dialogs and `.bg-popover`). Keep `--sidebar` the same lightness as the mode: a dark sidebar in a light theme puts dark text on dark tiles.
2. **Radius**: `--radius`. Every `rounded-sm` through `rounded-4xl` utility derives from it, so `0rem` squares the whole app.
3. **Fonts**: `--app-font-sans` (body, `font-sans`) and `--app-font-display` (`font-display` headings).
4. **Element looks**: rules on `data-slot` hooks. Theme files are **unlayered**, so they beat Tailwind utilities on the same element; that is how a theme replaces the shadcn look.

| Hook | Element |
|------|---------|
| `[data-slot='button']` + `[data-variant='default'\|'outline'\|'secondary'\|'ghost'\|'destructive'\|'link']`, `[data-size]` | `ui/button` (kept even when wrapped by a Radix `asChild` trigger) |
| `[data-slot='card']` | `ui/card` |
| `dialog-content`, `dialog-header`, `dialog-title`, `dialog-description`, `dialog-footer`, `dialog-overlay`, `dialog-close-button` | `ui/dialog` |
| `sheet-content`, `sheet-header`, `sheet-footer`, `sheet-close-button` | `ui/sheet` |
| `dropdown-menu-content`, `dropdown-menu-radio-item` | `ui/dropdown-menu` |
| `[data-slot='input']`, plus raw `input` / `textarea` / `select` | form fields; many pages use raw elements, so target both |
| `[data-slot='topbar']` | the `TopBar` header |

**Adding a theme:**
1. Append an entry to `THEMES` with a unique kebab-case id, the right `mode`, an `emoji` and a `swatch`.
2. For a palette theme, add a `:root[data-theme='<id>'] { … }` block to `src/themes/palettes.css`. For a styled theme, create `src/themes/<id>.css` and `@import` it at the top of `index.css`. Copy `win98.css` or `liquid-glass.css` as a template.
3. Add it to `e2e/tests/themes.spec.ts`.

The picker shows new themes automatically.

**Rules:**
- Use semantic tokens (`text-foreground`, `bg-background`, `bg-muted/50`, …). Hard-coded neutrals (`bg-zinc-900`, `text-black`) break non-default themes.
- For light/dark decisions in code (e.g. CodeMirror `{ dark }`), use `useTheme().mode`, **never** `theme === 'dark'`; that misses every other dark theme.
- `dark:` colour accents (`dark:text-violet-300`) are fine; they apply to every dark-mode theme.
- New shared UI primitives get a `data-slot` (and `data-variant` if they have variants) so themes can reach them. Don't style pages by theme id; keep theme-specific CSS in `src/themes/`.
- Don't give raw fields that are transparent by design a fill; exclude them with `:not(.bg-transparent)` (e.g. the chat composer textarea sits inside its own rounded frame).
- `--accent` / `--sidebar-accent` are paired with plain foreground text all over the app (selected rows, hovers), so keep them light in light themes; put strong highlight colours on specific slots instead (Win98 navy menu items).
- In theme CSS, override `background-color` (not the `background` shorthand) on `select` so the native arrow survives. Remember that `backdrop-filter` makes an element the containing block for `position: fixed` descendants.
- E2E: pick a theme via `getByTestId('theme-picker')` → `theme-option-<id>`, then wait for `theme-picker-menu` to be hidden before clicking the trigger again. Or seed `localStorage.oai_theme` with an id. Test at least one light and one dark theme, and a styled theme when touching shared primitives.

### Mobile-First (required)

Design for **narrow viewports first**, then enhance at `sm:` / `md:` / `lg:`. Every full-height tool page must work on a phone without horizontal scroll or double-scroll traps.

#### Layout shell

- `AppShell`: `flex h-dvh min-h-0 flex-col overflow-hidden` — the app never scrolls as a whole; only designated panes scroll.
- Outlet wrapper: `flex min-h-0 flex-1 basis-0 flex-col overflow-hidden`.
- Tool pages (chat, images): root `flex min-h-0 flex-1 overflow-hidden` (do **not** rely on `h-full` alone without `min-h-0`).

#### Independent scroll regions

Each sidebar and main column is its own scroll context:

```tsx
// Column
flex min-h-0 flex-1 basis-0 flex-col overflow-hidden
// Scrollable list / transcript
min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain
// Pinned chrome (header, input, “New” row)
shrink-0
```

- **Chat:** sidebar chat list scrolls alone; transcript scrolls alone; composer is **fixed below** the transcript (never inside the scroll area).
- **Images:** sidebar “New” is `shrink-0` at top; job list scrolls below; main area scrolls independently.

#### Touch targets

- Primary actions on mobile: `min-h-11` (44px) minimum; full-width where it helps (`w-full sm:w-auto`).
- Mode toggles / paired buttons: `flex-1` on mobile, intrinsic width from `sm:` up.
- Icon-only header actions: `size="icon-sm"` with `aria-label` + `title` (e.g. debug bug icon).

#### Spacing

- Page content padding: `px-3 py-4` default, `sm:px-6 sm:py-5` on wider screens.
- Prefer vertical rhythm (`gap-4` / `gap-5`) over boxing every block in a card.

### Flat UI — less frames, fewer borders (required)

OAI tools should feel **open and content-first**, not like nested admin panels. Default to flat sections; reserve visible frames for secondary or archival UI.

#### Do

- **Primary workflows** (chat composer, image “New job” form): plain `<section>` or stacked layout — **no** wrapping `Card` (shadcn `Card` adds `ring-1`).
- Separate regions with **spacing**, **typography** (`font-display` headings), and light fills (`bg-muted/30`, `bg-muted/50`).
- Keep **one** border where it carries meaning: shell dividers (`border-b border-border`), sidebar edge (`border-r`), pinned input top rule.
- Form controls keep normal input borders (usability); decorative chrome around the whole form does not.
- Upload / drop zones: `rounded-lg bg-muted/50` — not dashed `border-dashed` frames unless explicitly requested.
- Image previews: soft background, no picture frame border unless needed for contrast.
- Job/history sidebar tiles: subtle `ring-1` on list items is OK; avoid stacking card-in-card.

#### Avoid

- `Card` around an entire mobile-first form (use for **job detail / read-only summaries** only, e.g. completed pipeline view).
- Extra nested boxes, double rings, or `border` on every subsection.
- Putting the chat input inside the scrolling messages area.
- Page-level scroll that moves sidebar and content together.

#### Reference implementations

| Surface | Pattern |
|---------|---------|
| Chat transcript + input | `ChatPage.tsx` — `basis-0` scroll pane; `border-t` on input footer only |
| Image “New job” | `ImageGenerationPage.tsx` — `<section data-testid="imggen-new-panel">`, no Card |
| Image job detail | `Card` OK — status, outputs, poll/cancel |
| System prompt in thread | `SystemPromptBlock` — dashed accent is intentional, not a full panel frame |

### Tool-specific UX rules

- **Chat auto-scroll:** Pin to bottom only while user is at bottom; any scroll up disables follow; scrolling back to end re-enables. Use `scrollTop` on the transcript node, not `scrollIntoView` on ancestors.
- **Images sidebar:** Pinned **New** entry (`IMGGEN_NEW_PANEL`); generation form state lives in page state and **persists** when viewing jobs; job rows show status/thumbnail, not prompts.
- **Progress:** Global drawer from `TopBar` — not per-page panels.
- **Debug:** Icon-only in page header → `ToolDebugModal` (OffloadMQ poll JSON only; no WebSocket event dump).
- **Authenticated images:** `imageFileUrl(id, token)` appends `?token=` — `<img src>` cannot send `Authorization`.
- **Model / capability:** Always a **select or picker** populated from OffloadMQ (`useWsChat` / `listImgGenCapabilities`). Never a free-text `<Input>` for capability strings. Submit only when the value is in the current list (`pickListedCapability` / `isListedCapability` in `src/lib/capability-picker.ts`).

### `data-testid` Attributes

Add to forms, primary buttons, errors, and key containers. Naming: `<page>-<element>` kebab-case. Examples: `imggen-new-panel`, `chat-sidebar-list`, `messages-area`, `delete-chat-{id}`.

### Asking About Design Decisions

Confirm non-obvious layout/navigation before implementing. Do not ask about standard shadcn variants, touch-target sizes, or flat-vs-card choices — follow this doc.

---

## LandingPage — Non-Interactive

`/` is static marketing — no forms/API. Only `useAuth()` redirect to `/app/dashboard` when logged in. CTAs link to `/login` / `/register`.

---

## Common Patterns

### New Page (auth-required)

1. Create `src/pages/MyPage.tsx` — no `TopBar`; use centered `main` or full-height `flex-1 min-h-0`
2. Register in `App.tsx` under the `/app` route group (sibling of `dashboard`, `chat`)
3. Add `data-testid` on container and key elements
4. Add dashboard card in `DashboardPage` if top-level feature

### New API Module

Authenticated clients import the shared fetch helper — `import { apiRequest as request } from './http'` — then write typed functions + interfaces matching the backend. Do **not** re-declare a local `request<T>`; `api/http.ts` handles `Authorization: Bearer <token>`, JSON vs FormData, `{ error }` unwrapping, and `204`. The only exception is `api/auth.ts` (public, no token, base-URL prefixed) — leave it standalone.

### Auth Token

`useAuth()` → `token`. Stored as `oai_token` in `localStorage`; restored via `/api/me`.

### Admin Guard

`useAdminStatus()` → `{ isAdmin, loading }`. Redirect non-admins:

```tsx
useEffect(() => {
  if (!loading && !isAdmin) navigate('/app/settings', { replace: true })
}, [isAdmin, loading, navigate])
```

---

## Tests

Frontend E2E tests use Playwright and live in `oai/e2e/`.
- **Run tests:** `cd oai/e2e && npm test`
- **Run with UI:** `cd oai/e2e && npm run test:ui`
- Note: Requires the OAI app to be running (`task dev`). Ensure they pass before committing.

## Complex Tasks — Always Use Todos

For multi-file work, use `TodoWrite` before starting and mark steps complete as you go.
