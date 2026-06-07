import { useCallback, useMemo, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import type { InputOption, ParamMap, ParamTarget, StandardField } from "@/types";

const CUSTOM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function optValue(opt: InputOption): string {
  return JSON.stringify([opt.node_id, opt.input_name]);
}

function parseOptValue(s: string): ParamTarget | null {
  if (!s) return null;
  try {
    const a = JSON.parse(s) as unknown;
    if (Array.isArray(a) && a.length === 2 && a[0] !== "" && a[1] !== "") {
      return [String(a[0]), String(a[1])];
    }
  } catch {
    // ignore
  }
  return null;
}

function pairSelectValue(pair: ParamTarget): string {
  const a = String(pair[0] ?? "");
  const b = String(pair[1] ?? "");
  if (!a || !b) return "";
  return JSON.stringify([a, b]);
}

function buildParamsForSave(localParams: ParamMap, standardKeys: string[]): ParamMap {
  const allKeys = new Set([...standardKeys, ...Object.keys(localParams)]);
  const out: ParamMap = {};
  for (const key of allKeys) {
    const v = localParams[key];
    if (v === null) {
      out[key] = null;
      continue;
    }
    if (!Array.isArray(v)) {
      out[key] = [];
      continue;
    }
    out[key] = v
      .filter(
        (p): p is ParamTarget =>
          Array.isArray(p) && p.length >= 2 && String(p[0]).length > 0 && String(p[1]).length > 0,
      )
      .map((p): ParamTarget => [String(p[0]), String(p[1])]);
  }
  return out;
}

function FieldRow({
  fieldKey,
  label,
  help,
  locked,
  targets,
  inputOptions,
  onToggleLock,
  onChangeTargets,
}: {
  fieldKey: string;
  label: string;
  help: string;
  locked: boolean;
  targets: ParamTarget[];
  inputOptions: InputOption[];
  onToggleLock: (locked: boolean) => void;
  onChangeTargets: (targets: ParamTarget[]) => void;
}) {
  function setRow(idx: number, jsonVal: string) {
    const parsed = parseOptValue(jsonVal);
    const next = targets.map((p, i): ParamTarget => {
      if (i !== idx) return [...p] as ParamTarget;
      return parsed ? ([...parsed] as ParamTarget) : ["", ""];
    });
    onChangeTargets(next);
  }

  function addRow() {
    onChangeTargets([...targets.map((p): ParamTarget => [...p] as ParamTarget), ["", ""]]);
  }

  function removeRow(idx: number) {
    onChangeTargets(targets.filter((_, i) => i !== idx));
  }

  return (
    <div className="border border-border rounded-md p-3 mb-3 bg-muted/30">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-[0.65rem] text-muted-foreground font-mono mt-0.5">{help}</div>
          <div className="text-[0.65rem] text-muted-foreground/60 mt-1">
            param key: <code className="text-muted-foreground">{fieldKey}</code>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={locked}
            onChange={(e) => onToggleLock(e.target.checked)}
          />
          Lock to workflow default (null in params.json)
        </label>
      </div>
      {!locked && (
        <div className="space-y-2">
          {targets.length === 0 ? (
            <p className="text-xs text-muted-foreground">No targets. Add one or leave empty.</p>
          ) : (
            targets.map((pair, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-2">
                <select
                  value={pairSelectValue(pair)}
                  onChange={(e) => setRow(idx, e.target.value)}
                  className="flex-1 min-w-60 h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">-- pick node input --</option>
                  {inputOptions.map((opt) => (
                    <option key={optValue(opt)} value={optValue(opt)}>
                      {opt.node_id} {opt.class_type} .{opt.input_name} ({opt.kind}) = {opt.preview}
                    </option>
                  ))}
                </select>
                <Button type="button" size="sm" variant="outline" onClick={() => removeRow(idx)}>
                  Remove
                </Button>
              </div>
            ))
          )}
          <Button type="button" size="sm" variant="secondary" onClick={addRow}>
            Add target
          </Button>
          <p className="text-[0.65rem] text-muted-foreground">
            Multiple targets write the same payload value to every listed Comfy input (broadcast).
          </p>
        </div>
      )}
    </div>
  );
}

export interface ComfyWorkflow {
  name: string;
  namespace: string;
  task_types: string[];
}

export function ComfyParamMapEditor({
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
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [standardFields, setStandardFields] = useState<StandardField[]>([]);
  const [inputOptions, setInputOptions] = useState<InputOption[]>([]);
  const [localParams, setLocalParams] = useState<ParamMap>({});

  const standardKeys = useMemo(() => standardFields.map((f) => f.key), [standardFields]);

  const customKeys = useMemo(() => {
    const sk = new Set(standardKeys);
    return Object.keys(localParams).filter((k) => !sk.has(k));
  }, [localParams, standardKeys]);

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

  function onChangeWorkflow(compositeKey: string) {
    setWfKey(compositeKey);
    setStandardFields([]);
    setInputOptions([]);
    setLocalParams({});
    setLoadErr(null);
    setSaveErr(null);
    const w = workflows.find((x) => `${x.namespace}::${x.name}` === compositeKey);
    const ts = w?.task_types?.length ? w.task_types : taskTypes;
    if (ts.length > 0 && !ts.includes(taskType)) {
      setTaskType(ts[0]);
    }
  }

  const loadParamMap = useCallback(async () => {
    setLoadErr(null);
    if (!wfKey) {
      setLoadErr("Pick a workflow.");
      return;
    }
    try {
      const data = await api.getComfyParamMap({
        workflow_name: selectedWf?.name ?? "",
        task_type: effectiveTaskType,
        namespace: selectedWf?.namespace ?? "",
      });
      setStandardFields(data.standard_fields);
      setInputOptions(data.input_options);
      setLocalParams(JSON.parse(JSON.stringify(data.params)) as ParamMap);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, [wfKey, selectedWf, effectiveTaskType]);

  function setFieldTargets(key: string, targets: ParamTarget[]) {
    setLocalParams((p) => ({ ...p, [key]: targets }));
  }

  function toggleFieldLock(key: string, locked: boolean) {
    setLocalParams((p) => {
      if (locked) return { ...p, [key]: null };
      const cur = p[key];
      const next = Array.isArray(cur) && cur.length ? cur : [];
      return { ...p, [key]: next };
    });
  }

  async function saveParamMap() {
    setSaveErr(null);
    setSaving(true);
    try {
      const params = buildParamsForSave(localParams, standardKeys);
      await api.saveComfyParamMap({
        workflow_name: selectedWf?.name ?? "",
        namespace: selectedWf?.namespace ?? "",
        task_type: effectiveTaskType,
        params,
      });
      await loadParamMap();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function autodetect() {
    if (
      !window.confirm(
        "Overwrite this task type params.json with auto-detect merged on top of FIXME stubs?",
      )
    ) {
      return;
    }
    setSaveErr(null);
    setSaving(true);
    try {
      await api.autodetectComfyParamMap({
        workflow_name: selectedWf?.name ?? "",
        namespace: selectedWf?.namespace ?? "",
        task_type: effectiveTaskType,
        param_map_json: "{}",
      });
      await loadParamMap();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const [newCustomKey, setNewCustomKey] = useState("");

  function addCustomField(rawKey: string) {
    const key = rawKey.trim();
    if (!CUSTOM_KEY_RE.test(key)) {
      setSaveErr("Invalid key: use letters, digits, underscore, dot, hyphen.");
      return;
    }
    if (localParams[key] !== undefined) {
      setSaveErr("That key already exists.");
      return;
    }
    setSaveErr(null);
    setLocalParams((p) => ({ ...p, [key]: [] }));
  }

  function removeCustomField(key: string) {
    setLocalParams((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Map imggen payload fields to Comfy node inputs. Each dropdown shows the node id, class type,
        input name, whether the value is a literal or a wire, and a short preview of the default.
        Use this when auto-detect missed nodes or used the wrong slot.
      </p>

      {/* Selectors + actions */}
      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="block text-[0.65rem] text-muted-foreground mb-1">Workflow</label>
          <select
            value={wfKey}
            onChange={(e) => onChangeWorkflow(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm min-w-44"
          >
            <option value="">-- select --</option>
            {workflows.map((w) => {
              const key = `${w.namespace}::${w.name}`;
              const label = w.namespace ? `[${w.namespace}] ${w.name}` : w.name;
              return (
                <option key={key} value={key}>
                  {label}
                </option>
              );
            })}
          </select>
        </div>
        <div>
          <label className="block text-[0.65rem] text-muted-foreground mb-1">Task type</label>
          <select
            value={effectiveTaskType}
            onChange={(e) => setTaskType(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm min-w-35"
          >
            {taskTypesForWf.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={loadParamMap}>
          Load
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!wfKey.trim() || saving}
          onClick={saveParamMap}
        >
          {saving ? "Saving…" : "Save params.json"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!wfKey.trim() || saving}
          onClick={autodetect}
        >
          Re-run auto-detect
        </Button>
      </div>

      {loadErr && <p className="text-xs text-destructive">{loadErr}</p>}
      {saveErr && <p className="text-xs text-destructive">{saveErr}</p>}

      {/* Standard fields */}
      {standardFields.length > 0 && (
        <div>
          <h4 className="text-[0.65rem] font-semibold text-muted-foreground uppercase mb-2">
            Standard fields
          </h4>
          {standardFields.map((f) => {
            const v = localParams[f.key];
            const locked = v === null;
            const targets: ParamTarget[] =
              locked || !Array.isArray(v)
                ? []
                : v.map((p): ParamTarget => [...p] as ParamTarget);
            return (
              <FieldRow
                key={f.key}
                fieldKey={f.key}
                label={f.label}
                help={f.help}
                locked={locked}
                targets={targets}
                inputOptions={inputOptions}
                onToggleLock={(on) => toggleFieldLock(f.key, on)}
                onChangeTargets={(t) => setFieldTargets(f.key, t)}
              />
            );
          })}
        </div>
      )}

      {standardFields.length === 0 && Object.keys(localParams).length > 0 && (
        <p className="text-xs text-amber-500/90">
          No standard field list for this task type. Edit custom keys below or pick a standard task
          type.
        </p>
      )}

      {/* Custom / extra fields */}
      {customKeys.length > 0 && (
        <div>
          <h4 className="text-[0.65rem] font-semibold text-muted-foreground uppercase mb-2">
            Extra params (secondary_prompts or custom)
          </h4>
          {customKeys.map((key) => {
            const v = localParams[key];
            const locked = v === null;
            const targets: ParamTarget[] =
              locked || !Array.isArray(v)
                ? []
                : v.map((p): ParamTarget => [...p] as ParamTarget);
            return (
              <div key={key}>
                <FieldRow
                  fieldKey={key}
                  label={key}
                  help="Maps payload.secondary_prompts or matching injection key"
                  locked={locked}
                  targets={targets}
                  inputOptions={inputOptions}
                  onToggleLock={(on) => toggleFieldLock(key, on)}
                  onChangeTargets={(t) => setFieldTargets(key, t)}
                />
                <div className="-mt-2 mb-3">
                  <button
                    type="button"
                    onClick={() => removeCustomField(key)}
                    className="text-xs text-destructive hover:underline"
                  >
                    Remove field &quot;{key}&quot;
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add custom key */}
      <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
        <input
          type="text"
          value={newCustomKey}
          onChange={(e) => setNewCustomKey(e.target.value)}
          placeholder="custom_param_key"
          className="h-8 rounded-md border border-input bg-background px-3 text-xs w-48"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              addCustomField(newCustomKey);
              setNewCustomKey("");
            }
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            addCustomField(newCustomKey);
            setNewCustomKey("");
          }}
        >
          Add custom param key
        </Button>
      </div>
    </div>
  );
}
