import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { KeepAwakeCard } from "@/components/KeepAwakeCard";
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
  // Windows debug
  win_exe?: string | null;
  win_frozen?: boolean;
  win_registry_value?: string | null;
  // macOS debug
  mac_exe?: string | null;
  mac_frozen?: boolean;
  mac_plist?: string | null;
  mac_log_dir?: string;
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
          <>
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
                onClick={() => act(() => api.setMacStartup(!status.mac_enabled))}
              >
                {status.mac_enabled ? "Enabled" : "Disabled"}
              </Button>
            </div>
            <div className="rounded bg-muted px-3 py-2 text-xs font-mono space-y-1">
              <div>
                <span className="text-muted-foreground">exe: </span>
                <span className="break-all">{status.mac_exe ?? "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">frozen: </span>
                <span className={status.mac_frozen ? "text-green-500" : "text-amber-500"}>
                  {String(!!status.mac_frozen)}
                </span>
                {!status.mac_frozen && (
                  <span className="text-amber-500 ml-2">
                    (running from source — exe path will be python)
                  </span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">plist: </span>
                {status.mac_plist ? (
                  <span className="text-green-500 whitespace-pre-wrap break-all">
                    {status.mac_plist}
                  </span>
                ) : (
                  <span className="text-muted-foreground italic">not installed</span>
                )}
              </div>
              {status.mac_log_dir && (
                <div>
                  <span className="text-muted-foreground">logs: </span>
                  <span>{status.mac_log_dir}/stdout.log</span>
                </div>
              )}
            </div>
          </>
        )}

        {platform === "win32" && (
          <>
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
                onClick={() => act(() => api.setWinStartup(!status.win_enabled))}
              >
                {status.win_enabled ? "Enabled" : "Disabled"}
              </Button>
            </div>
            <div className="rounded bg-muted px-3 py-2 text-xs font-mono space-y-1">
              <div>
                <span className="text-muted-foreground">exe: </span>
                <span className="break-all">{status.win_exe ?? "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">frozen: </span>
                <span className={status.win_frozen ? "text-green-500" : "text-amber-500"}>
                  {String(!!status.win_frozen)}
                </span>
                {!status.win_frozen && (
                  <span className="text-amber-500 ml-2">
                    (running from source — startup still works but exe path will be python.exe)
                  </span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">registry value: </span>
                {status.win_registry_value ? (
                  <span className="text-green-500 break-all">{status.win_registry_value}</span>
                ) : (
                  <span className="text-muted-foreground italic">not set</span>
                )}
              </div>
            </div>
          </>
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
      <KeepAwakeCard />
      <StartupCard />
    </div>
  );
}
