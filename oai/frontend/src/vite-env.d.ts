/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Short git hash baked in at build time by `Taskfile.yml` (`build:frontend`).
   * Matches the backend's `OAI_BUILD_VERSION` (GET /api/version) and the Docker
   * image tag. Undefined in local dev (`npm run dev`) — version checks are
   * disabled in that case.
   */
  readonly VITE_APP_VERSION?: string
}
