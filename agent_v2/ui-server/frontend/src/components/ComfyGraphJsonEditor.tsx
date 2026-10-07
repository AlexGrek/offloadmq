import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/api/client";
import type { ComfyWorkflow } from "@/components/ComfyParamMapEditor";
import { JsonCodeEditor } from "@/components/JsonCodeEditor";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { validateJsonObject } from "@/lib/jsonValidate";

export function ComfyGraphJsonEditor({
  workflows,
  taskTypes,
  initialWorkflowKey = "",
}: {
  workflows: ComfyWorkflow[];
  taskTypes: string[];
  initialWorkflowKey?: string;
}) {
  const [wfKey, setWfKey] = useState(initialWorkflowKey);
  const [taskType, setTaskType] = useState("txt2img");
  const [graphJson, setGraphJson] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const selectedWf = useMemo(
    () => workflows.find((x) => `${x.namespace}::${x.name}` === wfKey) ?? null,
    [workflows, wfKey],
  );

  const taskTypesForWf = useMemo(() => {
    if (selectedWf?.task_types?.length) return selectedWf.task_types;
    return taskTypes;
  }, [taskTypes, selectedWf]);

  const effectiveTaskType = useMemo(() => {
    if (!taskTypesForWf.length) return taskType;
    return taskTypesForWf.includes(taskType) ? taskType : taskTypesForWf[0];
  }, [taskTypesForWf, taskType]);

  const loadGraph = useCallback(async () => {
    setLoadErr(null);
    setSaveErr(null);
    if (!wfKey) {
      setLoadErr("Pick a workflow.");
      return;
    }
    setLoading(true);
    try {
      const data = await api.getComfyWorkflowGraph({
        workflow_name: selectedWf?.name ?? "",
        task_type: effectiveTaskType,
        namespace: selectedWf?.namespace ?? "",
      });
      setGraphJson(data.graph_json);
      setLoaded(true);
    } catch (e) {
      setLoaded(false);
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [wfKey, selectedWf, effectiveTaskType]);

  // Pre-selected from a row's "Edit JSON" button — load immediately so the
  // editor isn't blank behind an extra click.
  useEffect(() => {
    if (initialWorkflowKey) void loadGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onChangeWorkflow(compositeKey: string) {
    setWfKey(compositeKey);
    setGraphJson("");
    setLoaded(false);
    setLoadErr(null);
    setSaveErr(null);
    const w = workflows.find((x) => `${x.namespace}::${x.name}` === compositeKey);
    const ts = w?.task_types?.length ? w.task_types : taskTypes;
    if (ts.length > 0 && !ts.includes(taskType)) {
      setTaskType(ts[0]);
    }
  }

  const liveError = useMemo(
    () => (loaded ? validateJsonObject(graphJson) : null),
    [graphJson, loaded],
  );

  async function save() {
    setSaveErr(null);
    const err = validateJsonObject(graphJson);
    if (err) {
      setSaveErr(err);
      return;
    }
    setSaving(true);
    try {
      await api.addComfyWorkflow({
        workflow_name: selectedWf?.name ?? "",
        task_type: effectiveTaskType,
        namespace: selectedWf?.namespace ?? "",
        graph_json: graphJson,
      });
      await loadGraph();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Edit the raw ComfyUI API-format graph for one workflow / task type. Saving validates the
        JSON — node objects need a <code className="text-foreground">class_type</code>, and wire
        references must point at a node that exists — before writing, so an invalid edit never
        touches the file on disk.
      </p>

      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="block text-[0.65rem] text-muted-foreground mb-1">Workflow</label>
          <Select value={wfKey || undefined} onValueChange={onChangeWorkflow}>
            <SelectTrigger className="min-w-44">
              <SelectValue placeholder="-- select --" />
            </SelectTrigger>
            <SelectContent>
              {workflows.map((w) => {
                const key = `${w.namespace}::${w.name}`;
                const label = w.namespace ? `[${w.namespace}] ${w.name}` : w.name;
                return (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="block text-[0.65rem] text-muted-foreground mb-1">Task type</label>
          <Select value={effectiveTaskType} onValueChange={setTaskType}>
            <SelectTrigger className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {taskTypesForWf.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={!wfKey.trim() || loading} onClick={loadGraph}>
          {loading ? "Loading…" : "Load"}
        </Button>
        <Button type="button" size="sm" disabled={!loaded || saving || !!liveError} onClick={save}>
          {saving ? "Saving…" : "Save graph JSON"}
        </Button>
      </div>

      {loadErr && <p className="text-xs text-destructive">{loadErr}</p>}
      {saveErr && <p className="text-xs text-destructive">{saveErr}</p>}
      {loaded && liveError && <p className="text-xs text-amber-500/90">{liveError}</p>}

      {loaded ? (
        <JsonCodeEditor value={graphJson} onChange={setGraphJson} minHeight="320px" maxHeight="60vh" />
      ) : (
        !loadErr && (
          <p className="text-xs text-muted-foreground">Pick a workflow and task type, then Load.</p>
        )
      )}
    </div>
  );
}
