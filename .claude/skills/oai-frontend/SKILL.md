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

  contexts/
    AuthContext.tsx            # user + token state, login/register/logout

  hooks/
    useAdminStatus.ts          # calls amIAdmin once on mount; errors → isAdmin=false

  components/
    RequireAuth.tsx            # redirect to /login if not authenticated
    TopBar.tsx                 # reusable top bar with logo, My Account, Sign out
    ui/                        # shadcn components: button, card, input, label, alert

  pages/
    LandingPage.tsx            # public landing — non-interactive, see below
    LoginPage.tsx
    RegisterPage.tsx
    DashboardPage.tsx          # auth-required home, app grid
    ChatPage.tsx               # LLM chat UI
    SettingsPage.tsx           # user settings + admin section
    ServerConfigPage.tsx       # admin-only server configuration
```

---

## Routes

| Path | Auth | Component |
|------|------|-----------|
| `/` | public | `LandingPage` |
| `/login` | public | `LoginPage` |
| `/register` | public | `RegisterPage` |
| `/dashboard` | required | `DashboardPage` |
| `/chat` | required | `ChatPage` |
| `/settings` | required | `SettingsPage` |
| `/settings/server` | required + admin | `ServerConfigPage` |

`RequireAuth` wraps all protected routes and redirects to `/login` with a `from` state so the user is sent back after sign-in. Post-login/register redirects default to `/dashboard`.

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
| GET | `/api/admin/am_i_admin` | Returns `{ is_admin: boolean }` — always 200 for valid token |

### WebSocket
| Method | Path | Description |
|--------|------|-------------|
| WS | `/api/ws/chat` | LLM chat stream — requires Bearer token (sent as first message or query param) |

### Admin only (Bearer token, user must have `is_admin = true`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/settings` | Returns `AdminSettings` |
| POST | `/api/admin/settings` | Updates and returns `AdminSettings` |

**`AdminSettings` shape:**
```ts
{
  offloadmq_url: string
  client_api_token: string | null
  management_api_token: string | null
}
```

All API clients are in `src/api/`. Add new endpoint groups as new files there.

---

## Tech Stack

- **React 19** + TypeScript + Vite 8
- **Tailwind CSS v4** — config lives in CSS (`@theme` block in `index.css`), no `tailwind.config.js`
- **shadcn/ui** — components in `src/components/ui/`; add new ones with `npx shadcn add <name>`
- **react-router-dom v7** — client-side routing
- **lucide-react** — icons

---

## Design Conventions

### Fonts

Two fonts are in use — always respect the distinction:

| Class | Font | Use for |
|-------|------|---------|
| `font-display` | **Syne** (Google Fonts, loaded in `index.html`) | Page titles, hero headings, card titles, brand mark |
| `font-sans` (default) | **Geist Variable** | Body text, labels, inputs, descriptions |

Use `font-display` liberally on headings. Syne at bold/extrabold weights is the visual identity of the app.

### Dark and Light Modes

Both modes must be fully supported. Theme is managed by `ThemeContext` (`src/contexts/ThemeContext.tsx`):
- Stored in `localStorage` key `oai_theme`; falls back to `prefers-color-scheme` on first visit
- Applies/removes `.dark` class on `<html>` — the `@custom-variant dark (&:is(.dark *))` in `index.css` makes all Tailwind `dark:` utilities respond to it
- Toggled via the Sun/Moon button in `TopBar`
- `ThemeProvider` wraps the entire app in `App.tsx`

Use semantic tokens everywhere:
- `text-foreground`, `bg-background`, `text-muted-foreground`, `border-border`, etc.
- Never hardcode `#fff` / `#000` for content colors — always use Tailwind's semantic utilities or the CSS vars.
- The dark `oklch` palette is in the `.dark` block in `index.css`; the light palette is in `:root`.
- Test all new UI in both modes before considering it done.

### Mobile-First

All layouts start from mobile and scale up:
- Use responsive prefixes (`sm:`, `md:`, `lg:`) to add complexity at wider breakpoints.
- Default stack vertically; go side-by-side at `sm:` or `md:`.
- TopBar collapses labels at small screen (`hidden sm:inline`).
- Prefer `min-h-dvh` over `min-h-screen` for mobile viewport correctness.

### `data-testid` Attributes

Add `data-testid` to all interactive elements and key content containers. Follow the existing naming pattern:

```tsx
// Forms
data-testid="login-card"
data-testid="login-input"
data-testid="password-input"
data-testid="login-submit"
data-testid="login-error"

// Pages
data-testid="home-card"
data-testid="user-login"
data-testid="logout-button"
```

Rule: every `<form>`, `<Card>` root, primary `<Button>`, error `<Alert>`, and meaningful data display should have a `data-testid`. Naming: `<page>-<element>` in kebab-case.

### Asking About Design Decisions

Before implementing non-obvious UI choices, ask the user. Examples of things to confirm:

- Layout pattern for a new page (full-width vs centered, sidebar vs stacked)
- Whether a new section belongs in `SettingsPage` or a separate page
- Modal vs page navigation for an action
- Whether placeholder fields should be disabled or read-only
- Dark-mode color choices for new accent colors

Do NOT ask about: button variants (use `default`/`outline`/`ghost` per shadcn norms), icon choices (pick from lucide-react), or whether to use Tailwind (always yes).

---

## LandingPage — Non-Interactive

`/` is a **static marketing page** — no state, no forms, no user interaction beyond navigation links.

Rules:
- No auth-gated content or conditional rendering based on login state *within the page* (exception: redirect authenticated users to `/dashboard`)
- All CTAs are `<Link>` elements to `/login` or `/register`
- No API calls, no polling, no event handlers except the auth redirect
- Keep it visually polished: dark background (`bg-zinc-950`), dot-grid pattern, gradient hero text, feature cards
- The only "interactive" behavior is `useAuth()` to redirect logged-in users

---

## Complex Tasks — Always Use Todos

For any request that involves more than two files or a multi-step flow, create a todo list with `TodoWrite` before starting. Track each step and mark complete as you go. This prevents drift and makes partial work recoverable.

Example structure for "add image generation page":
```
- [ ] Create src/pages/ImageGenPage.tsx
- [ ] Add API helper to src/api/tasks.ts
- [ ] Register /image-gen route in App.tsx
- [ ] Add app card to DashboardPage
- [ ] Add data-testid attributes
- [ ] Verify dark mode
- [ ] Verify mobile layout
```

---

## Common Patterns

### New Page (auth-required)

1. Create `src/pages/MyPage.tsx` — wrap with `<TopBar />`, use `max-w-*` centered layout
2. Import and register in `App.tsx` inside a `<RequireAuth>` wrapper
3. Add `data-testid` to the page card/container and key elements
4. Add a link or card in `DashboardPage` if it's a top-level feature

### New API Module

Create `src/api/my-feature.ts`. Use the pattern from `src/api/auth.ts`:
- A private `request<T>()` helper that throws on non-OK responses
- Named exports for each endpoint
- TypeScript interfaces for request/response shapes matching the backend exactly

### New shadcn Component

```bash
cd oai/frontend
npx shadcn add <component-name>
```

The component lands in `src/components/ui/`. Import from `@/components/ui/<name>`.

### Auth Token

`useAuth()` exposes `token: string | null`. Pass it to API functions that require `Authorization: Bearer <token>`. The token is stored in `localStorage` under key `oai_token` and restored on mount via `/api/me`.

### Admin Guard

Use `useAdminStatus()` from `src/hooks/useAdminStatus.ts`. It calls `amIAdmin` once on mount and returns `{ isAdmin, loading }`. On any error (network, 401, 403) it resolves to `isAdmin = false` — never throws.

For pages that should hard-redirect non-admins:
```tsx
const { isAdmin, loading } = useAdminStatus()
useEffect(() => {
  if (!loading && !isAdmin) navigate('/settings', { replace: true })
}, [isAdmin, loading, navigate])
if (loading || !isAdmin) return <LoadingSpinner />
```
