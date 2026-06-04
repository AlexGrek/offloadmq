import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveIndicator } from "@/components/SaveIndicator";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";
import type { Settings } from "@/types";

export function ConnectionPage() {
  const [form, setForm] = useState<Partial<Settings>>({});
  const [registerId, setRegisterId] = useState("");

  const { schedule, flush, status } = useDebouncedSave<Partial<Settings>>(
    (patch) => api.saveSettings(patch)
  );

  useEffect(() => {
    api.getSettings().then((settings) => {
      if (!settings.display_name) {
        api.getDefaultDisplayName().then(({ display_name: defaultName }) => {
          if (defaultName) {
            const patched = { ...settings, display_name: defaultName };
            setForm(patched);
            schedule(patched);
          } else {
            setForm(settings);
          }
        });
      } else {
        setForm(settings);
      }
    });
  }, []);

  const edit = (patch: Partial<Settings>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      schedule(next);
      return next;
    });
  };

  const register = async () => {
    const { agentId } = await api.registerAgent();
    setRegisterId(agentId);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Connection</h1>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Server</CardTitle>
          <SaveIndicator status={status} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Server URL</Label>
            <Input
              value={form.server ?? ""}
              onChange={(e) => edit({ server: e.target.value })}
              onBlur={flush}
              onKeyDown={(e) => e.key === "Enter" && flush()}
            />
          </div>
          <div className="space-y-2">
            <Label>API key</Label>
            <Input
              type="password"
              value={form.api_key ?? ""}
              onChange={(e) => edit({ api_key: e.target.value })}
              onBlur={flush}
              onKeyDown={(e) => e.key === "Enter" && flush()}
            />
          </div>
          <div className="space-y-2">
            <Label>Machine name</Label>
            <Input
              value={form.display_name ?? ""}
              onChange={(e) =>
                edit({ display_name: e.target.value.slice(0, 50) })
              }
              onBlur={flush}
              onKeyDown={(e) => e.key === "Enter" && flush()}
              maxLength={50}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={register}>
              Register
            </Button>
            {registerId && (
              <span className="text-sm text-muted-foreground">
                Registered: {registerId}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
