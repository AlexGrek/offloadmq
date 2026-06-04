import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveIndicator } from "@/components/SaveIndicator";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";
import type { Settings } from "@/types";

const EMPTY: Settings = {
  server: "",
  api_key: "",
  display_name: "",
  capabilities: [],
  custom_caps: [],
  max_concurrent: 1,
  autostart: false,
  webui_port: 8090,
  regular_disabled_caps: [],
  sensitive_allowed_caps: [],
  slavemode_allowed_caps: [],
  comfyui_url: "http://127.0.0.1:8188",
  kokoro_api_url: "",
  kokoro_api_key: "",
  win_startup_enabled: false,
  mac_startup_enabled: false,
  agent_id: "",
  key: "",
  jwt_token: "",
  token_expires_in: 0,
};

export function SettingsPage() {
  const [cfg, setCfg] = useState<Settings>(EMPTY);
  const [detecting, setDetecting] = useState(false);

  const { schedule, flush, status } = useDebouncedSave<Partial<Settings>>(
    (patch) => api.saveSettings(patch)
  );

  useEffect(() => {
    api.getSettings().then(setCfg).catch(() => {});
  }, []);

  const edit = (patch: Partial<Settings>) => {
    setCfg((prev) => ({ ...prev, ...patch }));
    schedule(patch);
  };

  const editNow = (patch: Partial<Settings>) => {
    setCfg((prev) => ({ ...prev, ...patch }));
    schedule(patch);
    flush();
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const { capabilities } = await api.detectCapabilities();
      editNow({ capabilities });
    } finally {
      setDetecting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1.5">
          <CardTitle>Configuration</CardTitle>
          <CardDescription>
            Connection, capabilities and concurrency for this agent.
          </CardDescription>
        </div>
        <SaveIndicator status={status} />
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="server">Server URL</Label>
          <Input
            id="server"
            value={cfg.server}
            onChange={(e) => edit({ server: e.target.value })}
            onBlur={flush}
            onKeyDown={(e) => e.key === "Enter" && flush()}
            placeholder="http://your-server:3069"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="apiKey">API Key</Label>
          <Input
            id="apiKey"
            type="password"
            value={cfg.api_key}
            onChange={(e) => edit({ api_key: e.target.value })}
            onBlur={flush}
            onKeyDown={(e) => e.key === "Enter" && flush()}
            placeholder="ak_live_..."
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="threads">Max concurrent tasks</Label>
          <Input
            id="threads"
            type="number"
            min={1}
            value={cfg.max_concurrent}
            onChange={(e) => edit({ max_concurrent: Number(e.target.value) })}
            onBlur={flush}
            onKeyDown={(e) => e.key === "Enter" && flush()}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="caps">Capabilities</Label>
            <Button
              variant="outline"
              size="sm"
              onClick={detect}
              disabled={detecting}
            >
              {detecting ? <Loader2 className="animate-spin" /> : <Search />}
              Auto-detect
            </Button>
          </div>
          <Input
            id="caps"
            value={cfg.capabilities.join(", ")}
            onChange={(e) =>
              edit({
                capabilities: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            onBlur={flush}
            placeholder="debug.echo, llm.mistral, shell.bash"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom">Custom capabilities</Label>
          <Input
            id="custom"
            value={cfg.custom_caps.join(", ")}
            onChange={(e) =>
              edit({
                custom_caps: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            onBlur={flush}
            placeholder="my.custom.cap"
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.autostart}
            onChange={(e) => editNow({ autostart: e.target.checked })}
          />
          Auto-start agent on launch
        </label>
      </CardContent>
    </Card>
  );
}
