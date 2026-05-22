import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useAdminStatus } from '../hooks/useAdminStatus'
import {
  getSettings,
  updateSettings,
  checkConnection,
  type AdminSettings,
  type CheckConnectionResponse,
} from '../api/admin'
import { TopBar } from '../components/TopBar'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const DEFAULT_SETTINGS: AdminSettings = {
  offloadmq_url: '',
  client_api_token: null,
  management_api_token: null,
}

export default function ServerConfigPage() {
  const { token } = useAuth()
  const { isAdmin, loading: adminLoading } = useAdminStatus()
  const navigate = useNavigate()

  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_SETTINGS)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [dataLoading, setDataLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<CheckConnectionResponse | null>(null)
  const [checkError, setCheckError] = useState('')

  useEffect(() => {
    if (!adminLoading && !isAdmin) navigate('/settings', { replace: true })
  }, [isAdmin, adminLoading, navigate])

  useEffect(() => {
    if (!token || adminLoading || !isAdmin) return
    getSettings(token)
      .then(setSettings)
      .catch((e: unknown) =>
        setLoadError(e instanceof Error ? e.message : 'Failed to load settings'),
      )
      .finally(() => setDataLoading(false))
  }, [token, isAdmin, adminLoading])

  function set<K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }))
    setSaveSuccess(false)
    setSaveError('')
    setCheckResult(null)
    setCheckError('')
  }

  async function handleCheckConnection() {
    if (!token) return
    setChecking(true)
    setCheckResult(null)
    setCheckError('')
    try {
      const result = await checkConnection(token, settings)
      setCheckResult(result)
    } catch (e: unknown) {
      setCheckError(e instanceof Error ? e.message : 'Connection check failed')
    } finally {
      setChecking(false)
    }
  }

  async function handleSave() {
    if (!token) return
    setSaving(true)
    setSaveError('')
    setSaveSuccess(false)
    try {
      const updated = await updateSettings(token, settings)
      setSettings(updated)
      setSaveSuccess(true)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  if (adminLoading || dataLoading) {
    return (
      <div className="flex min-h-dvh flex-col">
        <TopBar />
        <div className="flex flex-1 items-center justify-center">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-foreground" />
        </div>
      </div>
    )
  }

  if (!isAdmin) return null

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-8">
        <Link
          to="/settings"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to Settings
        </Link>

        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold">Server Configuration</h1>
          <div className="flex items-center gap-3">
            {saveSuccess && (
              <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
            )}
            {saveError && <span className="text-sm text-destructive">{saveError}</span>}
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>

        {loadError && (
          <Alert variant="destructive" className="mb-5">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-5">
          {/* OffloadMQ Connection */}
          <Card>
            <CardHeader>
              <CardTitle>OffloadMQ Connection</CardTitle>
              <CardDescription>
                Task queue server that routes AI work to agent nodes
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mq-url">Server URL</Label>
                <Input
                  id="mq-url"
                  placeholder="https://mq.example.com"
                  value={settings.offloadmq_url}
                  onChange={(e) => set('offloadmq_url', e.target.value)}
                  data-testid="mq-url-input"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="client-token">Client API Token</Label>
                <Input
                  id="client-token"
                  placeholder="client_…"
                  value={settings.client_api_token ?? ''}
                  onChange={(e) => set('client_api_token', e.target.value || null)}
                  data-testid="client-token-input"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mgmt-token">Management API Token</Label>
                <Input
                  id="mgmt-token"
                  placeholder="mgmt_…"
                  value={settings.management_api_token ?? ''}
                  onChange={(e) => set('management_api_token', e.target.value || null)}
                  data-testid="mgmt-token-input"
                />
              </div>

              <div className="flex flex-col gap-3">
                <Button
                  variant="outline"
                  onClick={handleCheckConnection}
                  disabled={checking || !settings.offloadmq_url}
                  className="self-start"
                  data-testid="check-connection-button"
                >
                  {checking ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Checking…
                    </>
                  ) : (
                    'Test Connection'
                  )}
                </Button>

                {checkError && (
                  <Alert variant="destructive" data-testid="check-connection-error">
                    <AlertDescription>{checkError}</AlertDescription>
                  </Alert>
                )}

                {checkResult && (
                  <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3" data-testid="check-connection-result">
                    {checkResult.client_token && (
                      <ConnectionTokenRow
                        label="Client token"
                        ok={checkResult.client_token.ok}
                        error={checkResult.client_token.error}
                      />
                    )}
                    {checkResult.management_token && (
                      <ConnectionTokenRow
                        label="Management token"
                        ok={checkResult.management_token.ok}
                        error={checkResult.management_token.error}
                      />
                    )}
                    {!checkResult.client_token && !checkResult.management_token && (
                      <p className="text-sm text-muted-foreground">No tokens to check.</p>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}

function ConnectionTokenRow({
  label,
  ok,
  error,
}: {
  label: string
  ok: boolean
  error: string | null
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
      ) : (
        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
      )}
      <span className="font-medium">{label}:</span>
      {ok ? (
        <span className="text-green-700 dark:text-green-400">OK</span>
      ) : (
        <span className="text-destructive">{error ?? 'Failed'}</span>
      )}
    </div>
  )
}
