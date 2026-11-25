import { useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Activity,
  ChevronRight,
  Lock,
  MessageSquareText,
  ScrollText,
  Server,
  ShieldCheck,
  Sparkles,
  User,
  type LucideIcon,
} from 'lucide-react'
import { changePassword } from '../api/auth'
import { useAuth } from '../contexts/AuthContext'
import { useAdminStatus } from '../hooks/useAdminStatus'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { VersionInfo } from '../components/VersionInfo'
import { PromptDefaultsSettings } from '../components/PromptDefaultsSettings'
import { ReverseSubstitutionSettings } from '../components/ReverseSubstitutionSettings'

type SettingsTabId = 'account' | 'security' | 'prompts' | 'substitutions' | 'admin'

interface SettingsTab {
  id: SettingsTabId
  label: string
  icon: LucideIcon
}

const BASE_TABS: SettingsTab[] = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'security', label: 'Security', icon: Lock },
  { id: 'prompts', label: 'Prompts', icon: MessageSquareText },
  { id: 'substitutions', label: 'Substitutions', icon: Sparkles },
]

const ADMIN_TAB: SettingsTab = { id: 'admin', label: 'Admin', icon: ShieldCheck }

const VALID_TAB_IDS = new Set<string>([...BASE_TABS.map(t => t.id), ADMIN_TAB.id])

export default function SettingsPage() {
  const { user, token } = useAuth()
  const { isAdmin, loading: adminLoading } = useAdminStatus()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabRefs = useRef<Partial<Record<SettingsTabId, HTMLButtonElement | null>>>({})

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)

  const hasPasswordAccount = user?.google_id == null

  const tabs = useMemo(
    () => (isAdmin ? [...BASE_TABS, ADMIN_TAB] : BASE_TABS),
    [isAdmin],
  )

  const rawTab = searchParams.get('tab')
  const requestedTab: SettingsTabId =
    rawTab && VALID_TAB_IDS.has(rawTab) ? (rawTab as SettingsTabId) : 'account'

  const activeTab: SettingsTabId =
    requestedTab === 'admin' && !isAdmin && !adminLoading ? 'account' : requestedTab

  function selectTab(nextTab: SettingsTabId) {
    const next = new URLSearchParams(searchParams)
    if (nextTab === 'account') {
      next.delete('tab')
    } else {
      next.set('tab', nextTab)
    }
    setSearchParams(next, { replace: true })
  }

  function handleTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, currentId: SettingsTabId) {
    const idx = tabs.findIndex(t => t.id === currentId)
    if (idx === -1) return

    let nextIdx: number | null = null
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') nextIdx = 0
    else if (e.key === 'End') nextIdx = tabs.length - 1

    if (nextIdx === null) return
    e.preventDefault()
    const target = tabs[nextIdx]
    selectTab(target.id)
    tabRefs.current[target.id]?.focus()
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    if (!token) return
    setPasswordError('')
    setPasswordSuccess(false)
    if (newPassword.length < 6) {
      setPasswordError('New password must be at least 6 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match')
      return
    }
    setChangingPassword(true)
    try {
      await changePassword(token, currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordSuccess(true)
    } catch (err: unknown) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to change password')
    } finally {
      setChangingPassword(false)
    }
  }

  const memberSince = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '—'

  return (
    <main
      className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 sm:py-8"
      data-testid="settings-page"
    >
      <h1 className="font-display mb-5 text-2xl font-bold">Settings</h1>

      <nav
        className="mb-6 flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border border-border bg-muted/30 p-1 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Settings sections"
        data-testid="settings-tabs"
      >
        {tabs.map(({ id, label, icon: Icon }) => {
          const selected = activeTab === id
          return (
            <button
              key={id}
              ref={el => {
                tabRefs.current[id] = el
              }}
              type="button"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={selected}
              aria-controls={`settings-panel-${id}`}
              tabIndex={selected ? 0 : -1}
              data-testid={`settings-tab-${id}`}
              onClick={() => selectTab(id)}
              onKeyDown={e => handleTabKeyDown(e, id)}
              className={cn(
                'inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors sm:px-4',
                selected
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{label}</span>
            </button>
          )
        })}
      </nav>

      <div
        id={`settings-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
        data-testid={`settings-panel-${activeTab}`}
      >
        {activeTab === 'account' && (
          <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-4 py-2" data-testid="settings-profile-section">
              <div>
                <h2 className="font-display text-lg font-semibold">Profile</h2>
                <p className="text-sm text-muted-foreground">Your account information</p>
              </div>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Username</Label>
                  <Input value={user?.login ?? ''} readOnly />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Display name</Label>
                  <Input placeholder="Not set" disabled />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Member since</Label>
                  <Input value={memberSince} readOnly />
                </div>
                <Button disabled className="min-h-11 self-start">
                  Save changes
                </Button>
              </div>
            </section>

            <section
              className="flex flex-col gap-4 border-t border-border pt-6"
              data-testid="settings-preferences-section"
            >
              <div>
                <h2 className="font-display text-lg font-semibold">Preferences</h2>
                <p className="text-sm text-muted-foreground">Customize your experience</p>
              </div>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Theme</Label>
                  <Input placeholder="System" disabled />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Language</Label>
                  <Input placeholder="English" disabled />
                </div>
                <Button disabled className="min-h-11 self-start">
                  Save preferences
                </Button>
              </div>
            </section>
          </div>
        )}

        {activeTab === 'security' && (
          <section className="flex flex-col gap-4 py-2" data-testid="settings-security-section">
            <div>
              <h2 className="font-display text-lg font-semibold">Security</h2>
              <p className="text-sm text-muted-foreground">
                Manage your password and authentication
              </p>
            </div>
            {!hasPasswordAccount ? (
              <p className="text-sm text-muted-foreground">
                This account uses an external sign-in provider; password cannot be changed here.
              </p>
            ) : (
              <form
                className="flex flex-col gap-4"
                onSubmit={handleChangePassword}
                data-testid="change-password-form"
              >
                {passwordError && (
                  <Alert variant="destructive" data-testid="change-password-error">
                    <AlertDescription>{passwordError}</AlertDescription>
                  </Alert>
                )}
                {passwordSuccess && (
                  <Alert data-testid="change-password-success">
                    <AlertDescription>Password updated successfully.</AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="current-password">Current password</Label>
                  <Input
                    id="current-password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={currentPassword}
                    onChange={e => setCurrentPassword(e.target.value)}
                    required
                    data-testid="current-password-input"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-password">New password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    required
                    minLength={6}
                    data-testid="new-password-input"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm-new-password">Confirm new password</Label>
                  <Input
                    id="confirm-new-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    required
                    minLength={6}
                    data-testid="confirm-new-password-input"
                  />
                </div>
                <Button
                  type="submit"
                  className="min-h-11 self-start"
                  disabled={changingPassword}
                  data-testid="change-password-submit"
                >
                  {changingPassword ? 'Updating…' : 'Change password'}
                </Button>
              </form>
            )}
          </section>
        )}

        {activeTab === 'prompts' && <PromptDefaultsSettings />}

        {activeTab === 'substitutions' && <ReverseSubstitutionSettings />}

        {activeTab === 'admin' && isAdmin && (
          <section className="flex flex-col gap-4 py-2" data-testid="settings-admin-section">
            <div>
              <h2 className="font-display text-lg font-semibold">Administration</h2>
              <p className="text-sm text-muted-foreground">
                Server settings and system configuration
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Link
                to="/app/settings/server"
                className="group flex items-center justify-between rounded-lg border border-border p-4 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <Server className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Server Configuration</p>
                    <p className="text-xs text-muted-foreground">
                      OffloadMQ connection, model defaults, system settings
                    </p>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
              </Link>
              <Link
                to="/app/settings/diagnostics"
                className="group flex items-center justify-between rounded-lg border border-border p-4 transition-colors hover:bg-muted/50"
                data-testid="settings-diagnostics-link"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Diagnostics</p>
                    <p className="text-xs text-muted-foreground">
                      App, Postgres, and Garage pod status and logs
                    </p>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
              </Link>
              <Link
                to="/app/settings/worker-logs"
                className="group flex items-center justify-between rounded-lg border border-border p-4 transition-colors hover:bg-muted/50"
                data-testid="settings-worker-logs-link"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <ScrollText className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Image Pipeline Worker</p>
                    <p className="text-xs text-muted-foreground">
                      Background reconcile passes, duration, and errors
                    </p>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
              </Link>
            </div>
          </section>
        )}
      </div>

      <VersionInfo className="mt-8 pt-1 text-center" />
    </main>
  )
}
