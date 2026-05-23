import { useCallback, useState } from "react";

import { api } from "@/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePoll } from "@/hooks/usePoll";

export function LogsPage() {
  const [lines, setLines] = useState<string[]>([]);

  const load = useCallback(async () => {
    const r = await api.getAgentLogs(200);
    setLines(r.lines);
  }, []);

  usePoll(load, 2000);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Agent logs</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tail</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[70vh] overflow-auto text-xs font-mono whitespace-pre-wrap">
            {lines.join("\n") || "No logs yet"}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
