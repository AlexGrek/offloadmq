import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Stethoscope,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";

import { api } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePoll } from "@/hooks/usePoll";
import type { MirrorDoctorReport, MirrorStatus } from "@/types";

function gib(bytes: number) {
  return `${(bytes / 2 ** 30).toFixed(2)} GiB`;
}

export function MirrorPage() {
  const [fast, setFast] = useState(false);
  // Fast while a job streams its log, slow otherwise.
  const { data: status, refresh } = usePoll<MirrorStatus>(() => api.getMirrorStatus(), fast ? 1500 : 10000);
  const job = status?.job;
  const busy = job?.state === "running";
  useEffect(() => setFast(busy), [busy]);

  const [dir, setDir] = useState("");
  const [loadedSettings, setLoadedSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [doctor, setDoctor] = useState<MirrorDoctorReport | null>(null);
  const [doctoring, setDoctoring] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [removeModels, setRemoveModels] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!status || loadedSettings) return;
    setDir(status.settings.mirror_dir);
    setLoadedSettings(true);
  }, [status, loadedSettings]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [job?.log.length]);

  // A finished job changes what is installed: re-run the doctor if it was shown.
  const lastState = useRef(job?.state);
  useEffect(() => {
    if (lastState.current === "running" && job?.state !== "running" && doctor) void runDoctor();
    lastState.current = job?.state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.state]);

  const dirty = !!status && dir !== status.settings.mirror_dir;
  const accepted = !!status?.license_accepted;

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  }

  async function save(patch: Partial<MirrorStatus["settings"]>) {
    setSaving(true);
    await act(() => api.saveMirrorSettings(patch));
    setDoctor(null);
    setSaving(false);
  }

  async function runDoctor() {
    setDoctoring(true);
    await act(async () => setDoctor(await api.doctorMirror()));
    setDoctoring(false);
  }

  const prereqMissing = status && (!status.uv_available || (!status.has_code && !status.git_available));
  const blocked = busy || !!prereqMissing || dirty || !accepted;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">WorldMirror (experimental)</h1>
        <p className="text-sm text-muted-foreground">
          Tencent HY-World 2.0&apos;s WorldMirror turns one picture into a Gaussian-splat scene for the{" "}
          <code className="text-xs">world.mirror</code> capability (OAI VR Worlds). In our tests it did not
          beat SHARP: leaning opens black gaps behind foreground objects. Needs a CUDA GPU (~9 GB VRAM),{" "}
          <code className="text-xs">uv</code>, <code className="text-xs">git</code>, ~6 GB for the venv and{" "}
          {status ? gib(status.download_bytes) : "4.9 GiB"} of models. Install SHARP too for real-world scale.
        </p>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Licence
            {status &&
              (accepted ? (
                <Badge variant="success">accepted</Badge>
              ) : (
                <Badge variant="secondary">not accepted</Badge>
              ))}
          </CardTitle>
          <CardDescription>{status?.license.notice ?? "Loading…"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <a className="underline" href={status?.license.url} target="_blank" rel="noreferrer">
            Read the licence
          </a>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={accepted}
              disabled={!status || busy || saving}
              onChange={(e) => void save({ mirror_license_accepted: e.target.checked })}
            />
            <span>
              I accept the licence, and this machine and the people viewing its worlds are outside the EU,
              the United Kingdom and South Korea.
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              Status
              {status &&
                (status.ready ? (
                  <Badge variant="success">ready</Badge>
                ) : (
                  <Badge variant="secondary">{status.installed ? "off" : "not installed"}</Badge>
                ))}
              {busy && <Badge variant="outline">{job?.action} running…</Badge>}
            </CardTitle>
            <CardDescription>{status?.summary ?? "Loading…"}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {status && (
            <div className="grid gap-1 font-mono text-xs text-muted-foreground">
              <span>directory: {status.dir}</span>
              <span>venv: {status.has_venv ? "✓" : "— missing"}</span>
              <span>code: {status.has_code ? "✓" : "— missing"}</span>
              <span>
                models: {status.has_model ? `✓ ${gib(status.model_bytes)}` : "— missing"}
              </span>
              {status.manifest.torch && (
                <span>
                  torch {status.manifest.torch} · {status.manifest.device} · rev{" "}
                  {(status.manifest.revision ?? "").slice(0, 8) || "?"}
                </span>
              )}
            </div>
          )}
          {prereqMissing && (
            <p className="text-destructive">
              {!status?.uv_available && "uv is not on PATH (https://docs.astral.sh/uv/). "}
              {!status?.has_code && !status?.git_available && "git is not on PATH (needed to fetch the code)."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!status?.installed && (
              <Button onClick={() => act(() => api.installMirror(false))} disabled={blocked}>
                <Download className="size-4" /> Install
              </Button>
            )}
            <Button variant="outline" onClick={runDoctor} disabled={busy || doctoring}>
              {doctoring ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />}
              Doctor
            </Button>
            <Button
              variant="outline"
              onClick={() => act(() => api.repairMirror())}
              disabled={blocked}
              title="Verify checksums, then fetch or reinstall whatever is broken"
            >
              <Wrench className="size-4" /> Repair
            </Button>
            <Button
              variant="outline"
              onClick={() => act(() => api.installMirror(true))}
              disabled={blocked}
              title="Rebuild the venv from scratch (verified models are kept)"
            >
              <RefreshCw className="size-4" /> Reinstall
            </Button>
            <Button
              variant="destructive"
              onClick={() => setConfirmUninstall(true)}
              disabled={busy || (!status?.has_venv && !status?.has_model)}
            >
              <Trash2 className="size-4" /> Uninstall
            </Button>
            {busy && (
              <Button variant="ghost" onClick={() => act(() => api.cancelMirror())}>
                Cancel
              </Button>
            )}
          </div>
          {!accepted && status && (
            <p className="text-xs text-muted-foreground">Accept the licence above to install.</p>
          )}
          {dirty && <p className="text-xs text-muted-foreground">Save the directory change below first.</p>}
        </CardContent>
      </Card>

      {doctor && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Doctor: {doctor.ok ? "healthy" : doctor.action ? `needs ${doctor.action}` : "problems found"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {doctor.checks.map((c) => (
              <div key={c.name} className="flex items-start gap-2">
                {c.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <span className="font-medium">{c.name}</span>
                <span className="break-all text-muted-foreground">{c.detail}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {job && job.state !== "idle" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {job.action} — {job.state}
              {job.error ? `: ${job.error.split("\n")[0]}` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre
              ref={logRef}
              className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
            >
              {job.log.join("\n") || "…"}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">GPU memory</CardTitle>
          <CardDescription>
            A model loaded in Ollama pushes WorldMirror out of video memory (98 s instead of under a second
            in our tests). ComfyUI is always asked to unload.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={status?.settings.mirror_free_ollama ?? true}
              disabled={!status || busy || saving}
              onChange={(e) => void save({ mirror_free_ollama: e.target.checked })}
            />
            <span>
              Unload Ollama&apos;s models before each run
              <span className="block text-xs text-muted-foreground">
                Turn off if this agent also serves chat: the next chat would wait for its model to reload.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Location</CardTitle>
          <CardDescription>
            Holds the venv, code and models. Leave blank for the default. Changing it does not move files:
            install (or point at an existing install) afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mirror-dir">Directory</Label>
            <Input
              id="mirror-dir"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder={status?.default_dir}
              disabled={busy}
            />
          </div>
          <Button onClick={() => void save({ mirror_dir: dir.trim() })} disabled={!dirty || saving || busy}>
            {saving && <Loader2 className="size-4 animate-spin" />} Save
          </Button>
        </CardContent>
      </Card>

      <Dialog open={confirmUninstall} onOpenChange={setConfirmUninstall}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall WorldMirror?</DialogTitle>
            <DialogDescription>
              Deletes the venv and code{removeModels ? " and the models" : ""} in {status?.dir}. The agent
              stops advertising world.mirror.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={removeModels} onChange={(e) => setRemoveModels(e.target.checked)} />
            Also delete the {status ? gib(status.download_bytes) : ""} of models
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUninstall(false)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmUninstall(false);
                setDoctor(null);
                void act(() => api.uninstallMirror(removeModels));
              }}
            >
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
