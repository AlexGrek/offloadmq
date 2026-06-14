import { useState } from "react";
import { Link } from "react-router";
import { Activity, Loader2, Play, RefreshCw, Square } from "lucide-react";

import { api } from "@/api/client";
import { KeepAwakeCard } from "@/components/KeepAwakeCard";
import { usePoll } from "@/hooks/usePoll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { AgentStatus, TaskRecord } from "@/types";
import { TERMINAL_STATUSES } from "@/types";

export function DashboardPage() {
  const [busy, setBusy] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const { data: status, refresh } = usePoll<AgentStatus>(api.getStatus, 2000);
  const { data: taskData } = usePoll<{ tasks: TaskRecord[] }>(
    api.listTasks,
    2000
  );

  const tasks = taskData?.tasks ?? [];
  const active = tasks.filter((t) => !TERMINAL_STATUSES.includes(t.status));
  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter(
    (t) => t.status === "failed" || t.status === "cancelled"
  );

  const toggle = async () => {
    setBusy(true);
    try {
      if (status?.running) await api.stopAgent();
      else await api.startAgent();
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      await api.rescanCapabilities(false);
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setRescanning(false);
    }
  };

  const running = status?.running ?? false;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              Agent
              {running ? (
                <Badge variant={status?.online ? "success" : "warning"}>
                  {status?.online ? "online" : "connecting"}
                </Badge>
              ) : (
                <Badge variant="secondary">stopped</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {status?.message ?? "—"}
              {status?.agentId ? ` · ${status.agentId}` : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {running && (
              <Button
                variant="outline"
                onClick={rescan}
                disabled={rescanning}
              >
                {rescanning ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Rescan
              </Button>
            )}
            <Button
              onClick={toggle}
              disabled={busy}
              variant={running ? "destructive" : "default"}
            >
              {running ? <Square /> : <Play />}
              {running ? "Stop" : "Start"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Separator />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Active" value={active.length} accent />
            <Stat label="Completed" value={completed.length} />
            <Stat label="Failed" value={failed.length} />
            <Stat label="Threads" value={status?.maxConcurrent ?? 1} />
          </div>
          <KeepAwakeCard compact />
          {status?.capabilities?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {status.capabilities.map((c) => (
                <Badge key={c} variant="outline">
                  {c}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" /> In progress
          </CardTitle>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <p className="text-muted-foreground text-sm">No active tasks.</p>
          ) : (
            <ul className="space-y-2">
              {active.map((t) => (
                <li key={t.id}>
                  <Link
                    to={`/tasks/${t.id}`}
                    className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
                  >
                    <span className="font-mono">{t.id}</span>
                    <Badge variant="outline">{t.capability}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div
        className={
          accent ? "text-2xl font-semibold text-primary" : "text-2xl font-semibold"
        }
      >
        {value}
      </div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}
