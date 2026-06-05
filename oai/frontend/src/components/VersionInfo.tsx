import { FRONTEND_VERSION } from '../api/version'

/**
 * Low-key display of the build this UI is running. Reads the version baked into
 * the bundle at build time (`VITE_APP_VERSION`); shows `dev` in local dev.
 * Deploy detection / reload prompting lives in `UpdateBanner` (mounted globally).
 */
export function VersionInfo({ className }: { className?: string }) {
  const version = FRONTEND_VERSION && FRONTEND_VERSION !== 'dev' ? FRONTEND_VERSION : 'dev'

  return (
    <p
      className={`text-xs text-muted-foreground ${className ?? ''}`}
      data-testid="version-info"
    >
      OAI · <span className="font-mono">{version}</span>
    </p>
  )
}
