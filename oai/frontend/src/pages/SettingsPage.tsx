import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, ScrollText, Server } from 'lucide-react'
import { changePassword } from '../api/auth'
import { useAuth } from '../contexts/AuthContext'
import { useAdminStatus } from '../hooks/useAdminStatus'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function SettingsPage() {
  const { user, token } = useAuth()
  const { isAdmin } = useAdminStatus()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)

  const hasPasswordAccount = user?.google_id == null

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
      className="mx-auto min-h-0 w-full max-w-2xl flex-1 overflow-y-auto overscroll-contain px-6 py-8"
      data-testid="settings-page"
    >
        <h1 className="font-display mb-6 text-2xl font-bold">Settings</h1>

        <div className="flex flex-col gap-5">
          {/* Profile */}
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Your account information</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
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
              <Button disabled className="self-start">
                Save changes
              </Button>
            </CardContent>
          </Card>

          {/* Security */}
          <Card>
            <CardHeader>
              <CardTitle>Security</CardTitle>
              <CardDescription>Manage your password and authentication</CardDescription>
            </CardHeader>
            <CardContent>
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
                    className="self-start"
                    disabled={changingPassword}
                    data-testid="change-password-submit"
                  >
                    {changingPassword ? 'Updating…' : 'Change password'}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>

          {/* Preferences */}
          <Card>
            <CardHeader>
              <CardTitle>Preferences</CardTitle>
              <CardDescription>Customize your experience</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Theme</Label>
                <Input placeholder="System" disabled />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Language</Label>
                <Input placeholder="English" disabled />
              </div>
              <Button disabled className="self-start">
                Save preferences
              </Button>
            </CardContent>
          </Card>

          {/* Administration — admin only */}
          {isAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>Administration</CardTitle>
                <CardDescription>Server settings and system configuration</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
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
              </CardContent>
            </Card>
          )}
        </div>
    </main>
  )
}
