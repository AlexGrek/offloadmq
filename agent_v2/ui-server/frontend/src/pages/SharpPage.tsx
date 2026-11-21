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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePoll } from "@/hooks/usePoll";
import type { SharpDoctorReport, SharpStatus } from "@/types";

const TORCH_INDEXES = [
  { value: "auto", label: "Auto (CUDA 12.8 if an NVIDIA driver is present)" },
  { value: "cuda", label: "CUDA 12.8" },
  { value: "cpu", label: "CPU only (very slow)" },
  { value: "pypi", label: "PyPI default (macOS / MPS)" },
];

function gib(bytes: number) {
  return `${(bytes / 2 ** 30).toFixed(2)} GiB`;
}

export function SharpPage() {
  const [fast, setFast] = useState(false);
  // Fast while a job streams its log, slow otherwise.
  const { data: status, refresh } = usePoll<SharpStatus>(() => api.getSharpStatus(), fast ? 1500 : 10000);
  const job = status?.job;
  const busy = job?.state === "running";
  useEffect(() => setFast(busy), [busy]);

  const [venvDir, setVenvDir] = useState("");
  const [modelsDir, setModelsDir] = useState("");
  const [torchIndex, setTorchIndex] = useState("auto");
  const [loadedSettings, setLoadedSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [doctor, setDoctor] = useState<SharpDoctorReport | null>(null);
  const [doctoring, setDoctoring] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [removeModel, setRemoveModel] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!status || loadedSettings) return;
    setVenvDir(status.settings.sharp_venv_dir);
    setModelsDir(status.settings.sharp_models_dir);
    setTorchIndex(status.settings.sharp_torch_index || "auto");
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

  const dirty =
    !!status &&
    (venvDir !== status.settings.sharp_venv_dir ||
      modelsDir !== status.settings.sharp_models_dir ||
      torchIndex !== (status.settings.sharp_torch_index || "auto"));

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

  async function saveSettings() {
    setSaving(true);
    await act(() =>
      api.saveSharpSettings({
        sharp_venv_dir: venvDir.trim(),
        sharp_models_dir: modelsDir.trim(),
        sharp_torch_index: torchIndex,
      })
    );
    setDoctor(null);
    setSaving(false);
  }

  async function runDoctor() {
    setDoctoring(true);
    await act(async () => setDoctor(await api.doctorSharp()));
    setDoctoring(false);
  }

  const prereqMissing = status && (!status.uv_available || !status.source_available);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">3D Worlds (SHARP)</h1>
        <p className="text-sm text-muted-foreground">
          Apple SHARP turns one picture into a Gaussian-splat scene for the{" "}
          <code className="text-xs">world.sharp</code> capability (OAI VR Worlds). It is not installed
          with the agent: install it here or with <code className="text-xs">omq sharp install</code>.
          Needs <code className="text-xs">uv</code>, ~6 GB for the venv and 2.6 GiB for the model.
          Research-only model licence.
        </p>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              Status
              {status &&
                (status.ready ? (
                  <Badge variant="success">installed</Badge>
                ) : (
                  <Badge variant="secondary">not installed</Badge>
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
              <span>
                venv: {status.venv_dir} {status.has_venv ? "✓" : "— missing"}
              </span>
              <span>
                model: {status.models_dir}{" "}
                {status.has_model ? `✓ ${gib(status.model_bytes)}` : "— missing"}
              </span>
              {status.manifest.torch && (
                <span>
                  torch {status.manifest.torch} ·{" "}
                  {status.manifest.cuda ? `CUDA on ${status.manifest.device}` : "CPU"} · rev{" "}
                  {(status.manifest.revision ?? "").slice(0, 8) || "?"}
                </span>
              )}
            </div>
          )}
          {prereqMissing && (
            <p className="text-destructive">
              {!status?.uv_available && "uv is not on PATH (https://docs.astral.sh/uv/). "}
              {!status?.source_available && "This agent build does not include the ml-sharp source."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!status?.ready && (
              <Button
                onClick={() => act(() => api.installSharp(false))}
                disabled={busy || !!prereqMissing || dirty}
              >
                <Download className="size-4" /> Install
              </Button>
            )}
            <Button variant="outline" onClick={runDoctor} disabled={busy || doctoring}>
              {doctoring ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />}
              Doctor
            </Button>
            <Button
              variant="outline"
              onClick={() => act(() => api.repairSharp())}
              disabled={busy || !!prereqMissing || dirty}
              title="Validate, then reinstall whatever is broken or outdated"
            >
              <Wrench className="size-4" /> Repair
            </Button>
            <Button
              variant="outline"
              onClick={() => act(() => api.installSharp(true))}
              disabled={busy || !!prereqMissing || dirty}
              title="Rebuild the venv from scratch (a valid model is kept)"
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
              <Button variant="ghost" onClick={() => act(() => api.cancelSharp())}>
                Cancel
              </Button>
            )}
          </div>
          {dirty && (
            <p className="text-xs text-muted-foreground">Save the location changes below first.</p>
          )}
        </CardContent>
      </Card>

      {doctor && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Doctor: {doctor.ok ? "healthy" : `needs ${doctor.action}`}
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
          <CardTitle className="text-base">Locations</CardTitle>
          <CardDescription>
            Leave blank for the defaults. Changing a location does not move files: install (or point
            at an existing install) afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sharp-venv">Venv directory</Label>
            <Input
              id="sharp-venv"
              value={venvDir}
              onChange={(e) => setVenvDir(e.target.value)}
              placeholder={status?.default_venv_dir}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sharp-models">Model directory</Label>
            <Input
              id="sharp-models"
              value={modelsDir}
              onChange={(e) => setModelsDir(e.target.value)}
              placeholder={status?.default_models_dir}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label>torch build</Label>
            <Select value={torchIndex} onValueChange={setTorchIndex} disabled={busy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TORCH_INDEXES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={saveSettings} disabled={!dirty || saving || busy}>
            {saving && <Loader2 className="size-4 animate-spin" />} Save
          </Button>
        </CardContent>
      </Card>

      <Dialog open={confirmUninstall} onOpenChange={setConfirmUninstall}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall SHARP?</DialogTitle>
            <DialogDescription>
              Deletes {status?.venv_dir}
              {removeModel ? ` and the model in ${status?.models_dir}` : ""}. The agent stops
              advertising world.sharp.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeModel}
              onChange={(e) => setRemoveModel(e.target.checked)}
            />
            Also delete the 2.6 GiB model
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
                void act(() => api.uninstallSharp(removeModel));
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
