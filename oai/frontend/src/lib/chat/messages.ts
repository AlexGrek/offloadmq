import type { ChatMessageRecord } from '@/api/chats'
import type { ChatAttachment } from '@/api/chatAttachments'
import type { ChatTaskRecord } from '@/contexts/WorkloadContext'
import { firstSelectableModel } from '@/lib/modelAvailability'
import type { LlmCapabilityInfo } from '@/types/ws'

// ── Types ─────────────────────────────────────────────────────────────────────

export type MessageStatus = 'complete' | 'thinking' | 'failed'

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  reqId?: string
  statusText?: string
  attachments?: ChatAttachment[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _uid = 1
export function uid() { return `local_${_uid++}` }

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function normalizeStatus(status: string): MessageStatus {
  if (status === 'thinking' || status === 'pending') return 'thinking'
  if (status === 'failed') return 'failed'
  return 'complete'
}

export function recordToMessage(r: ChatMessageRecord): Message | null {
  if (r.role !== 'user' && r.role !== 'assistant') return null
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    status: normalizeStatus(r.status),
    attachments: r.attachments,
  }
}

export function modelListed(
  cap: string | null | undefined,
  capabilities: LlmCapabilityInfo[],
): boolean {
  return !!cap && capabilities.some(c => c.base === cap)
}

/** Prefer chat's saved model, then last message with a model, then first online. */
export function resolveChatModel(
  lastModel: string | null | undefined,
  records: ChatMessageRecord[],
  capabilities: LlmCapabilityInfo[],
): string | null {
  if (modelListed(lastModel, capabilities)) return lastModel!
  for (let i = records.length - 1; i >= 0; i--) {
    const m = records[i].model
    if (modelListed(m, capabilities)) return m!
  }
  return firstSelectableModel(capabilities)
}

export function isMessagePending(msg: Message): boolean {
  return msg.role === 'assistant' && msg.status === 'thinking'
}

export function pendingMessageId(reqId: string): string {
  return `pending_${reqId}`
}

function inFlightToMessage(task: ChatTaskRecord): Message {
  const streaming = Boolean(task.streamContent?.trim())
  return {
    id: pendingMessageId(task.reqId),
    role: 'assistant',
    content: task.streamContent ?? '',
    status: 'thinking',
    reqId: task.reqId,
    statusText: streaming ? '' : (task.statusText ?? 'Thinking…'),
  }
}

export function mergeInFlightMessages(base: Message[], running: ChatTaskRecord[]): Message[] {
  const runningReqIds = new Set(running.map(t => t.reqId))
  const hasRunning = running.length > 0
  const next = base.filter(m => {
    if (m.status !== 'thinking') return true
    // Optimistic bubbles carry a reqId: keep only while their task is running.
    if (m.reqId != null) return runningReqIds.has(m.reqId)
    // REST-backed pending replies (no reqId) are real DB rows the background
    // worker will finalize — keep them on reload so the in-flight reply survives a
    // disconnect/restart, but drop when a live optimistic bubble already covers it.
    return !hasRunning
  })
  for (const task of running) {
    const row = inFlightToMessage(task)
    const idx = next.findIndex(m => m.reqId === task.reqId)
    if (idx >= 0) next[idx] = row
    else next.push(row)
  }
  return next
}
