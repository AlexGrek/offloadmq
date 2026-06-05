import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type StartupStatus = {
  platform: string;
  gui_mode: boolean;
  keep_awake_available: boolean;
  keep_awake_active: boolean;
  keep_awake_enabled: boolean;
  keep_awake_method: string;
};

function platformHint(platform: string): string {
  if (platform === "darwin") {
    return "Uses caffeinate to prevent display and system sleep.";
  }
  if (platform === "win32") {
    return "Uses Windows execution-state flags to prevent sleep.";
  }
  if (platform === "linux") {
    return "Uses systemd-inhibit, D-Bus screensaver, or xdg-screensaver.";
  }
  return "Platform-specific sleep inhibition.";
}

export function KeepAwakeCard({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = () =>
    api.getStartupStatus().then(setStatus).catch(() => setStatus(null));

  useEffect(() => {
    load();
  }, []);

  if (!status?.gui_mode) return null;

  const toggle = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api.setKeepAwake(!status.keep_awake_enabled);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkbox = (
    <label className="flex items-center gap-2 text-sm shrink-0 cursor-pointer">
      <input
        type="checkbox"
        checked={status.keep_awake_enabled}
        disabled={busy || !status.keep_awake_available}
        onChange={() => void toggle()}
      />
      Keep awake
    </label>
  );

  if (compact) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">Prevent sleep while GUI is open</p>
            {status.keep_awake_active && status.keep_awake_method ? (
              <p className="text-xs text-muted-foreground truncate">
                Active via {status.keep_awake_method}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {!status.keep_awake_available
                  ? "No keep-awake backend on this system"
                  : "Off when unchecked"}
              </p>
            )}
          </div>
          {checkbox}
        </div>
        {message && (
          <p className="text-xs text-muted-foreground px-1">{message}</p>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Keep awake</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Prevent sleep while GUI is open</p>
            <p className="text-xs text-muted-foreground">
              {platformHint(status.platform)}
            </p>
            {status.keep_awake_active && status.keep_awake_method && (
              <p className="text-xs text-muted-foreground mt-1">
                Active via {status.keep_awake_method}
              </p>
            )}
          </div>
          {checkbox}
        </div>
        {!status.keep_awake_available && (
          <p className="text-xs text-muted-foreground">
            No keep-awake backend found on this system.
          </p>
        )}
        {message && (
          <p className="text-xs text-muted-foreground">{message}</p>
        )}
      </CardContent>
    </Card>
  );
}
