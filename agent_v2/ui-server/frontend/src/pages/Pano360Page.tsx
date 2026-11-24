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
import type { Pano360DoctorReport, Pano360Status } from "@/types";

type ModelKey = "pano360_unet" | "pano360_clip_l" | "pano360_t5" | "pano360_vae";
const AUTO = "__auto__";

const MODEL_FIELDS: { key: ModelKey; role: keyof Pano360Status["choices"]; label: string; hint: string }[] = [
  { key: "pano360_unet", role: "unet", label: "FLUX.1-dev UNET", hint: "any FLUX dev / Krea dev (not Fill/Kontext/Schnell)" },
  { key: "pano360_clip_l", role: "clip_l", label: "CLIP-L text encoder", hint: "clip_l.safetensors" },
  { key: "pano360_t5", role: "t5", label: "T5-XXL text encoder", hint: "fp8 preferred on 16 GB cards" },
  { key: "pano360_vae", role: "vae", label: "FLUX VAE", hint: "ae.safetensors" },
];

const EMPTY: Pano360Status["settings"] = {
  pano360_unet: "",
  pano360_clip_l: "",
  pano360_t5: "",
  pano360_vae: "",
  pano360_lora_dir: "",
};

export function Pano360Page() {
  const [fast, setFast] = useState(false);
  const { data: status, refresh } = usePoll<Pano360Status>(() => api.getPano360Status(), fast ? 1500 : 10000);
  const job = status?.job;
  const busy = job?.state === "running";
  useEffect(() => setFast(busy), [busy]);

  const [form, setForm] = useState<Pano360Status["settings"]>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [doctor, setDoctor] = useState<Pano360DoctorReport | null>(null);
  const [doctoring, setDoctoring] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!status || loaded) return;
    setForm(status.settings);
    setLoaded(true);
  }, [status, loaded]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [job?.log.length]);

  const lastState = useRef(job?.state);
  useEffect(() => {
    if (lastState.current === "running" && job?.state !== "running" && doctor) void runDoctor();
    lastState.current = job?.state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.state]);

  const dirty =
    !!status && (Object.keys(EMPTY) as (keyof typeof EMPTY)[]).some((k) => form[k] !== status.settings[k]);
  const hasLora = !!status?.models.lora;

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
    await act(() => api.savePano360Settings({ ...form, pano360_lora_dir: form.pano360_lora_dir.trim() }));
    setDoctor(null);
    setSaving(false);
  }

  async function runDoctor() {
    setDoctoring(true);
    await act(async () => setDoctor(await api.doctorPano360()));
    setDoctoring(false);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">360° Worlds</h1>
        <p className="text-sm text-muted-foreground">
          <code className="text-xs">world.pano360</code> turns one perspective picture into a full 360° splat
          world (WorldGen recipe): FLUX.1-dev with WorldGen&apos;s panorama LoRA outpaints the rest of the sphere
          in ComfyUI, then Lotus depth turns the panorama into Gaussian splats. The FLUX models are shared with
          image generation; the only download is the 35 MB LoRA. It also needs the img-utils depth workflow
          (same as <code className="text-xs">world.splat</code>).
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
                  <Badge variant="success">ready</Badge>
                ) : (
                  <Badge variant="secondary">not ready</Badge>
                ))}
              {busy && <Badge variant="outline">{job?.action} running…</Badge>}
            </CardTitle>
            <CardDescription className="break-all">{status?.summary ?? "Loading…"}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {status && (
            <div className="grid gap-1 font-mono text-xs text-muted-foreground">
              <span>
                ComfyUI {status.comfyui_url} · {status.reachable ? "reachable" : "not reachable"}
              </span>
              {MODEL_FIELDS.map((f) => (
                <span key={f.key}>
                  {f.label}: {status.models[f.role] ?? "—"}
                  {status.settings[f.key] ? "" : " (auto)"}
                </span>
              ))}
              <span>
                LoRA: {status.models.lora ?? "not installed"} → {status.lora.target_dir ?? "ComfyUI loras folder unknown"}
              </span>
            </div>
          )}
          {status?.problems.length ? (
            <ul className="list-disc pl-5 text-destructive">
              {status.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!hasLora ? (
              <Button onClick={() => act(() => api.installPano360())} disabled={busy || dirty || !status?.reachable}>
                <Download className="size-4" /> Install LoRA
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => act(() => api.installPano360(true))}
                disabled={busy || dirty}
                title="Download the LoRA again"
              >
                <RefreshCw className="size-4" /> Reinstall LoRA
              </Button>
            )}
            <Button variant="outline" onClick={runDoctor} disabled={busy || doctoring}>
              {doctoring ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />}
              Doctor
            </Button>
            <Button
              variant="outline"
              onClick={() => act(() => api.repairPano360())}
              disabled={busy || dirty}
              title="Run the doctor, then re-download the LoRA if it is missing or corrupt"
            >
              <Wrench className="size-4" /> Repair
            </Button>
            <Button variant="destructive" onClick={() => setConfirmRemove(true)} disabled={busy || !hasLora}>
              <Trash2 className="size-4" /> Remove LoRA
            </Button>
            {busy && (
              <Button variant="ghost" onClick={() => act(() => api.cancelPano360())}>
                Cancel
              </Button>
            )}
          </div>
          {status && (
            <p className="text-xs text-muted-foreground">
              {status.lora.name} · {(status.lora.bytes / 2 ** 20).toFixed(0)} MiB · {status.lora.license}
            </p>
          )}
        </CardContent>
      </Card>

      {doctor && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Doctor: {doctor.ok ? "healthy" : doctor.action ? `needs ${doctor.action}` : "needs attention"}
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
          <CardTitle className="text-base">Settings</CardTitle>
          <CardDescription>
            Models are picked from what ComfyUI lists; Auto chooses a FLUX dev / Krea dev UNET, CLIP-L, an fp8
            T5-XXL and ae.safetensors. Pin one if ComfyUI has several.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {MODEL_FIELDS.map((f) => {
            const choices = status?.choices[f.role] ?? [];
            const value = form[f.key];
            const options = value && !choices.includes(value) ? [value, ...choices] : choices;
            return (
              <div key={f.key} className="space-y-2">
                <Label>
                  {f.label} <span className="text-xs font-normal text-muted-foreground">— {f.hint}</span>
                </Label>
                <Select
                  value={value || AUTO}
                  onValueChange={(v) => setForm((s) => ({ ...s, [f.key]: v === AUTO ? "" : v }))}
                  disabled={busy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>Auto</SelectItem>
                    {options.map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
          <div className="space-y-2">
            <Label htmlFor="p360-lora-dir">LoRA install folder</Label>
            <Input
              id="p360-lora-dir"
              value={form.pano360_lora_dir}
              onChange={(e) => setForm((s) => ({ ...s, pano360_lora_dir: e.target.value }))}
              placeholder={status?.lora.target_dir ?? "ComfyUI's own loras folder"}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              Blank = the first loras folder ComfyUI reports. Must be a folder ComfyUI scans.
            </p>
          </div>
          <Button onClick={saveSettings} disabled={!dirty || saving || busy}>
            {saving && <Loader2 className="size-4 animate-spin" />} Save
          </Button>
        </CardContent>
      </Card>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove the WorldGen LoRA?</DialogTitle>
            <DialogDescription>
              Deletes {status?.lora.name} from {status?.lora.target_dir}. The agent stops advertising
              world.pano360. The FLUX models are shared with image generation and are not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRemove(false);
                setDoctor(null);
                void act(() => api.uninstallPano360());
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
