import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ConfigPage() {
  const [json, setJson] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.getRawConfig().then((r) => setJson(r.json));
  }, []);

  const save = async () => {
    try {
      setError("");
      await api.saveRawConfig(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Raw config</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">.offloadmq-agent.json</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <textarea
            className="min-h-96 w-full rounded-md border bg-background p-3 font-mono text-xs"
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <Button onClick={save}>Save</Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
