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

Frontend runs at `http://localhost:5173`. All `/api/*` requests are proxied to the backend at `http://localhost:3000`.

## Build

```bash
task build
```

## API

| Method | Path         | Description    |
|--------|-------------|----------------|
| GET    | /api/health | Health check   |
