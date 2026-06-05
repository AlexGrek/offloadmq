import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
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

function deriveStreamFromEvents(events: ServerEvent[]): string {
  let content = ''
  for (const e of events) {
    if (e.type === 'task:progress' && e.log?.trim()) content = e.log
    if (e.type === 'task:result') content = e.text.trim() || e.log?.trim() || content
  }
  return content
}

function deriveStatusTextFromEvents(events: ServerEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'task:progress') {
      if (e.log?.trim()) return undefined
      const label = e.stage
        ? e.stage.replace(/_/g, ' ')
        : e.status.replace(/_/g, ' ')
      return label.charAt(0).toUpperCase() + label.slice(1) + '…'
    }
    if (e.type === 'task:queued') return 'Queued…'
  }
  return undefined
}

type WorkloadContextValue = {
  chatTasks: ChatTaskRecord[]
  /** Non-terminal chat tasks across all chats (global Progress). */
  runningChatTasks: ChatTaskRecord[]
  upsertChatTask: (task: Omit<ChatTaskRecord, 'wsEvents' | 'terminal'> & { wsEvents?: ServerEvent[] }) => void
  appendChatWsEvent: (reqId: string, event: ServerEvent) => void
  finishChatTask: (reqId: string, status: string, terminal: boolean) => void
  chatTasksForChat: (chatId: string | null) => ChatTaskRecord[]
  latestChatTaskForChat: (chatId: string | null) => ChatTaskRecord | null
}

const WorkloadContext = createContext<WorkloadContextValue | null>(null)

export function WorkloadProvider({ children }: { children: ReactNode }) {
  const [chatTasks, setChatTasks] = useState<ChatTaskRecord[]>([])

  const upsertChatTask = useCallback(
    (task: Omit<ChatTaskRecord, 'wsEvents' | 'terminal'> & { wsEvents?: ServerEvent[] }) => {
      setChatTasks(prev => {
        const idx = prev.findIndex(t => t.reqId === task.reqId)
        const row: ChatTaskRecord = {
          ...task,
          terminal: false,
          wsEvents: task.wsEvents ?? (idx >= 0 ? prev[idx].wsEvents : []),
        }
        if (idx >= 0) {
          const copy = [...prev]
          copy[idx] = {
            ...copy[idx],
            ...row,
            chatId: copy[idx].chatId || row.chatId,
          }
          return copy
        }
        return [...prev, row]
      })
    },
    [],
  )

  const appendChatWsEvent = useCallback((reqId: string, event: ServerEvent) => {
    setChatTasks(prev =>
      prev.map(t => {
        if (t.reqId !== reqId) return t
        // Cap history: a long stream emits ~1 progress event/s and only the latest
        // log/result matters for derivation — unbounded growth is pure overhead.
        const wsEvents = [...t.wsEvents, event].slice(-50)
        return {
          ...t,
          wsEvents,
          streamContent: deriveStreamFromEvents(wsEvents),
          statusText: deriveStatusTextFromEvents(wsEvents) ?? t.statusText,
          status:
            event.type === 'task:result'
              ? 'completed'
              : event.type === 'task:failed' || event.type === 'error'
                ? 'failed'
                : event.type === 'task:progress'
                  ? event.status
                  : t.status,
          stage: event.type === 'task:progress' ? event.stage : t.stage,
          cap: 'cap' in event && event.cap ? event.cap : t.cap,
          id: 'id' in event && event.id ? event.id : t.id,
        }
      }),
    )
  }, [])

  const finishChatTask = useCallback((reqId: string, status: string, terminal: boolean) => {
    setChatTasks(prev =>
      prev.map(t => (t.reqId === reqId ? { ...t, status, terminal } : t)),
    )
  }, [])

  const runningChatTasks = useMemo(
    () => chatTasks.filter(t => !t.terminal),
    [chatTasks],
  )

  const chatTasksForChat = useCallback(
    (chatId: string | null) => {
      if (!chatId) return []
      return chatTasks.filter(t => t.chatId === chatId && !t.terminal)
    },
    [chatTasks],
  )

  const latestChatTaskForChat = useCallback(
    (chatId: string | null) => {
      const running = chatTasksForChat(chatId)
      if (running.length > 0) return running[running.length - 1]
      if (!chatId) return null
      const done = chatTasks.filter(t => t.chatId === chatId)
      return done.length > 0 ? done[done.length - 1] : null
    },
    [chatTasks, chatTasksForChat],
  )

  const value = useMemo(
    () => ({
      chatTasks,
      runningChatTasks,
      upsertChatTask,
      appendChatWsEvent,
      finishChatTask,
      chatTasksForChat,
      latestChatTaskForChat,
    }),
    [
      chatTasks,
      runningChatTasks,
      upsertChatTask,
      appendChatWsEvent,
      finishChatTask,
      chatTasksForChat,
      latestChatTaskForChat,
    ],
  )

  return <WorkloadContext.Provider value={value}>{children}</WorkloadContext.Provider>
}

export function useWorkload(): WorkloadContextValue {
  const ctx = useContext(WorkloadContext)
  if (!ctx) throw new Error('useWorkload must be used within WorkloadProvider')
  return ctx
}
