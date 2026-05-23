import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SystemPage() {
  const [sysinfo, setSysinfo] = useState<Record<string, unknown>>({});
  const [updateInfo, setUpdateInfo] = useState<Record<string, unknown> | null>(
    null
  );
  const [port, setPort] = useState(8090);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api.getSystemInfo().then((r) => setSysinfo(r.sysinfo));
    api.getSettings().then((s) => setPort(s.webui_port ?? 8090));
  }, []);

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
        <CardHeader>
          <CardTitle className="text-base">Web UI port</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2 items-end">
          <div className="space-y-2 flex-1">
            <Label>Port (restart required)</Label>
            <Input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </div>
          <Button
            onClick={async () => {
              await api.saveSettings({ webui_port: port });
              setMessage("Saved — restart webui to apply");
            }}
          >
            Save
          </Button>
        </CardContent>
        {message && <p className="text-sm text-muted-foreground px-6 pb-4">{message}</p>}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">OS startup</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => api.setWinStartup(true).then(() => setMessage("Windows startup enabled"))}
          >
            Win startup on
          </Button>
          <Button
            variant="outline"
            onClick={() => api.setWinStartup(false)}
          >
            Win startup off
          </Button>
          <Button
            variant="outline"
            onClick={() => api.setMacStartup(true).then(() => setMessage("macOS LaunchAgent enabled"))}
          >
            macOS startup on
          </Button>
          <Button
            variant="outline"
            onClick={() => api.setMacStartup(false)}
          >
            macOS startup off
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              const r = await api.installSystemd();
              setMessage(r.message ?? JSON.stringify(r));
            }}
          >
            Install systemd (Linux)
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
