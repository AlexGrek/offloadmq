import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { api } from "@/api/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveIndicator } from "@/components/SaveIndicator";
import type { SaveStatus } from "@/hooks/useDebouncedSave";
import type { Settings } from "@/types";

type ShellSettings = Pick<Settings, "shell_workspace_root" | "shell_restrict_workspace">;

/** Workspace policy for shell.* jobs (the capabilities themselves are opt-in on Capabilities). */
export function ShellJobSettings() {
  const [settings, setSettings] = useState<ShellSettings | null>(null);
  const [root, setRoot] = useState("");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    let disposed = false;
    api.getSettings().then((cfg) => {
      if (disposed) return;
      setSettings(cfg);
      setRoot(cfg.shell_workspace_root);
    }).catch((e: unknown) => {
      if (disposed) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => { disposed = true; };
  }, []);

  const save = async (patch: Partial<ShellSettings>) => {
    if (!settings || saving.current) return;
    saving.current = true;
    const before = settings;
    setSettings({ ...settings, ...patch });
    setStatus("saving");
    setError(null);
    try {
      const saved = await api.saveSettings(patch);
      setSettings(saved);
      setRoot(saved.shell_workspace_root);
      setStatus("saved");
    } catch (e) {
      setSettings(before);
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      saving.current = false;
    }
  };

  const disabled = !settings || status === "saving";
  return (
    <Card data-testid="shell-job-settings">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Shell jobs</CardTitle>
          <CardDescription>
            Workspaces for <code>shell.bash</code>, <code>shell.zsh</code>, <code>shell.posix</code>,{" "}
            <code>shell.pwsh</code>, <code>shell.cmd</code> and <code>shell.any</code> tasks.
          </CardDescription>
        </div>
        <SaveIndicator status={status} error={error} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="shell-workspace-root">Workspace root</Label>
          <Input
            id="shell-workspace-root"
            value={root}
            disabled={disabled}
            placeholder="~/.offload-agent/shell-workspaces"
            onChange={(e) => setRoot(e.target.value)}
            onBlur={() => {
              if (root !== settings?.shell_workspace_root) void save({ shell_workspace_root: root });
            }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
          <p className="text-xs text-muted-foreground">
            Relative task workspaces are created here. Leave blank for the default.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings?.shell_restrict_workspace ?? false}
            disabled={disabled}
            onChange={(e) => void save({ shell_restrict_workspace: e.target.checked })}
          />
          Only allow workspaces inside the workspace root
        </label>
        <p className="text-sm text-muted-foreground">
          Shell capabilities run arbitrary commands as this account. Each one must be approved
          under Sensitive (opt-in) on <Link className="underline" to="/capabilities">Capabilities</Link>.
        </p>
      </CardContent>
    </Card>
  );
}
