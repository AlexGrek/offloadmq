import { Link } from 'react-router-dom'
import { ChevronRight, ScrollText, Server } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useAdminStatus } from '../hooks/useAdminStatus'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function SettingsPage() {
  const { user } = useAuth()
  const { isAdmin } = useAdminStatus()

  const memberSince = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '—'

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-8" data-testid="settings-page">
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
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Current password</Label>
                <Input type="password" placeholder="••••••••" disabled />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>New password</Label>
                <Input type="password" placeholder="••••••••" disabled />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Confirm new password</Label>
                <Input type="password" placeholder="••••••••" disabled />
              </div>
              <Button disabled className="self-start">
                Change password
              </Button>
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
