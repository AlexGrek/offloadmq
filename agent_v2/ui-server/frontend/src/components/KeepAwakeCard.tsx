import { useState } from "react";

import { api } from "@/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePoll } from "@/hooks/usePoll";

type StartupStatus = Awaited<ReturnType<typeof api.getStartupStatus>>;

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

function powerState(status: StartupStatus): string {
  if (!status.battery_pause_available) return "Not supported on this platform yet (macOS only)";
  if (status.power_paused) return "On battery — agent paused";
  if (status.on_battery === true) return "On battery";
  if (status.on_battery === false) return "On external power";
  return "";
}

function Checkbox({
  label,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm shrink-0 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      {label}
    </label>
  );
}

export function KeepAwakeCard({ compact = false }: { compact?: boolean }) {
  const { data: status, refresh } = usePoll(api.getStartupStatus, 5000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (!status) return null;
  const showKeepAwake = status.gui_mode;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const keepAwakeCheckbox = (
    <Checkbox
      label="Keep awake"
      checked={status.keep_awake_enabled}
      disabled={busy || !status.keep_awake_available}
      onToggle={() => void run(() => api.setKeepAwake(!status.keep_awake_enabled))}
    />
  );

  const batteryCheckbox = (
    <Checkbox
      label="Pause when on battery power"
      checked={status.pause_on_battery}
      disabled={busy || !status.battery_pause_available}
      onToggle={() => void run(() => api.setPauseOnBattery(!status.pause_on_battery))}
    />
  );

  const keepAwakeStatus =
    status.keep_awake_active && status.keep_awake_method
      ? `Active via ${status.keep_awake_method}`
      : "";

  if (compact) {
    return (
      <div className="space-y-1">
        {showKeepAwake && (
          <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">Prevent sleep while GUI is open</p>
              <p className="text-xs text-muted-foreground truncate">
                {keepAwakeStatus ||
                  (!status.keep_awake_available
                    ? "No keep-awake backend on this system"
                    : "Off when unchecked")}
              </p>
            </div>
            {keepAwakeCheckbox}
          </div>
        )}
        <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">Stop taking tasks on battery</p>
            <p className="text-xs text-muted-foreground truncate">
              {powerState(status) || "Power source unknown"}
            </p>
          </div>
          {batteryCheckbox}
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
        <CardTitle className="text-base">
          {showKeepAwake ? "Keep awake" : "Power"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {showKeepAwake && (
          <>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Prevent sleep while GUI is open</p>
                <p className="text-xs text-muted-foreground">
                  {platformHint(status.platform)}
                </p>
                {keepAwakeStatus && (
                  <p className="text-xs text-muted-foreground mt-1">{keepAwakeStatus}</p>
                )}
              </div>
              {keepAwakeCheckbox}
            </div>
            {!status.keep_awake_available && (
              <p className="text-xs text-muted-foreground">
                No keep-awake backend found on this system.
              </p>
            )}
          </>
        )}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Stop taking tasks on battery</p>
            <p className="text-xs text-muted-foreground">
              Running tasks finish first, then the agent goes offline until
              external power returns.
            </p>
            {powerState(status) && (
              <p className="text-xs text-muted-foreground mt-1">
                {powerState(status)}
              </p>
            )}
          </div>
          {batteryCheckbox}
        </div>
        {message && (
          <p className="text-xs text-muted-foreground">{message}</p>
        )}
      </CardContent>
    </Card>
  );
}
