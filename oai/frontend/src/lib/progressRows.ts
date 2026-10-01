import type { RunningJobItem } from '@/api/progress'
import type { ChatTaskRecord } from '@/contexts/WorkloadContext'

export type ProgressRow = {
  key: string
  label: string
  status: string
  stage?: string | null
  detail?: string
  /** When set, shows a stop control that calls this handler. */
  onCancel?: () => void
  cancelDisabled?: boolean
}

export function chatProgressRows(
  tasks: ChatTaskRecord[],
  onCancelChat?: (task: ChatTaskRecord) => void,
): ProgressRow[] {
  return tasks.map(t => ({
    key: t.reqId,
    label: `Chat ${t.chatId.slice(0, 8)}…`,
    status: t.statusText ?? t.status,
    stage: t.stage,
    detail: t.cap ? `${t.cap} · ${t.id.slice(0, 8)}…` : t.id.slice(0, 8) + '…',
    onCancel: onCancelChat ? () => onCancelChat(t) : undefined,
    cancelDisabled: !t.cap || !t.id,
  }))
}

export function imageProgressRows(
  jobs: RunningJobItem[],
  focusJobId: string | null,
  onCancelImage?: (job: RunningJobItem) => void,
): ProgressRow[] {
  const rows = jobs.map(j => ({
    key: j.key,
    label: j.label,
    status: j.status,
    stage: j.stage,
    detail: focusJobId === j.job_id ? 'current' : undefined,
    onCancel: onCancelImage ? () => onCancelImage(j) : undefined,
    cancelDisabled: !j.offload_cap || !j.offload_task_id,
  }))
  if (focusJobId && !rows.some(r => r.key === `image:${focusJobId}`)) {
    return rows
  }
  if (focusJobId) {
    const focused = rows.filter(r => r.key === `image:${focusJobId}`)
    const rest = rows.filter(r => r.key !== `image:${focusJobId}`)
    return [...focused, ...rest]
  }
  return rows
}

export function describeProgressRows(
  jobs: RunningJobItem[],
  onCancelDescribe?: (job: RunningJobItem) => void,
): ProgressRow[] {
  // Unlike image jobs, describe cancel also works before the OffloadMQ task exists
  // (the backend just marks the row canceled), so it is never disabled.
  return jobs.map(j => ({
    key: j.key,
    label: j.label,
    status: j.status,
    stage: j.stage,
    onCancel: onCancelDescribe ? () => onCancelDescribe(j) : undefined,
  }))
}
