import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
export function ComfyPage() {
  const [url, setUrl] = useState("");
  const [workflows, setWorkflows] = useState<
    { name: string; namespace: string; task_types: string[] }[]
  >([]);

  useEffect(() => {
    api.getSettings().then((s) => setUrl(s.comfyui_url ?? ""));
    api.getComfyWorkflows().then((r) => setWorkflows(r.workflows));
  }, []);

  const saveUrl = async () => {
    await api.saveComfyUrl(url);
    const r = await api.getComfyWorkflows();
    setWorkflows(r.workflows);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">ComfyUI workflows</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ComfyUI URL</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button onClick={saveUrl}>Save</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workflows</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {workflows.length === 0 && (
            <p className="text-sm text-muted-foreground">No workflows found</p>
          )}
          {workflows.map((w) => (
            <div key={`${w.namespace}/${w.name}`} className="text-sm">
              <span className="font-medium">
                {w.namespace ? `${w.namespace}.` : "imggen."}
                {w.name}
              </span>
              <span className="text-muted-foreground">
                {" "}
                — {w.task_types.join(", ")}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
