import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Settings } from "@/types";

export function ConnectionPage() {
  const [form, setForm] = useState<Partial<Settings>>({});
  const [saved, setSaved] = useState(false);
  const [registerId, setRegisterId] = useState("");

  useEffect(() => {
    api.getSettings().then(setForm);
  }, []);

  const save = async () => {
    await api.saveSettings(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const register = async () => {
    const { agentId } = await api.registerAgent();
    setRegisterId(agentId);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Connection</h1>
      <Card>
        <CardHeader>
          <CardTitle>Server</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Server URL</Label>
            <Input
              value={form.server ?? ""}
              onChange={(e) => setForm({ ...form, server: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>API key</Label>
            <Input
              type="password"
              value={form.api_key ?? ""}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Display name</Label>
            <Input
              value={form.display_name ?? ""}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={save}>Save</Button>
            <Button variant="outline" onClick={register}>
              Register
            </Button>
            {saved && <span className="text-sm text-green-500">Saved</span>}
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
