import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePoll } from "@/hooks/usePoll";
import type { ComfyInstall, ComfyProcessState, Settings } from "@/types";

const STATE_BADGE: Record<
  ComfyProcessState,
  { label: string; variant: "success" | "warning" | "destructive" | "secondary" | "outline" }
> = {
  running: { label: "Running", variant: "success" },
  starting: { label: "Starting…", variant: "warning" },
  stopped: { label: "Stopped", variant: "secondary" },
  crashed: { label: "Crashed", variant: "destructive" },
  "crash-loop": { label: "Crash loop — auto-restart suspended", variant: "destructive" },
  external: { label: "Running (not managed by agent)", variant: "outline" },
};

function uptime(startedAt: string | null): string | null {
  if (!startedAt) return null;
  const secs = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${secs % 60}s` : `${secs}s`;
}

/** Quote an argv element for display only. */
const shown = (a: string) => (/[\s"]/.test(a) ? `"${a}"` : a);

/** Agent-managed local ComfyUI: launch config, lifecycle buttons, output tail. */
export function ComfyServerCard({
  url,
  onUseUrl,
}: {
  url: string;
  onUseUrl: (url: string) => void;
}) {
  const { data: st, refresh } = usePoll(() => api.getComfyProcess(), 2000);

  const [cfg, setCfg] = useState<Settings | null>(null);
  const [python, setPython] = useState("");
  const [mainPy, setMainPy] = useState("");
  const [args, setArgs] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [detected, setDetected] = useState<ComfyInstall | null>(null);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);

  const load = (s: Settings) => {
    setCfg(s);
    setPython(s.comfyui_python ?? "");
    setMainPy(s.comfyui_main_py ?? "");
    setArgs((s.comfyui_args ?? []).join("\n"));
    setDirty(false);
  };

  useEffect(() => {
    api.getSettings().then(load);
  }, []);

  const toggle = async (
    field: "comfyui_launch_on_startup" | "comfyui_restart_on_crash",
    value: boolean
  ) => {
    setErr(null);
    try {
      const s = await api.saveComfyLaunch({ [field]: value });
      setCfg(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveLaunch = async () => {
    setSaving(true);
    setErr(null);
    try {
      const s = await api.saveComfyLaunch({
        comfyui_python: python.trim(),
        comfyui_main_py: mainPy.trim(),
        comfyui_args: args.split("\n").map((a) => a.trim()).filter(Boolean),
      });
      load(s);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const detect = async () => {
    setDetectMsg(null);
    setErr(null);
    try {
      const { install } = await api.detectComfyInstall();
      if (!install) {
        setDetected(null);
        setDetectMsg("No local Comfy Desktop install found.");
        return;
      }
      setDetected(install);
      setPython(install.python);
      setMainPy(install.mainPy);
      setArgs(install.args.join("\n"));
      setDirty(true);
      setDetectMsg(`Filled from Comfy Desktop install "${install.name}" — review and Save.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const act = async (action: "start" | "stop" | "restart") => {
    setBusy(action);
    setErr(null);
    try {
      await api.comfyProcessAction(action);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const state = st?.state ?? "stopped";
  const badge = STATE_BADGE[state];
  const managed = st?.managed ?? false;
  const canStart = !managed && state !== "external" && !st?.configProblem;
  const up = managed ? uptime(st?.startedAt ?? null) : null;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Local ComfyUI server</CardTitle>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={!canStart || busy !== null} onClick={() => act("start")}>
            {busy === "start" ? "Starting…" : "Start"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!managed || busy !== null}
            onClick={() => act("restart")}
          >
            {busy === "restart" ? "Restarting…" : "Restart"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!managed || busy !== null}
            onClick={() => act("stop")}
            className="text-destructive hover:text-destructive"
          >
            {busy === "stop" ? "Stopping…" : "Stop"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {st && (
          <p className="text-xs text-muted-foreground">
            {managed && <>PID {st.pid}{st.adopted ? " (adopted)" : ""} · </>}
            {up && <>up {up} · </>}
            crash restarts {st.restartsInWindow}/{st.maxRestarts} in last {st.windowMinutes} min
            {st.lastExitCode !== null && <> · last exit code {st.lastExitCode}</>}
          </p>
        )}
        {state === "external" && (
          <p className="text-xs text-muted-foreground">
            Something else (e.g. Comfy Desktop) is already serving {st?.url}. The agent
            uses it but won't stop or restart it. Close it to let the agent manage ComfyUI.
          </p>
        )}
        {st?.lastError && <p className="text-sm text-destructive">{st.lastError}</p>}
        {err && <p className="text-sm text-destructive">{err}</p>}

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={cfg?.comfyui_launch_on_startup ?? false}
              disabled={!cfg}
              onChange={(e) => toggle("comfyui_launch_on_startup", e.target.checked)}
            />
            Launch ComfyUI server on startup
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={cfg?.comfyui_restart_on_crash ?? false}
              disabled={!cfg}
              onChange={(e) => toggle("comfyui_restart_on_crash", e.target.checked)}
            />
            Restart ComfyUI on crash
            <span className="text-muted-foreground">
              (at most {st?.maxRestarts ?? 5} times in {st?.windowMinutes ?? 20} min)
            </span>
          </label>
        </div>

        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Launch command</span>
            <Button size="sm" variant="ghost" onClick={detect}>
              Detect from Comfy Desktop
            </Button>
          </div>
          {detectMsg && <p className="text-xs text-muted-foreground">{detectMsg}</p>}
          {detected && detected.url !== url && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-amber-500">
              Comfy Desktop serves this install at <code>{detected.url}</code>, but the
              ComfyUI URL is <code>{url || "(empty)"}</code>.
              <Button size="sm" variant="outline" onClick={() => onUseUrl(detected.url)}>
                Use {detected.url}
              </Button>
            </div>
          )}
          <div className="space-y-1">
            <Label>Python executable</Label>
            <Input
              value={python}
              placeholder="C:\ComfyUI\.venv\Scripts\python.exe"
              onChange={(e) => { setPython(e.target.value); setDirty(true); }}
            />
          </div>
          <div className="space-y-1">
            <Label>ComfyUI main.py</Label>
            <Input
              value={mainPy}
              placeholder="C:\ComfyUI\main.py"
              onChange={(e) => { setMainPy(e.target.value); setDirty(true); }}
            />
          </div>
          <div className="space-y-1">
            <Label>
              Extra arguments{" "}
              <span className="text-muted-foreground font-normal">
                (one per line; --port / --listen come from the ComfyUI URL unless set here)
              </span>
            </Label>
            <textarea
              className="border-input bg-transparent dark:bg-input/30 min-h-24 w-full rounded-md border px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={args}
              placeholder={"--base-directory\nC:\\AI\n--enable-manager"}
              onChange={(e) => { setArgs(e.target.value); setDirty(true); }}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            {st?.configProblem ? (
              <p className="text-xs text-destructive">{st.configProblem}</p>
            ) : (
              <span />
            )}
            <Button size="sm" disabled={!dirty || saving} onClick={saveLaunch}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
          {st && !dirty && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
              {st.command.map(shown).join(" ")}
            </pre>
          )}
        </div>

        {st && st.output.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Output (last {st.output.length} lines of <code>{st.logPath}</code>)
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-2 font-mono text-xs">
              {st.output.join("\n")}
            </pre>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
