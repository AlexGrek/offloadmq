import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveIndicator } from "@/components/SaveIndicator";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";

type KokoroForm = {
  kokoro_api_url: string;
  kokoro_api_key: string;
};

type KokoroStatus = {
  ok: boolean;
  capabilities: string[];
  reason: string;
};

export function KokoroPage() {
  const [form, setForm] = useState<KokoroForm>({
    kokoro_api_url: "",
    kokoro_api_key: "",
  });
  const [status, setStatus] = useState<KokoroStatus | null>(null);
  const [probing, setProbing] = useState(false);

  const { schedule, flush, status: saveStatus } = useDebouncedSave<KokoroForm>(
    async (next) => {
      await api.saveKokoroSettings(next);
      await probe();
    }
  );

  const probe = async () => {
    setProbing(true);
    try {
      setStatus(await api.getKokoroStatus());
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

  useEffect(() => {
    api.getSettings().then((s) => {
      setForm({
        kokoro_api_url: s.kokoro_api_url ?? "",
        kokoro_api_key: s.kokoro_api_key ?? "",
      });
    });
    probe();
  }, []);

  const edit = (patch: Partial<KokoroForm>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      schedule(next);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Kokoro TTS</h1>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="space-y-1.5">
            <CardTitle className="text-base">API connection</CardTitle>
            <CardDescription>
              Kokoro-FastAPI OpenAI-compatible speech endpoint. Used for{" "}
              <code className="text-xs">tts.kokoro</code> tasks and capability
              detection.
            </CardDescription>
          </div>
          <SaveIndicator status={saveStatus} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="kokoro-url">Speech API URL</Label>
            <Input
              id="kokoro-url"
              value={form.kokoro_api_url}
              onChange={(e) => edit({ kokoro_api_url: e.target.value })}
              onBlur={flush}
              onKeyDown={(e) => e.key === "Enter" && flush()}
              placeholder="https://localhost:8443/v1/audio/speech"
            />
            <p className="text-xs text-muted-foreground">
              Voices are probed at the same host: /v1/audio/voices
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="kokoro-key">API key (optional)</Label>
            <Input
              id="kokoro-key"
              type="password"
              value={form.kokoro_api_key}
              onChange={(e) => edit({ kokoro_api_key: e.target.value })}
              onBlur={flush}
              onKeyDown={(e) => e.key === "Enter" && flush()}
              placeholder="Bearer token if KW_SECRET_API_KEY is set"
              autoComplete="off"
            />
          </div>
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
                  Capability:{" "}
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
