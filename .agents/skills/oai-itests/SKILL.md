---
name: oai-itests
description: >-
  Writing, modifying, or debugging Python integration tests for the OAI backend.
  Use when working on oai/itests/**, pytest fixtures, conftest.py, or adding test
  coverage for OAI API routes. Stack with oai-chat, oai-img, or oai-backend for the
  feature under test.
---

# OAI Integration Tests (oai/itests)

You are working on Python integration tests that run against the live OAI backend (Rust/Axum, port 3001).

## Source Code Locations

Always read these before writing or modifying tests:

| What | Where |
|------|-------|
| Router & route wiring | `oai/backend/src/app.rs` (`create_app` function) |
| Auth route handlers | `oai/backend/src/routes/auth.rs` |
| Chat route handlers | `oai/backend/src/routes/chats.rs` |
| Admin route handlers | `oai/backend/src/routes/admin.rs` |
| Image route handlers | `oai/backend/src/routes/images.rs` |
| Health handler | `oai/backend/src/routes/health.rs` |
| JWT extraction & middleware | `oai/backend/src/middleware/mod.rs` |
| Auth primitives (JWT encode/decode, bcrypt) | `oai/backend/src/middleware/auth.rs` |
| Error types & HTTP error shape | `oai/backend/src/error.rs` |
| Shared app state | `oai/backend/src/state.rs` |

## Test Project Layout

```
oai/itests/
├── pyproject.toml       # uv-managed project — deps: httpx, pytest, pytest-xdist
├── .gitignore
├── tests/
│   ├── __init__.py
│   ├── conftest.py      # ALL shared fixtures live here
│   ├── helpers.py       # auth_headers(), register(), login()
│   ├── test_health.py   # GET /api/health
│   ├── test_auth_register.py  # POST /api/auth/register
│   ├── test_auth_login.py     # POST /api/auth/login
│   ├── test_me.py       # GET /api/me
│   ├── test_chats.py    # GET/POST /api/chats, DELETE/GET /api/chats/{id}[/messages]
│   └── test_admin.py    # GET /api/admin/am_i_admin, admin-only guards
```

**One test file per route group.** When a new route is added, create a new `test_<route>.py`.

## API Contract

### Error shape

All error responses use a flat string body:
```json
{"error": "message here"}
```
Not a nested object — assert `body["error"]` is a `str`.

### Auth

Token delivered in the `Authorization: Bearer <token>` header (not a cookie). Token is obtained from the `token` field of the register/login response body.

### Status codes

| Route | Method | Success status |
|-------|--------|---------------|
| `/api/auth/register` | POST | 200 |
| `/api/auth/login` | POST | 200 |
| `/api/chats` | POST | 201 |
| `/api/chats/{id}` | DELETE | 204 (empty body) |
| All others | GET | 200 |

### Admin middleware

`/api/admin/settings`, `/api/admin/images/*` — requires `is_admin = true` in the DB. A regular authenticated user gets **403**, not 401. An unauthenticated request gets **401**.

`/api/admin/am_i_admin` is in the **authenticated** layer (not the admin layer) — any valid token returns 200 with `{"is_admin": false}`.

## Available Fixtures

Defined in `tests/conftest.py`:

| Fixture | Scope | Description |
|---------|-------|-------------|
| `base_url` | session | From `OAI_BASE_URL` env var; defaults to `http://localhost:3001` |
| `client` | session | `httpx.Client` with base_url and 10 s timeout |
| `fresh_client` | function | Clean client — use for unauthenticated tests to avoid auth state leaking |
| `unique_login` | function | Random `user_<hex>` string for test isolation |
| `registered_user` | session | Register a unique user once; returns `{login, password, user_id, token}` |
| `session_token` | session | JWT for `registered_user` |
| `session_headers` | session | `{"Authorization": "Bearer <session_token>"}` dict |
| `new_user` | function | Register a fresh user per test; returns `{login, password, user_id, token, headers}` — use when a test mutates or deletes state |

## Architecture Rules

1. **Fixtures go in `conftest.py`** — never define fixtures inside test files.

2. **Use classes to group tests** — `TestCreateChat`, `TestDeleteChat`, `TestGetMessages` in one file rather than flat functions.

3. **`new_user` for destructive tests** — any test that deletes or mutates owned resources should use `new_user` (function scope) rather than `registered_user` (session scope) to stay isolated.

4. **Test both happy path and auth failures** for every protected route:
   - Valid token → 200 + correct body
   - No token → 401
   - Invalid/garbage token → 401

5. **Ownership isolation tests** — for routes that scope resources by user, add a test that proves another user cannot access or mutate the resource (typically 404 or 403, not a data leak).

6. **No mocking** — these are integration tests against the real server.

7. **Keep tests independent** — no test should depend on another test's side effects.

8. **Dependency management** — use `uv` exclusively: `cd oai/itests && uv add <package>`.

9. **Sync only** — use `httpx.Client` synchronously; no need for `pytest-asyncio`.

## Running Tests

```bash
# From oai/itests/ — backend must already be running on port 3001
uv run pytest          # parallel (4 workers, default)
uv run pytest -v       # verbose

# Via Taskfile from oai/
task itest             # quiet
task itest:v           # verbose
task itest:v -- tests/test_chats.py   # single file

# Point at a different host
OAI_BASE_URL=http://prod:3001 uv run pytest
```

The backend requires Postgres to be running. Start infra with `task infra:up` from `oai/`, then `task dev:backend`.

## Conventions

- Type-hint fixture parameters: `client: httpx.Client`.
- Test names: `test_<what_it_checks>` — be specific, e.g., `test_other_user_cannot_delete` not `test_ownership`.
- Snowflake IDs are `i64` serialized as integers in the `user_id` response field, but **strings** in chat/message `id` fields.
