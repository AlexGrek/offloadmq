import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { api } from "@/api/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveIndicator } from "@/components/SaveIndicator";
import type { SaveStatus } from "@/hooks/useDebouncedSave";
import type { Settings } from "@/types";

type RuntimeSettings = Pick<Settings, "llm_runtime_enabled" | "llm_runtime_cache_limit">;

/** Runtime enablement and individual model approval are independent opt-ins. */
export function LlmRuntimeSettings({ modelsDetected }: { modelsDetected?: boolean }) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [cacheLimit, setCacheLimit] = useState("8");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    let disposed = false;
    api.getSettings().then((cfg) => {
      if (disposed) return;
      setSettings(cfg);
      setCacheLimit(String(cfg.llm_runtime_cache_limit));
    }).catch((e: unknown) => {
      if (disposed) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => { disposed = true; };
  }, []);

  const save = async (patch: Partial<RuntimeSettings>) => {
    if (!settings || saving.current) return;
    saving.current = true;
    const before = settings;
    setSettings({ ...settings, ...patch });
    setStatus("saving");
    setError(null);
    try {
      const saved = await api.saveSettings(patch);
      setSettings(saved);
      setCacheLimit(String(saved.llm_runtime_cache_limit));
      setStatus("saved");
    } catch (e) {
      setSettings(before);
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      saving.current = false;
    }
  };

  const saveLimit = () => {
    const value = Number(cacheLimit);
    if (!Number.isSafeInteger(value) || value < 1) {
      setStatus("error");
      setError("Dependency cache limit must be a positive whole number.");
      return;
    }
    if (value !== settings?.llm_runtime_cache_limit) {
      void save({ llm_runtime_cache_limit: value });
    } else {
      setError(null);
      setStatus("idle");
    }
  };

  const disabled = !settings || status === "saving";
  return (
    <Card data-testid="llm-runtime-settings">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>LLM runtime / LangGraph</CardTitle>
          <CardDescription>Run client-supplied Python applications with local Ollama models.</CardDescription>
        </div>
        <SaveIndicator status={status} error={error} />
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Unsafe: applications and dependency installers run with this account’s filesystem,
          network and process permissions. Enable only for trusted clients.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings?.llm_runtime_enabled ?? false}
            disabled={disabled}
            onChange={(e) => void save({ llm_runtime_enabled: e.target.checked })}
            data-testid="llm-runtime-enabled"
          />
          Enable LLM runtime (LangGraph) on this runner
        </label>
        <div className="max-w-xs space-y-2">
          <Label htmlFor="llm-runtime-cache-limit">Dependency cache limit</Label>
          <Input
            id="llm-runtime-cache-limit"
            type="number"
            min={1}
            step={1}
            value={cacheLimit}
            disabled={disabled}
            onChange={(e) => setCacheLimit(e.target.value)}
            onBlur={saveLimit}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
          <p className="text-xs text-muted-foreground">Cached Python environments to keep (default 8).</p>
        </div>
        <p className="text-sm text-muted-foreground">
          Also approve each <code>llm-runtime.&lt;model&gt;</code> under Sensitive (opt-in) on{" "}
          <Link className="underline" to="/capabilities">Capabilities</Link>.
          Turning this switch off blocks runtime execution while retaining your model approvals.
        </p>
        {modelsDetected === false && (
          <p className="text-sm text-muted-foreground" data-testid="llm-runtime-prerequisites">
            No runtime models detected. Install uv on PATH and install a model in Ollama,
            then Rescan. Restart the agent UI after changing PATH on Windows.
          </p>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
