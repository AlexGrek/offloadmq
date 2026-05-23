import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Ban } from "lucide-react";

import { api } from "@/api/client";
import { usePoll } from "@/hooks/usePoll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDuration, formatTime, statusVariant, taskDuration } from "@/lib/format";
import type { LogEntry, TaskRecord } from "@/types";

const LOG_VARIANT: Record<string, "secondary" | "default" | "warning" | "destructive"> = {
  info: "secondary",
  progress: "default",
  warn: "warning",
  error: "destructive",
};

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const [cancelling, setCancelling] = useState(false);

  const { data: task, error, refresh } = usePoll<TaskRecord>(
    () => api.getTask(taskId!),
    1500,
    [taskId]
  );

  const cancel = async () => {
    if (!taskId) return;
    setCancelling(true);
    try {
      await api.cancelTask(taskId);
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm">
          <Link to="/tasks">
            <ArrowLeft /> Back to tasks
          </Link>
        </Button>
        {task?.status === "running" ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={cancel}
            disabled={cancelling}
          >
            <Ban /> Cancel
          </Button>
        ) : null}
      </div>

      {error ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      ) : !task ? (
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            Loading…
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 font-mono text-sm">
                {task.id}
                <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Field label="Capability" value={task.capability} />
              <Field label="Started" value={formatTime(task.started_at)} />
              <Field label="Finished" value={formatTime(task.finished_at)} />
              <Field
                label="Duration"
                value={formatDuration(
                  taskDuration(task.started_at, task.finished_at)
                )}
              />
            </CardContent>
          </Card>

          {task.error ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base text-destructive">Error</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  {task.error}
                </pre>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Logs ({task.logs.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {task.logs.length === 0 ? (
                <p className="text-muted-foreground text-sm">No log entries.</p>
              ) : (
                task.logs.map((entry, i) => <LogRow key={i} entry={entry} />)
              )}
            </CardContent>
          </Card>

          {task.result?.output &&
          Object.keys(task.result.output).length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Output</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  {JSON.stringify(task.result.output, null, 2)}
                </pre>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const hasData = entry.data && Object.keys(entry.data).length > 0;
  return (
    <div className="flex items-start gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-accent/50">
      <span className="text-muted-foreground tabular-nums">
        {new Date(entry.ts * 1000).toLocaleTimeString()}
      </span>
      <Badge variant={LOG_VARIANT[entry.level] ?? "secondary"}>
        {entry.level}
      </Badge>
      {entry.stage ? (
        <span className="text-muted-foreground font-mono">{entry.stage}</span>
      ) : null}
      <div className="flex-1">
        <span>{entry.message}</span>
        {hasData ? (
          <pre className="text-muted-foreground mt-1 overflow-x-auto">
            {JSON.stringify(entry.data)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
