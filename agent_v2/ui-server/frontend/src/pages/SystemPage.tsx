import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveIndicator } from "@/components/SaveIndicator";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";

type StartupStatus = {
  platform: string;
  mac_enabled: boolean;
  win_enabled: boolean;
  systemd_installed: boolean;
};

function StartupCard() {
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = () =>
    api.getStartupStatus().then(setStatus).catch(() => setStatus(null));

  useEffect(() => { load(); }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      const r = await fn();
      if (r && typeof r === "object" && "message" in r) {
        setMessage((r as { message?: string }).message ?? "");
      }
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  const { platform } = status;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">OS startup</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {platform === "darwin" && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">macOS LaunchAgent</p>
              <p className="text-xs text-muted-foreground">
                Runs omq-gui at login via ~/Library/LaunchAgents
              </p>
            </div>
            <Button
              variant={status.mac_enabled ? "default" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() =>
                act(() => api.setMacStartup(!status.mac_enabled))
              }
            >
              {status.mac_enabled ? "Enabled" : "Disabled"}
            </Button>
          </div>
        )}

        {platform === "win32" && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Windows startup</p>
              <p className="text-xs text-muted-foreground">
                Runs omq-gui at login via HKCU registry
              </p>
            </div>
            <Button
              variant={status.win_enabled ? "default" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() =>
                act(() => api.setWinStartup(!status.win_enabled))
              }
            >
              {status.win_enabled ? "Enabled" : "Disabled"}
            </Button>
          </div>
        )}

        {platform === "linux" && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">systemd user service</p>
              <p className="text-xs text-muted-foreground">
                ~/.config/systemd/user/offloadmq-agent.service
              </p>
            </div>
            {status.systemd_installed ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => act(api.uninstallSystemd)}
              >
                Uninstall
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => act(api.installSystemd)}
              >
                Install
              </Button>
            )}
          </div>
        )}

        {platform !== "darwin" && platform !== "win32" && platform !== "linux" && (
          <p className="text-sm text-muted-foreground">
            Startup management is not supported on this platform ({platform}).
          </p>
        )}

        {message && (
          <p className="text-xs text-muted-foreground">{message}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function SystemPage() {
  const [sysinfo, setSysinfo] = useState<Record<string, unknown>>({});
  const [updateInfo, setUpdateInfo] = useState<Record<string, unknown> | null>(
    null
  );
  const [port, setPort] = useState(8090);

  const { schedule, flush, status } = useDebouncedSave<number>((next) =>
    api.saveSettings({ webui_port: next })
  );

  useEffect(() => {
    api.getSystemInfo().then((r) => setSysinfo(r.sysinfo));
    api.getSettings().then((s) => setPort(s.webui_port ?? 8090));
  }, []);

  const editPort = (next: number) => {
    setPort(next);
    schedule(next);
  };

  const checkUpdate = async () => {
    setUpdateInfo(await api.checkUpdate());
  };

  const download = async () => {
    setUpdateInfo(await api.downloadUpdate());
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">System</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Hardware</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs overflow-auto max-h-48">
            {JSON.stringify(sysinfo, null, 2)}
          </pre>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Updates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Button variant="outline" onClick={checkUpdate}>
              Check
            </Button>
            <Button onClick={download}>Download</Button>
          </div>
          {updateInfo && (
            <pre className="text-xs">{JSON.stringify(updateInfo, null, 2)}</pre>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Web UI port</CardTitle>
          <SaveIndicator status={status} />
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>Port (restart the web UI to bind a new port)</Label>
          <Input
            type="number"
            value={port}
            onChange={(e) => editPort(Number(e.target.value))}
            onBlur={flush}
            onKeyDown={(e) => e.key === "Enter" && flush()}
          />
        </CardContent>
      </Card>
      <StartupCard />
    </div>
  );
}
