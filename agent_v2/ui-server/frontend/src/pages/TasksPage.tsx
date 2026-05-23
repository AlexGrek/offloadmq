import { useState } from "react";
import { Link } from "react-router";
import { Ban, Eye } from "lucide-react";

import { api } from "@/api/client";
import { usePoll } from "@/hooks/usePoll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDuration, formatTime, statusVariant, taskDuration } from "@/lib/format";
import type { TaskRecord } from "@/types";
import { TERMINAL_STATUSES } from "@/types";

export function TasksPage() {
  const { data, refresh } = usePoll<{ tasks: TaskRecord[] }>(
    api.listTasks,
    2000
  );
  const [cancelling, setCancelling] = useState<string | null>(null);

  const tasks = [...(data?.tasks ?? [])].sort(
    (a, b) => b.created_at - a.created_at
  );
  const active = tasks.filter((t) => !TERMINAL_STATUSES.includes(t.status));
  const terminal = tasks.filter((t) => TERMINAL_STATUSES.includes(t.status));

  const cancel = async (id: string) => {
    setCancelling(id);
    try {
      await api.cancelTask(id);
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div className="space-y-6">
      <TaskTable
        title={`In progress (${active.length})`}
        tasks={active}
        onCancel={cancel}
        cancelling={cancelling}
      />
      <TaskTable title={`History (${terminal.length})`} tasks={terminal} />
    </div>
  );
}

function TaskTable({
  title,
  tasks,
  onCancel,
  cancelling,
}: {
  title: string;
  tasks: TaskRecord[];
  onCancel?: (id: string) => void;
  cancelling?: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing here yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Capability</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.id}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{t.capability}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatTime(t.started_at)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDuration(taskDuration(t.started_at, t.finished_at))}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button asChild variant="ghost" size="icon">
                        <Link to={`/tasks/${t.id}`}>
                          <Eye />
                        </Link>
                      </Button>
                      {onCancel && t.status === "running" ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={cancelling === t.id}
                          onClick={() => onCancel(t.id)}
                        >
                          <Ban />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
