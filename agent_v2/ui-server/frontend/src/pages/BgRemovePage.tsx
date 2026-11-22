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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePoll } from "@/hooks/usePoll";
import type { BgRemoveDoctorReport, BgRemoveModel, BgRemoveStatus } from "@/types";

const DEVICE_LABELS: Record<string, string> = {
  auto: "Auto (CUDA, then DirectML, then CPU — whatever this onnxruntime build has)",
  cuda: "CUDA (needs onnxruntime-gpu)",
  directml: "DirectML (Windows GPU, needs onnxruntime-directml)",
  cpu: "CPU only",
};

function mib(bytes: number) {
  return `${(bytes / 2 ** 20).toFixed(0)} MiB`;
}

export function BgRemovePage() {
  const [fast, setFast] = useState(false);
  // Fast while a job streams its log, slow otherwise.
  const { data: status, refresh } = usePoll<BgRemoveStatus>(
    () => api.getBgRemoveStatus(),
    fast ? 1500 : 10000
  );
  const job = status?.job;
  const busy = job?.state === "running";
  useEffect(() => setFast(busy), [busy]);

  const [modelsDir, setModelsDir] = useState("");
  const [device, setDevice] = useState("auto");
  const [threads, setThreads] = useState("0");
  const [keepLoaded, setKeepLoaded] = useState(true);
  const [loadedSettings, setLoadedSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [doctor, setDoctor] = useState<BgRemoveDoctorReport | null>(null);
  const [doctoring, setDoctoring] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<BgRemoveModel | "all" | null>(null);
  const removeOne = confirmRemove !== null && confirmRemove !== "all" ? confirmRemove : null;
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!status || loadedSettings) return;
    setModelsDir(status.settings.onnx_models_dir);
    setDevice(status.settings.bgremove_device || "auto");
    setThreads(String(status.settings.bgremove_threads));
    setKeepLoaded(status.settings.bgremove_keep_loaded);
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

  const threadsNum = Number.parseInt(threads, 10);
  const threadsValid = Number.isInteger(threadsNum) && threadsNum >= 0;
  const dirty =
    !!status &&
    (modelsDir !== status.settings.onnx_models_dir ||
      device !== (status.settings.bgremove_device || "auto") ||
      threadsNum !== status.settings.bgremove_threads ||
      keepLoaded !== status.settings.bgremove_keep_loaded);

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
      api.saveBgRemoveSettings({
        onnx_models_dir: modelsDir.trim(),
        bgremove_device: device,
        bgremove_threads: threadsNum,
        bgremove_keep_loaded: keepLoaded,
      })
    );
    setDoctor(null);
    setSaving(false);
  }

  async function runDoctor() {
    setDoctoring(true);
    await act(async () => setDoctor(await api.doctorBgRemove()));
    setDoctoring(false);
  }

  const installedCount = status?.models.filter((m) => m.present).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Background removal</h1>
        <p className="text-sm text-muted-foreground">
          BiRefNet ONNX models behind <code className="text-xs">onnx.bgremove.*</code>: cut characters
          out as transparent PNG/WebP or onto a solid colour. Nothing is downloaded with the agent:
          install models here or with <code className="text-xs">omq bgremove install</code>. Each
          installed model is advertised as its own capability.
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
            <CardDescription>{status?.summary ?? "Loading…"}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {status && (
            <div className="grid gap-1 font-mono text-xs text-muted-foreground">
              <span>models: {status.models_dir}</span>
              <span>
                onnxruntime {status.onnxruntime ?? "missing"} · providers:{" "}
                {status.available_providers.join(", ") || "none"}
              </span>
              <span>
                device {status.device} → {status.providers[0] ?? "—"} · threads{" "}
                {status.threads || "default"} · {status.keep_loaded ? "kept loaded" : "loaded per task"}
              </span>
            </div>
          )}
          {status?.device_error && <p className="text-destructive">{status.device_error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={runDoctor} disabled={busy || doctoring}>
              {doctoring ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />}
              Doctor
            </Button>
            <Button
              variant="outline"
              onClick={() => act(() => api.repairBgRemove())}
              disabled={busy || dirty}
              title="Validate checksums, then re-download whatever is broken (or install the default model)"
            >
              <Wrench className="size-4" /> Repair
            </Button>
            <Button
              variant="destructive"
              onClick={() => setConfirmRemove("all")}
              disabled={busy || installedCount === 0}
            >
              <Trash2 className="size-4" /> Remove all
            </Button>
            {busy && (
              <Button variant="ghost" onClick={() => act(() => api.cancelBgRemove())}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Models</CardTitle>
          <CardDescription>
            birefnet-general is the default for anime and realistic characters (keeps held props);
            portrait is people-only; lite is the small download.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status?.models.map((m) => (
                <TableRow key={m.name}>
                  <TableCell className="align-top">
                    <div className="font-medium">
                      {m.short} {m.default && <Badge variant="outline">default</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{m.description}</div>
                    <code className="text-xs text-muted-foreground">{m.capability}</code>
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap">
                    {mib(m.size_bytes || m.expected_bytes || 0)}
                  </TableCell>
                  <TableCell className="align-top">
                    {m.installed ? (
                      <Badge variant="success">installed</Badge>
                    ) : m.present ? (
                      <Badge variant="destructive">incomplete</Badge>
                    ) : (
                      <Badge variant="secondary">not installed</Badge>
                    )}
                  </TableCell>
                  <TableCell className="space-x-2 text-right align-top whitespace-nowrap">
                    {!m.installed && (
                      <Button
                        size="sm"
                        onClick={() => act(() => api.installBgRemove([m.name]))}
                        disabled={busy || dirty}
                      >
                        <Download className="size-4" /> Install
                      </Button>
                    )}
                    {m.installed && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => act(() => api.installBgRemove([m.name], true))}
                        disabled={busy || dirty}
                        title="Delete and download again"
                      >
                        <RefreshCw className="size-4" /> Reinstall
                      </Button>
                    )}
                    {m.present && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmRemove(m)}
                        disabled={busy}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {dirty && (
            <p className="mt-2 text-xs text-muted-foreground">Save the settings changes below first.</p>
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
            The models directory is shared with onnx.nudenet; leave blank for the default. Changing it
            does not move files. Device and thread changes apply to the next task.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bgr-dir">Models directory</Label>
            <Input
              id="bgr-dir"
              value={modelsDir}
              onChange={(e) => setModelsDir(e.target.value)}
              placeholder={status?.default_models_dir}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label>Device</Label>
            <Select value={device} onValueChange={setDevice} disabled={busy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(status?.device_choices ?? Object.keys(DEVICE_LABELS)).map((d) => (
                  <SelectItem key={d} value={d}>
                    {DEVICE_LABELS[d] ?? d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bgr-threads">CPU threads per inference (0 = all cores)</Label>
            <Input
              id="bgr-threads"
              type="number"
              min={0}
              value={threads}
              onChange={(e) => setThreads(e.target.value)}
              disabled={busy}
              className="w-32"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={keepLoaded}
              onChange={(e) => setKeepLoaded(e.target.checked)}
              disabled={busy}
            />
            Keep models loaded between tasks (faster; ~4 GB RAM per BiRefNet model)
          </label>
          <Button onClick={saveSettings} disabled={!dirty || !threadsValid || saving || busy}>
            {saving && <Loader2 className="size-4 animate-spin" />} Save
          </Button>
        </CardContent>
      </Card>

      <Dialog open={confirmRemove !== null} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {removeOne ? `Remove ${removeOne.short}?` : "Remove all models?"}
            </DialogTitle>
            <DialogDescription>
              Deletes the model file{removeOne ? "" : "s"} from {status?.models_dir}. The agent stops
              advertising {removeOne ? removeOne.capability : "onnx.bgremove.*"}. onnx.nudenet is not
              touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(null)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const models = removeOne ? [removeOne.name] : [];
                setConfirmRemove(null);
                setDoctor(null);
                void act(() => api.uninstallBgRemove(models));
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
