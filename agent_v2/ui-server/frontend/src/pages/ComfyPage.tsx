import { useEffect, useRef, useState } from "react";

import { api } from "@/api/client";
import { ComfyParamMapEditor } from "@/components/ComfyParamMapEditor";
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
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SaveIndicator } from "@/components/SaveIndicator";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";

type Workflow = { name: string; namespace: string; task_types: string[] };

const DEFAULT_TASK_TYPES = [
  "txt2img", "img2img", "inpaint", "outpaint", "upscale",
  "face_swap", "txt2video", "img2video", "txt2music",
];

function AddWorkflowDialog({
  open,
  standardTaskTypes,
  onClose,
  onAdded,
}: {
  open: boolean;
  standardTaskTypes: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [taskType, setTaskType] = useState(standardTaskTypes[0] ?? "txt2img");
  const [namespace, setNamespace] = useState("");
  const [graphJson, setGraphJson] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName("");
    setTaskType(standardTaskTypes[0] ?? "txt2img");
    setNamespace("");
    setGraphJson("");
    setError("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    setError("");
    if (!name.trim()) { setError("Workflow name is required"); return; }
    if (!graphJson.trim()) { setError("Graph JSON is required"); return; }
    setSaving(true);
    try {
      await api.addComfyWorkflow({
        workflow_name: name.trim(),
        task_type: taskType,
        namespace: namespace.trim(),
        graph_json: graphJson.trim(),
      });
      try {
        await api.autodetectComfyParamMap({
          workflow_name: name.trim(),
          task_type: taskType,
          namespace: namespace.trim(),
          param_map_json: "{}",
        });
      } catch {
        // non-fatal
      }
      reset();
      onAdded();
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
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={taskType}
                onChange={(e) => setTaskType(e.target.value)}
              >
                {standardTaskTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <Label>
              Namespace{" "}
              <span className="text-muted-foreground font-normal">(optional — e.g. txt2music)</span>
            </Label>
            <Input
              placeholder="leave blank for imggen.*"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>ComfyUI API-format graph JSON</Label>
            <textarea
              className="w-full h-48 rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono shadow-sm resize-y"
              placeholder='{"1": {"class_type": "...", "inputs": {...}}, ...}'
              value={graphJson}
              onChange={(e) => setGraphJson(e.target.value)}
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

export function ComfyPage() {
  const [url, setUrl] = useState("");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [standardTaskTypes, setStandardTaskTypes] = useState<string[]>(DEFAULT_TASK_TYPES);
  const [showAdd, setShowAdd] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const standardTaskTypesRef = useRef<string[]>([]);

  // Param map drawer state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorWorkflowKey, setEditorWorkflowKey] = useState<string>("");

  const refreshWorkflows = () =>
    api.getComfyWorkflows().then((r) => {
      setWorkflows(r.workflows);
      setStandardTaskTypes(r.standardTaskTypes);
      standardTaskTypesRef.current = r.standardTaskTypes;
    });

  const { schedule, flush, status } = useDebouncedSave<string>(async (next) => {
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
    try {
      await api.deleteComfyWorkflow(w.name, w.namespace);
      await refreshWorkflows();
    } finally {
      setDeletingKey(null);
    }
  };

  const openEditor = (w: Workflow) => {
    setEditorWorkflowKey(`${w.namespace}::${w.name}`);
    setEditorOpen(true);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">ComfyUI workflows</h1>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">ComfyUI URL</CardTitle>
          <SaveIndicator status={status} />
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

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Workflows</CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => { setEditorWorkflowKey(""); setEditorOpen(true); }}>
              Edit param maps
            </Button>
            <Button size="sm" onClick={() => setShowAdd(true)}>
              Add workflow
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {workflows.length === 0 && (
            <p className="text-sm text-muted-foreground">No workflows found</p>
          )}
          {workflows.map((w) => {
            const key = `${w.namespace}/${w.name}`;
            return (
              <div
                key={key}
                className="flex items-center justify-between rounded-md border px-3 py-2"
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
                <div className="flex items-center gap-2">
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
        onAdded={() => {
          setShowAdd(false);
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
    </div>
  );
}
