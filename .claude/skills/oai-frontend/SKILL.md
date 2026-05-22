---
name: oai-frontend
description: Frontend engineer context for the OAI web app. Use when working on oai/frontend — pages, components, routing, API clients, styling, or adding new UI features to the AI workspace.
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
    AppShell.tsx               # authenticated layout: TopBar + <Outlet />
    TopBar.tsx                 # shared top bar (logo, theme, account, sign out)
    ui/                        # shadcn components: button, card, input, label, alert

  pages/
    LandingPage.tsx            # public landing — non-interactive, see below
    LoginPage.tsx
    RegisterPage.tsx
    DashboardPage.tsx          # app home, app grid
    ChatPage.tsx               # LLM chat UI (sidebar + messages)
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
| `/app/settings` | required | `SettingsPage` |
| `/app/settings/server` | required + admin | `ServerConfigPage` |

Legacy paths (`/dashboard`, `/chat`, `/settings`, …) redirect to `/app/*`.

`RequireAuth` wraps `/app` and redirects to `/login` with a `from` state. Post-login/register default: `/app/dashboard`.

**Layout rule:** Do not mount `<TopBar />` inside individual pages — it lives in `AppShell` only. Page content fills the flex area below the bar (`flex-1 min-h-0` for full-height pages like chat).

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

### Mobile-First

Default stack; `sm:`/`md:` for wider layouts. `min-h-dvh` on shell; chat uses `flex-1 min-h-0` inside shell.

### `data-testid` Attributes

Add to forms, cards, primary buttons, errors, and key containers. Naming: `<page>-<element>` kebab-case. Chat delete: `delete-chat-{id}`.

### Asking About Design Decisions

Confirm non-obvious layout/navigation before implementing. Do not ask about standard shadcn variants or Tailwind usage.

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
