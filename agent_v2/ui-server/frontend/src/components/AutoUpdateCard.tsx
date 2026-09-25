import { useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { usePoll } from "@/hooks/usePoll";

const PHASE_LABEL: Record<string, string> = {
  idle: "Idle",
  unsupported: "Unavailable",
  checking: "Checking for updates…",
  downloading: "Downloading…",
  "waiting-for-idle": "Update ready — waiting for running tasks to finish",
  restarting: "Restarting into the new version…",
};

/** Unattended self-update (Linux CLI under systemd). Hidden on other platforms. */
export function AutoUpdateCard() {
  const { data: status, refresh } = usePoll(api.getAutoUpdate, 3000);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  if (!status) return null;
  const unsupported = status.unsupported_reason;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Automatic updates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Running <span className="font-mono">{status.current}</span>
          {status.latest && (
            <>
              {" "}· latest <span className="font-mono">{status.latest}</span>
            </>
          )}
          {status.last_check && (
            <> · checked {new Date(status.last_check).toLocaleString()}</>
          )}
        </p>

        {unsupported ? (
          <p className="text-xs text-muted-foreground">{unsupported}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={status.enabled}
                  disabled={busy}
                  onChange={() =>
                    void act(() =>
                      api.saveSettings({ auto_update_enabled: !status.enabled })
                    )
                  }
                />
                Update automatically
              </label>
              <label className="flex items-center gap-2">
                every
                <Input
                  type="number"
                  min={1}
                  className="w-20 h-8"
                  defaultValue={status.interval_hours}
                  onBlur={(e) =>
                    void act(() =>
                      api.saveSettings({
                        auto_update_interval_hours: Math.max(1, Number(e.target.value)),
                      })
                    )
                  }
                />
                hours
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || status.phase !== "idle"}
                onClick={() => void act(api.runAutoUpdate)}
              >
                Update now
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {PHASE_LABEL[status.phase] ?? status.phase}. Updates install only
              when no task is running; systemd restarts the agent into the new
              version.
            </p>
          </>
        )}

        {(status.error || message) && (
          <p className="text-xs text-destructive">{message || status.error}</p>
        )}
      </CardContent>
    </Card>
  );
}
