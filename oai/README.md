# oai

Full-stack app with a Rust/Axum backend and a React + TypeScript + Vite frontend.

## Structure

```
oai/
├── backend/      # Rust + Axum API server (port 3000)
├── frontend/     # React + TypeScript + Vite (port 5173)
├── Taskfile.yml
└── README.md
```

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- [Task](https://taskfile.dev/) (`brew install go-task`)

## Development

```bash
# Install frontend deps (first time)
task install

# Start both servers concurrently
task dev
```

Frontend runs at `http://localhost:5174`. All `/api/*` requests are proxied to the backend at `http://localhost:3001`.

On first startup the backend creates a root admin if none exists:

| Login | Password |
|-------|----------|
| `root` | `000000` (override with `ROOT_ADMIN_PASSWORD`) |

Copy `backend/.env.example` to `backend/.env` when running `cargo run` outside `task dev` (includes `STORAGE_BACKEND=fs` for local OpenDAL file storage under `backend/.data/storage`).

To disable storage explicitly: `STORAGE_BACKEND=none`.

If you already booted once with a random password, reset Postgres data: `task infra:destroy` then `task infra:up`.

## Build

```bash
task build
```

## API

| Method | Path         | Description    |
|--------|-------------|----------------|
| GET    | /api/health | Health check   |
