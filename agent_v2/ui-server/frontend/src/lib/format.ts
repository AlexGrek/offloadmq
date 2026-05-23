import type { TaskStatus } from "@/types";

type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning";

export function statusVariant(status: TaskStatus): BadgeVariant {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "default";
    case "failed":
      return "destructive";
    case "cancelled":
      return "warning";
    default:
      return "secondary";
  }
}

export function formatTime(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString();
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function taskDuration(
  startedAt: number | null,
  finishedAt: number | null
): number | null {
  if (startedAt == null) return null;
  const end = finishedAt ?? Date.now() / 1000;
  return end - startedAt;
}
