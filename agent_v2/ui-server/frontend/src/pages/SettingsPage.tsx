import { useEffect, useState } from "react";
import { Loader2, Save, Search } from "lucide-react";

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
import type { Settings } from "@/types";

const EMPTY: Settings = {
  server: "",
  api_key: "",
  display_name: "",
  capabilities: [],
  custom_caps: [],
  tier: 1,
  max_concurrent: 1,
  autostart: false,
  webui_port: 8090,
  regular_disabled_caps: [],
  sensitive_allowed_caps: [],
  slavemode_allowed_caps: [],
  comfyui_url: "http://127.0.0.1:8188",
  win_startup_enabled: false,
  mac_startup_enabled: false,
  agent_id: "",
  key: "",
  jwt_token: "",
  token_expires_in: 0,
};

export function SettingsPage() {
  const [cfg, setCfg] = useState<Settings>(EMPTY);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    api.getSettings().then(setCfg).catch(() => {});
  }, []);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setCfg((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.saveSettings({
        server: cfg.server,
        api_key: cfg.api_key,
        capabilities: cfg.capabilities,
        custom_caps: cfg.custom_caps,
        tier: cfg.tier,
        max_concurrent: cfg.max_concurrent,
        autostart: cfg.autostart,
      });
      setCfg(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const { capabilities } = await api.detectCapabilities();
      set("capabilities", capabilities);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
        <CardDescription>
          Connection, capabilities and concurrency for this agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="server">Server URL</Label>
          <Input
            id="server"
            value={cfg.server}
            onChange={(e) => set("server", e.target.value)}
            placeholder="http://your-server:3069"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="apiKey">API Key</Label>
          <Input
            id="apiKey"
            type="password"
            value={cfg.api_key}
            onChange={(e) => set("api_key", e.target.value)}
            placeholder="ak_live_..."
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="tier">Tier</Label>
            <Input
              id="tier"
              type="number"
              min={1}
              value={cfg.tier}
              onChange={(e) => set("tier", Number(e.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="threads">Max concurrent (threads)</Label>
            <Input
              id="threads"
              type="number"
              min={1}
              value={cfg.max_concurrent}
              onChange={(e) => set("max_concurrent", Number(e.target.value))}
            />
          </div>
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
              set(
                "capabilities",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            }
            placeholder="debug.echo, llm.mistral, shell.bash"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom">Custom capabilities</Label>
          <Input
            id="custom"
            value={cfg.custom_caps.join(", ")}
            onChange={(e) =>
              set(
                "custom_caps",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            }
            placeholder="my.custom.cap"
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.autostart}
            onChange={(e) => set("autostart", e.target.checked)}
          />
          Auto-start agent on launch
        </label>

        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          {saved ? "Saved!" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
