import { useEffect, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CustomCapsPage() {
  const [caps, setCaps] = useState<{ name: string; capability: string }[]>([]);
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState("");

  const load = () => api.listCustomCaps().then((r) => setCaps(r.caps));

  useEffect(() => {
    load();
  }, []);

  const edit = async (capName: string) => {
    const { yaml: text } = await api.getCustomCap(capName);
    setName(capName);
    setYaml(text);
  };

  const save = async () => {
    await api.saveCustomCap(name, yaml);
    setName("");
    setYaml("");
    load();
  };

  const remove = async (capName: string) => {
    await api.deleteCustomCap(capName);
    load();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Custom capabilities</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Installed</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {caps.map((c) => (
            <div key={c.name} className="flex items-center justify-between text-sm">
              <span className="font-mono">{c.capability}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => edit(c.name)}>
                  Edit
                </Button>
                <Button size="sm" variant="destructive" onClick={() => remove(c.name)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Editor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <textarea
            className="min-h-64 w-full rounded-md border bg-background p-3 font-mono text-xs"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
          />
          <Button onClick={save}>Save YAML</Button>
        </CardContent>
      </Card>
    </div>
  );
}
