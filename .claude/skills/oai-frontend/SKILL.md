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

  components/
    RequireAuth.tsx            # redirect to /login if not authenticated
    AppShell.tsx               # h-dvh shell: TopBar + Outlet (overflow-hidden)
    TopBar.tsx                 # logo, Progress drawer, theme, account
    GlobalProgressDrawer.tsx   # global running jobs (chat + images)
    ToolDebugModal.tsx         # per-tool OffloadMQ poll debug (modal, icon trigger)
    chat/                      # SystemPromptStudio, SystemPromptBlock
    imggen/                    # ImageJobHistorySidebar, RescaleControls
    ui/                        # shadcn: button, card, input, dialog, label, alert

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

### Dark and Light Modes

`ThemeContext` — `localStorage` key `oai_theme`, `.dark` on `<html>`, toggle in `TopBar`. Use semantic tokens (`text-foreground`, `bg-background`, …). Test both modes.

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

Follow `src/api/auth.ts`: private `request<T>()`, typed exports, interfaces matching backend.

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

## Complex Tasks — Always Use Todos

For multi-file work, use `TodoWrite` before starting and mark steps complete as you go.
