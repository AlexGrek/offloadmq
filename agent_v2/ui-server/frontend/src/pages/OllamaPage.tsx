import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveIndicator } from "@/components/SaveIndicator";
import { useEditableSettings } from "@/hooks/useEditableSettings";

type OllamaForm = {
  ollama_base_url: string;
};

type OllamaStatus = {
  ok: boolean;
  capabilities: string[];
  reason: string;
};

export function OllamaPage() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [probing, setProbing] = useState(false);

  const probe = async () => {
    setProbing(true);
    try {
      setStatus(await api.getOllamaStatus());
    } catch (e) {
      setStatus({
        ok: false,
        capabilities: [],
        reason: e instanceof Error ? e.message : "Probe failed",
      });
    } finally {
      setProbing(false);
    }
  };

  const {
    form,
    edit,
    flush,
    status: saveStatus,
    error,
  } = useEditableSettings<OllamaForm>(
    { ollama_base_url: "" },
    async () => {
      const [s] = await Promise.all([api.getSettings(), probe()]);
      return {
        ollama_base_url: s.ollama_base_url ?? "",
      };
    },
    async (next) => {
      await api.saveSettings(next);
      await api.rescanCapabilities(true);
      await probe();
    }
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Ollama</h1>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Server</CardTitle>
            <CardDescription>
              Ollama HTTP endpoint. Used for <code className="text-xs">llm.*</code> tasks
              and model detection.
            </CardDescription>
          </div>
          <SaveIndicator status={saveStatus} error={error} />
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="ollama-url">Base URL</Label>
          <Input
            id="ollama-url"
            value={form.ollama_base_url}
            onChange={(e) => edit({ ollama_base_url: e.target.value })}
            onBlur={flush}
            onKeyDown={(e) => e.key === "Enter" && flush()}
            placeholder="http://127.0.0.1:11434"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Reachability</CardTitle>
          <Button variant="outline" size="sm" onClick={probe} disabled={probing}>
            {probing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Test
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {status === null ? (
            <p className="text-muted-foreground">Checking…</p>
          ) : (
            <>
              <p>
                Status:{" "}
                <span
                  className={
                    status.ok ? "text-green-600 dark:text-green-400" : "text-destructive"
                  }
                >
                  {status.ok ? "reachable" : "unavailable"}
                </span>
              </p>
              <p className="text-muted-foreground">{status.reason}</p>
              {status.capabilities.length > 0 && (
                <p>
                  Capabilities:{" "}
                  <code className="text-xs">{status.capabilities.join(", ")}</code>
                </p>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground pt-2">
            Saving settings triggers a background capability rescan. Re-register or
            restart the agent if the server still shows the old cap list.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
