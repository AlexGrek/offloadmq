import { createContext, useContext } from 'react'
import type { ServerEvent } from '../types/ws'

export type ChatTaskRecord = {
  reqId: string
  chatId: string
  cap: string
  id: string
  status: string
  stage?: string
  statusText?: string
  /** Latest streamed assistant text from task:progress / task:result */
  streamContent?: string
  terminal: boolean
  wsEvents: ServerEvent[]
}

export type WorkloadContextValue = {
  chatTasks: ChatTaskRecord[]
  /** Non-terminal chat tasks across all chats (global Progress). */
  runningChatTasks: ChatTaskRecord[]
  upsertChatTask: (task: Omit<ChatTaskRecord, 'wsEvents' | 'terminal'> & { wsEvents?: ServerEvent[] }) => void
  appendChatWsEvent: (reqId: string, event: ServerEvent) => void
  finishChatTask: (reqId: string, status: string, terminal: boolean) => void
  chatTasksForChat: (chatId: string | null) => ChatTaskRecord[]
  latestChatTaskForChat: (chatId: string | null) => ChatTaskRecord | null
}

export const WorkloadContext = createContext<WorkloadContextValue | null>(null)

export function useWorkload(): WorkloadContextValue {
  const ctx = useContext(WorkloadContext)
  if (!ctx) throw new Error('useWorkload must be used within WorkloadProvider')
  return ctx
}
