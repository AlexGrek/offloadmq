import { useEffect, useRef, useState, useCallback } from "react";

import { api } from "@/api/client";
import { ComfyGraphJsonEditor } from "@/components/ComfyGraphJsonEditor";
import { ComfyParamMapEditor } from "@/components/ComfyParamMapEditor";
import { ComfyServerCard } from "@/components/ComfyServerCard";
import { JsonCodeEditor } from "@/components/JsonCodeEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SaveIndicator } from "@/components/SaveIndicator";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";
import { validateJsonObject } from "@/lib/jsonValidate";
import type { ParamNotes } from "@/types";

type Workflow = { name: string; namespace: string; task_types: string[] };

const DEFAULT_TASK_TYPES = [
  "txt2img", "img2img", "inpaint", "outpaint", "upscale",
  "face_swap", "txt2video", "img2video", "txt2music",
];

/** Suggested namespace for a task type. img-utils operations (image-in transforms
 *  with no prompt) and txt2music live in their own namespace subdirectory, so
 *  picking one of these should default the namespace instead of dumping it into
 *  the flat imggen.* space — where it would autowire prompt/resolution fields the
 *  workflow doesn't have. */
const NAMESPACE_FOR_TASK: Record<string, string> = {
  depth: "img-utils",
  face_swap: "img-utils",
  upscale: "img-utils",
  txt2music: "txt2music",
};

/** Fields auto-detect could not wire, and why. Shown after a workflow is added. */
type UnwiredReport = { workflow: string; notes: ParamNotes };

function AddWorkflowDialog({
  open,
  standardTaskTypes,
  onClose,
  onAdded,
}: {
  open: boolean;
  standardTaskTypes: string[];
  onClose: () => void;
  onAdded: (unwired: UnwiredReport | null) => void;
}) {
  const [name, setName] = useState("");
  const [taskType, setTaskType] = useState(standardTaskTypes[0] ?? "txt2img");
  const [namespace, setNamespace] = useState("");
  const [graphJson, setGraphJson] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setName("");
    setTaskType(standardTaskTypes[0] ?? "txt2img");
    setNamespace("");
    setGraphJson("");
    setError("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const loadFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === "string") setGraphJson(text);
    };
    reader.readAsText(file);
    // Pre-fill name from filename if empty
    setName((prev) => prev || file.name.replace(/\.[^.]+$/, ""));
  }, []);

  const submit = async () => {
    setError("");
    if (!name.trim()) { setError("Workflow name is required"); return; }
    if (!graphJson.trim()) { setError("Graph JSON is required"); return; }
    const jsonErr = validateJsonObject(graphJson);
    if (jsonErr) { setError(jsonErr); return; }
    setSaving(true);
    const label = `${namespace.trim() || "imggen"}.${name.trim()} / ${taskType}`;
    try {
      await api.addComfyWorkflow({
        workflow_name: name.trim(),
        task_type: taskType,
        namespace: namespace.trim(),
        graph_json: graphJson.trim(),
      });
      let unwired: UnwiredReport | null = null;
      try {
        const r = await api.autodetectComfyParamMap({
          workflow_name: name.trim(),
          task_type: taskType,
          namespace: namespace.trim(),
          param_map_json: "{}",
        });
        if (r.notes && Object.keys(r.notes).length > 0) {
          unwired = { workflow: label, notes: r.notes };
        }
      } catch {
        // non-fatal
      }
      reset();
      onAdded(unwired);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add ComfyUI workflow</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Workflow name</Label>
              <Input
                placeholder="e.g. my-sdxl"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Task type</Label>
              <Select
                value={taskType}
                onValueChange={(t) => {
                  setTaskType(t);
                  // Auto-fill the namespace so img-utils / txt2music workflows land
                  // in the right subdirectory (and autowire the right fields).
                  setNamespace(NAMESPACE_FOR_TASK[t] ?? "");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {standardTaskTypes.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label>
              Namespace{" "}
              <span className="text-muted-foreground font-normal">
                (auto-filled from task type — img-utils for depth/face_swap/upscale, blank for imggen.*)
              </span>
            </Label>
            <Input
              placeholder="leave blank for imggen.*"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>ComfyUI API-format graph JSON</Label>
            {/* File picker — populates the textarea */}
            <div className="flex items-center gap-2 mb-1">
              <input
                type="file"
                ref={fileRef}
                accept=".json"
                className="text-xs file:rounded file:border-0 file:bg-secondary file:text-secondary-foreground file:text-xs file:font-medium file:px-2 file:py-1 file:mr-2 file:cursor-pointer cursor-pointer"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) loadFile(f);
                }}
              />
              {graphJson && (
                <span className="text-xs text-muted-foreground">
                  {graphJson.length.toLocaleString()} chars
                </span>
              )}
            </div>
            <JsonCodeEditor
              value={graphJson}
              onChange={setGraphJson}
              minHeight="160px"
              maxHeight="320px"
              placeholder='{"1": {"class_type": "...", "inputs": {...}}, ...}'
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Adding…" : "Add workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type MoveMode = "rename" | "duplicate";

function RenameDuplicateDialog({
  mode,
  workflow,
  onClose,
  onDone,
}: {
  mode: MoveMode | null;
  workflow: Workflow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workflow || !mode) return;
    setName(mode === "duplicate" ? `${workflow.name}-copy` : workflow.name);
    setNamespace(workflow.namespace);
    setError("");
  }, [workflow, mode]);

  const open = mode !== null && workflow !== null;

  const handleClose = () => {
    setError("");
    onClose();
  };

  const submit = async () => {
    if (!workflow || !mode) return;
    setError("");
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    try {
      const payload = {
        workflow_name: workflow.name,
        namespace: workflow.namespace,
        new_workflow_name: name.trim(),
        new_namespace: namespace.trim(),
      };
      if (mode === "rename") {
        await api.renameComfyWorkflow(payload);
      } else {
        await api.duplicateComfyWorkflow(payload);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "rename" ? "Rename workflow" : "Duplicate workflow"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {workflow && (
            <p className="text-xs text-muted-foreground">
              {mode === "rename" ? "Renaming" : "Duplicating"}{" "}
              <code className="text-foreground">
                {workflow.namespace ? `${workflow.namespace}.` : "imggen."}
                {workflow.name}
              </code>
              . All of its task-type graphs and param maps move together.
            </p>
          )}
          <div className="space-y-1">
            <Label>New name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>
              Namespace{" "}
              <span className="text-muted-foreground font-normal">(blank for imggen.*)</span>
            </Label>
            <Input value={namespace} onChange={(e) => setNamespace(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving
              ? "Saving…"
              : mode === "rename"
                ? "Rename"
                : "Duplicate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportWorkflowDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (label: string) => void;
}) {
  const [bundle, setBundle] = useState<Record<string, unknown> | null>(null);
  const [fileName, setFileName] = useState("");
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setBundle(null);
    setFileName("");
    setName("");
    setNamespace(null);
    setOverwrite(false);
    setError("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const loadFile = (file: File) => {
    setError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(String(e.target?.result));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not a JSON object");
        }
        setBundle(parsed as Record<string, unknown>);
        setFileName(file.name);
        setName(String(parsed.name ?? ""));
        setNamespace(null);
      } catch (err) {
        setBundle(null);
        setError(`Not a valid bundle file: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
  };

  const taskTypes = bundle?.task_types && typeof bundle.task_types === "object"
    ? Object.keys(bundle.task_types as object)
    : [];
  const effectiveNamespace = namespace ?? String(bundle?.namespace ?? "");

  const submit = async () => {
    if (!bundle) { setError("Choose a bundle file first"); return; }
    setError("");
    setSaving(true);
    try {
      const r = await api.importComfyWorkflow({ bundle, name: name.trim(), namespace, overwrite });
      reset();
      onImported(`${r.namespace || "imggen"}.${r.name} (${r.task_types.join(", ")})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import workflow bundle</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>Bundle file (.omqwf.json)</Label>
            <input
              type="file"
              ref={fileRef}
              accept=".json"
              className="block text-xs file:rounded file:border-0 file:bg-secondary file:text-secondary-foreground file:text-xs file:font-medium file:px-2 file:py-1 file:mr-2 file:cursor-pointer cursor-pointer"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadFile(f);
              }}
            />
          </div>
          {bundle && (
            <>
              <p className="text-xs text-muted-foreground">
                {fileName}: {taskTypes.length} task type{taskTypes.length === 1 ? "" : "s"}
                {taskTypes.length > 0 && ` (${taskTypes.join(", ")})`}, param maps included
                where configured.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>Workflow name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Namespace</Label>
                  <Input
                    placeholder="blank for imggen.*"
                    value={effectiveNamespace}
                    onChange={(e) => setNamespace(e.target.value)}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                />
                Overwrite task types that already exist
              </label>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !bundle}>
            {saving ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ComfyPage() {
  const [url, setUrl] = useState("");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [standardTaskTypes, setStandardTaskTypes] = useState<string[]>(DEFAULT_TASK_TYPES);
  const [showAdd, setShowAdd] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [unwired, setUnwired] = useState<UnwiredReport | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [notice, setNotice] = useState("");
  const [exportError, setExportError] = useState("");

  // Param map drawer state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorWorkflowKey, setEditorWorkflowKey] = useState<string>("");

  // Graph JSON drawer state
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const [jsonEditorWorkflowKey, setJsonEditorWorkflowKey] = useState<string>("");

  // Rename / duplicate dialog state
  const [moveMode, setMoveMode] = useState<MoveMode | null>(null);
  const [moveTarget, setMoveTarget] = useState<Workflow | null>(null);

  const refreshWorkflows = () =>
    api.getComfyWorkflows().then((r) => {
      setWorkflows(r.workflows);
      setStandardTaskTypes(r.standardTaskTypes);
    });

  const { schedule, flush, status, error } = useDebouncedSave<string>(async (next) => {
    await api.saveComfyUrl(next);
    await refreshWorkflows();
  });

  useEffect(() => {
    api.getSettings().then((s) => setUrl(s.comfyui_url ?? ""));
    refreshWorkflows();
  }, []);

  const edit = (next: string) => {
    setUrl(next);
    schedule(next);
  };

  const deleteWorkflow = async (w: Workflow) => {
    const key = `${w.namespace}/${w.name}`;
    setDeletingKey(key);
    setDeleteErr(null);
    try {
      await api.deleteComfyWorkflow(w.name, w.namespace);
      await refreshWorkflows();
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingKey(null);
    }
  };

  const exportWorkflow = async (w: Workflow) => {
    setExportError("");
    setNotice("");
    try {
      const bundle = await api.exportComfyWorkflow({
        workflow_name: w.name,
        namespace: w.namespace,
      });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `${w.name}.omqwf.json`;
      a.click();
      URL.revokeObjectURL(href);
    } catch (e) {
      setExportError(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const openEditor = (w: Workflow) => {
    setEditorWorkflowKey(`${w.namespace}::${w.name}`);
    setEditorOpen(true);
  };

  const openJsonEditor = (w: Workflow) => {
    setJsonEditorWorkflowKey(`${w.namespace}::${w.name}`);
    setJsonEditorOpen(true);
  };

  const openMoveDialog = (mode: MoveMode, w: Workflow) => {
    setMoveMode(mode);
    setMoveTarget(w);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">ComfyUI workflows</h1>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">ComfyUI URL</CardTitle>
          <SaveIndicator status={status} error={error} />
        </CardHeader>
        <CardContent>
          <Input
            value={url}
            onChange={(e) => edit(e.target.value)}
            onBlur={flush}
            onKeyDown={(e) => e.key === "Enter" && flush()}
          />
        </CardContent>
      </Card>

      <ComfyServerCard
        url={url}
        onUseUrl={(next) => {
          edit(next);
          flush();
        }}
      />

      {unwired && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-500">
                Added {unwired.workflow} — {Object.keys(unwired.notes).length} field
                {Object.keys(unwired.notes).length === 1 ? "" : "s"} need manual wiring
              </p>
              <ul className="space-y-0.5">
                {Object.entries(unwired.notes).map(([field, why]) => (
                  <li key={field} className="text-xs text-muted-foreground">
                    <code className="text-foreground">{field}</code> — {why}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground pt-1">
                These stay at the workflow&apos;s built-in defaults. Use{" "}
                <strong>Edit params</strong> to wire them by hand.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setUnwired(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Workflows</CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => { setEditorWorkflowKey(""); setEditorOpen(true); }}>
              Edit param maps
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowImport(true)}>
              Import bundle
            </Button>
            <Button size="sm" onClick={() => setShowAdd(true)}>
              Add workflow
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {notice && (
            <p className="text-sm text-emerald-500">Imported {notice}.</p>
          )}
          {exportError && <p className="text-sm text-destructive">{exportError}</p>}
          {deleteErr && <p className="text-sm text-destructive">{deleteErr}</p>}
          {workflows.length === 0 && (
            <p className="text-sm text-muted-foreground">No workflows found</p>
          )}
          {workflows.map((w) => {
            const key = `${w.namespace}/${w.name}`;
            return (
              <div
                key={key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div>
                  <span className="font-mono text-sm font-medium">
                    {w.namespace ? `${w.namespace}.` : "imggen."}
                    {w.name}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {w.task_types.join(", ")}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => exportWorkflow(w)}
                  >
                    Export
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openJsonEditor(w)}
                  >
                    Edit JSON
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEditor(w)}
                  >
                    Edit params
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openMoveDialog("duplicate", w)}
                  >
                    Duplicate
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openMoveDialog("rename", w)}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={deletingKey === key}
                    onClick={() => deleteWorkflow(w)}
                    className="text-destructive hover:text-destructive"
                  >
                    {deletingKey === key ? "Removing…" : "Remove"}
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <AddWorkflowDialog
        open={showAdd}
        standardTaskTypes={standardTaskTypes}
        onClose={() => setShowAdd(false)}
        onAdded={(report) => {
          setShowAdd(false);
          setUnwired(report);
          refreshWorkflows();
        }}
      />

      <RenameDuplicateDialog
        mode={moveMode}
        workflow={moveTarget}
        onClose={() => { setMoveMode(null); setMoveTarget(null); }}
        onDone={() => {
          setMoveMode(null);
          setMoveTarget(null);
          refreshWorkflows();
        }}
      />

      <ImportWorkflowDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onImported={(label) => {
          setShowImport(false);
          setNotice(label);
          refreshWorkflows();
        }}
      />

      {/* Param map editor — right-side drawer */}
      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Workflow param map editor</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {/* key remounts the editor when the selected workflow changes */}
            <ComfyParamMapEditor
              key={editorWorkflowKey}
              workflows={workflows}
              taskTypes={standardTaskTypes}
              initialWorkflowKey={editorWorkflowKey}
            />
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Graph JSON editor — right-side drawer */}
      <Sheet open={jsonEditorOpen} onOpenChange={setJsonEditorOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Workflow graph JSON editor</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {/* key remounts the editor when the selected workflow changes */}
            <ComfyGraphJsonEditor
              key={jsonEditorWorkflowKey}
              workflows={workflows}
              taskTypes={standardTaskTypes}
              initialWorkflowKey={jsonEditorWorkflowKey}
            />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
