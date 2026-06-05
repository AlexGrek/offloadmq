/**
 * Server build version — public endpoint used to detect new deployments.
 *
 * Standalone like `auth.ts`: no auth token, no shared `apiRequest` helper.
 * The returned `version` is the backend's `OAI_BUILD_VERSION` (short git hash),
 * compared against this bundle's baked `VITE_APP_VERSION` to decide whether a
 * newer build has been deployed and the SPA should reload.
 */
export interface ServerVersion {
  version: string
}

/** The version this frontend bundle was built with, or `undefined` in dev. */
export const FRONTEND_VERSION: string | undefined = import.meta.env.VITE_APP_VERSION

export async function getServerVersion(signal?: AbortSignal): Promise<ServerVersion> {
  const res = await fetch('/api/version', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return res.json() as Promise<ServerVersion>
}
