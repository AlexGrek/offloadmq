import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  Loader2,
  Square,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '../contexts/AuthContext'
import { useWorkload } from '../contexts/WorkloadContext'
import {
  ToolDebugHeaderButton,
  ToolDebugModal,
  toolDebugReady,
} from '../components/ToolDebugModal'
import { cancelOffloadTask } from '../api/tasks'
import { useWsChat, nextReqId } from '../hooks/useWsChat'
import {
  firstSelectableModel,
  sortCapabilitiesForPicker,
  unavailableModelDotOpacity,
} from '../lib/modelAvailability'
import type { LlmCapabilityInfo, ServerEvent } from '../types/ws'
import type { ChatTaskRecord } from '../contexts/WorkloadContext'
import {
  listChats,
  createChat,
  deleteChat,
  getChatMessages,
  updateChatSystemPrompt,
  updateChatLastModel,
  type ChatSummary,
  type ChatMessageRecord,
} from '../api/chats'
import { MarkdownContent } from '../components/MarkdownContent'
import { SystemPromptBlock } from '../components/chat/SystemPromptBlock'
import { SystemPromptStudio, DEFAULT_PROMPT } from '../components/chat/SystemPromptStudio'

// ── Types ─────────────────────────────────────────────────────────────────────

type MessageStatus = 'complete' | 'thinking' | 'failed'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  reqId?: string
  statusText?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _uid = 1
function uid() { return `local_${_uid++}` }

function modelLabel(cap: LlmCapabilityInfo): string {
  return cap.base.replace(/^llm\./, '')
}

function ModelAvailabilityDot({ cap }: { cap: LlmCapabilityInfo }) {
  if (cap.online) {
    return (
      <span
        className="size-2 shrink-0 rounded-full bg-emerald-500"
        aria-hidden
        data-testid="model-dot-online"
      />
    )
  }
  const opacity = unavailableModelDotOpacity(cap.last_available_at)
  return (
    <span
      className="size-2 shrink-0 rounded-full bg-amber-400"
      style={{ opacity }}
      aria-hidden
      data-testid="model-dot-offline"
    />
  )
}

function normalizeStatus(status: string): MessageStatus {
  if (status === 'thinking' || status === 'pending') return 'thinking'
  if (status === 'failed') return 'failed'
  return 'complete'
}

function recordToMessage(r: ChatMessageRecord): Message | null {
  if (r.role !== 'user' && r.role !== 'assistant') return null
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    status: normalizeStatus(r.status),
  }
}

function modelListed(
  cap: string | null | undefined,
  capabilities: LlmCapabilityInfo[],
): boolean {
  return !!cap && capabilities.some(c => c.base === cap)
}

/** Prefer chat's saved model, then last message with a model, then first online. */
function resolveChatModel(
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

function isMessagePending(msg: Message): boolean {
  return msg.role === 'assistant' && msg.status === 'thinking'
}

function pendingMessageId(reqId: string): string {
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

function mergeInFlightMessages(base: Message[], running: ChatTaskRecord[]): Message[] {
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

// ── Status indicator ──────────────────────────────────────────────────────────

function WsStatusDot({ status }: { status: string }) {
  if (status === 'connected') return <Wifi className="size-3.5 text-emerald-500" />
  if (status === 'connecting') return <Loader2 className="size-3.5 text-amber-500 animate-spin" />
  return <WifiOff className="size-3.5 text-muted-foreground" />
}

// ── Model picker ──────────────────────────────────────────────────────────────

function ModelPicker({
  capabilities,
  selected,
  onSelect,
  onRefresh,
  wsStatus,
}: {
  capabilities: LlmCapabilityInfo[]
  selected: string | null
  onSelect: (base: string) => void
  onRefresh: () => void
  wsStatus: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const sorted = sortCapabilitiesForPicker(capabilities)
  const selectedCap = sorted.find(c => c.base === selected)
  const label =
    wsStatus === 'connecting' ? 'Connecting…' :
    wsStatus !== 'connected'  ? 'Offline' :
    sorted.length === 0 ? 'No models' :
    selectedCap               ? modelLabel(selectedCap) :
                                'Pick model'

  const canOpen = wsStatus === 'connected' && sorted.length > 0

  return (
    <div className="relative" ref={ref} data-testid="model-picker">
      <button
        type="button"
        onClick={() => canOpen && setOpen(v => !v)}
        disabled={!canOpen}
        data-testid="model-picker-trigger"
        className={cn(
          'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
          canOpen
            ? 'text-foreground hover:bg-muted cursor-pointer'
            : 'text-muted-foreground cursor-default',
        )}
      >
        {selectedCap && <ModelAvailabilityDot cap={selectedCap} />}
        <span className="max-w-30 truncate">{label}</span>
        {canOpen && <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />}
      </button>

      <AnimatePresence>
      {open && (
        <motion.div
          className="absolute bottom-full mb-1 left-0 z-50 min-w-45 overflow-hidden rounded-xl border border-border bg-popover shadow-md text-sm"
          data-testid="model-picker-dropdown"
          initial={{ opacity: 0, y: 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.96 }}
          transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            <span>Models</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRefresh() }}
              title="Refresh"
              className="hover:text-foreground transition-colors"
            >
              <RefreshCw className="size-3" />
            </button>
          </div>
          <div
            className="max-h-[min(50vh,16rem)] overflow-y-auto overscroll-contain py-1"
            data-testid="model-picker-list"
          >
            {sorted.map(cap => (
              <button
                key={cap.raw}
                type="button"
                disabled={!cap.online}
                onClick={() => { if (cap.online) { onSelect(cap.base); setOpen(false) } }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors',
                  cap.online ? 'hover:bg-muted cursor-pointer' : 'cursor-default opacity-80',
                  cap.base === selected && 'bg-muted font-medium',
                )}
                data-testid={`model-option-${cap.base}`}
              >
                <ModelAvailabilityDot cap={cap} />
                <span className="flex-1 truncate">{modelLabel(cap)}</span>
                {cap.tags.length > 0 && (
                  <span className="flex gap-1 shrink-0">
                    {cap.tags.map(t => (
                      <span
                        key={t}
                        className="rounded px-1 py-0.5 text-[10px] font-medium bg-accent text-accent-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  )
}

// ── Thinking bubble ───────────────────────────────────────────────────────────

function ThinkingBubble({ statusText, content }: { statusText?: string; content?: string }) {
  const streaming = Boolean(content?.trim())
  return (
    <div
      className="max-w-[80%] rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm"
      data-testid="message-pending"
      aria-busy="true"
      aria-live="polite"
    >
      {streaming ? (
        <div className="mb-3" data-testid="message-streaming">
          <MarkdownContent>{content!}</MarkdownContent>
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="flex items-center gap-0.75" aria-hidden>
          {[0, 1, 2].map(i => (
            <motion.span
              key={i}
              className="block size-1.5 rounded-full bg-current"
              animate={{ y: [0, -3, 0] }}
              transition={{ duration: 0.55, repeat: Infinity, delay: i * 0.14, ease: 'easeInOut' }}
            />
          ))}
        </span>
        {!streaming && <span>{statusText || 'Thinking…'}</span>}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ChatPage() {
  const { token } = useAuth()
  const {
    chatTasks,
    upsertChatTask,
    appendChatWsEvent,
    finishChatTask,
    chatTasksForChat,
    latestChatTaskForChat,
    runningChatTasks,
  } = useWorkload()

  const inProgressByChatId = useMemo(() => {
    const map = new Map<string, ChatTaskRecord>()
    for (const t of runningChatTasks) {
      map.set(t.chatId, t)
    }
    return map
  }, [runningChatTasks])
  const ws = useWsChat(token)

  const [chats, setChats] = useState<ChatSummary[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const activeChatIdRef = useRef<string | null>(null)
  const chatTasksRef = useRef(chatTasks)
  activeChatIdRef.current = activeChatId
  chatTasksRef.current = chatTasks
  const [messages, setMessages] = useState<Message[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [input, setInput] = useState('')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [loadingChats, setLoadingChats] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT)
  const [debugOpen, setDebugOpen] = useState(false)

  useEffect(() => {
    setDebugOpen(false)
  }, [activeChatId])

  // reqId → assistant message id in the current messages list
  const reqToMsgId = useRef<Map<string, string>>(new Map())

  function restoreReqMappings(msgs: Message[]) {
    reqToMsgId.current.clear()
    for (const m of msgs) {
      if (m.reqId) reqToMsgId.current.set(m.reqId, m.id)
    }
  }

  // ── Load chats on mount ───────────────────────────────────────────────────

  useEffect(() => {
    if (!token) return
    setLoadingChats(true)
    listChats(token)
      .then(setChats)
      .catch(console.error)
      .finally(() => setLoadingChats(false))
  }, [token])

  // ── Load messages when active chat changes ────────────────────────────────

  useEffect(() => {
    if (!activeChatId || !token) {
      setMessages([])
      return
    }
    let cancelled = false
    setLoadingMessages(true)
    getChatMessages(token, activeChatId)
      .then(records => {
        if (cancelled) return
        const running = chatTasksRef.current.filter(
          t => t.chatId === activeChatId && !t.terminal,
        )
        const merged = mergeInFlightMessages(
          records.map(recordToMessage).filter((m): m is Message => m != null),
          running,
        )
        setMessages(merged)
        restoreReqMappings(merged)
        const chat = chats.find(c => c.id === activeChatId)
        const model = resolveChatModel(chat?.last_model, records, ws.capabilities)
        if (model) setSelectedModel(model)
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoadingMessages(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeChatId, token, chats, ws.capabilities])

  // Apply saved model immediately when switching chats (before messages finish loading).
  useEffect(() => {
    if (!activeChatId || ws.capabilities.length === 0) return
    const chat = chats.find(c => c.id === activeChatId)
    const model = resolveChatModel(chat?.last_model, [], ws.capabilities)
    if (model) setSelectedModel(model)
  }, [activeChatId, chats, ws.capabilities])

  // Patch in-flight assistant rows while this chat is open (progress survives tab/chat switches).
  useEffect(() => {
    if (!activeChatId || loadingMessages) return
    const running = chatTasksForChat(activeChatId)
    setMessages(prev => {
      const merged = mergeInFlightMessages(prev, running)
      restoreReqMappings(merged)
      return merged
    })
  }, [chatTasks, activeChatId, loadingMessages, chatTasksForChat])

  const activeChat = chats.find(c => c.id === activeChatId)

  // A persisted (REST-backed) assistant reply still in flight: no live WS task
  // owns it (reqId == null), so the background worker is finishing it. Poll the
  // transcript until it resolves — this is the "came back later" / post-restart path.
  const hasRestPendingReply = messages.some(m => m.status === 'thinking' && m.reqId == null)
  useEffect(() => {
    if (!activeChatId || !token || !hasRestPendingReply) return
    const interval = setInterval(() => refreshChatMessages(activeChatId), 2500)
    return () => clearInterval(interval)
  }, [activeChatId, token, hasRestPendingReply]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeChat) {
      setSystemPrompt(activeChat.system_prompt?.trim() || DEFAULT_PROMPT)
    }
  }, [activeChatId, activeChat?.system_prompt])

  const applySystemPrompt = useCallback(
    async (content: string) => {
      if (!token) return
      const text = content.trim() || DEFAULT_PROMPT
      if (!activeChatId) {
        const chat = await createChat(token, {
          systemPrompt: text,
          lastModel: selectedModel,
        })
        setChats(prev => [chat, ...prev])
        setActiveChatId(chat.id)
        setSystemPrompt(chat.system_prompt)
        if (chat.last_model) setSelectedModel(chat.last_model)
        return
      }
      const chat = await updateChatSystemPrompt(token, activeChatId, text)
      setSystemPrompt(chat.system_prompt)
      setChats(prev => prev.map(c => (c.id === chat.id ? chat : c)))
    },
    [token, activeChatId, selectedModel],
  )

  const handleModelSelect = useCallback(
    (model: string) => {
      if (!modelListed(model, ws.capabilities)) return
      setSelectedModel(model)
      if (!token || !activeChatId) return
      updateChatLastModel(token, activeChatId, model)
        .then(chat => setChats(prev => prev.map(c => (c.id === chat.id ? chat : c))))
        .catch(console.error)
    },
    [token, activeChatId, ws.capabilities],
  )

  // If capabilities refresh and current selection vanished, re-resolve for this chat.
  useEffect(() => {
    if (ws.capabilities.length === 0 || !activeChatId) return
    if (modelListed(selectedModel, ws.capabilities)) return
    const chat = chats.find(c => c.id === activeChatId)
    const model = resolveChatModel(chat?.last_model, [], ws.capabilities)
    if (model) setSelectedModel(model)
  }, [ws.capabilities, activeChatId, chats, selectedModel])

  // ── Subscribe to WS events ────────────────────────────────────────────────

  useEffect(() => {
    return ws.subscribe((event: ServerEvent) => {
      const reqId = 'req_id' in event ? event.req_id : undefined
      if (reqId) appendChatWsEvent(reqId, event)

      const task = reqId
        ? chatTasksRef.current.find(t => t.reqId === reqId)
        : undefined
      const chatId = task?.chatId
      const onActiveChat = chatId != null && chatId === activeChatIdRef.current

      switch (event.type) {
        case 'task:queued':
          if (chatId) {
            upsertChatTask({
              reqId: event.req_id,
              chatId,
              cap: event.cap,
              id: event.id,
              status: 'queued',
              statusText: 'Queued…',
            })
          }
          if (onActiveChat) updateThinking(event.req_id, 'Queued…')
          break
        case 'task:progress': {
          const label =
            event.stage ? capitalize(event.stage.replace(/_/g, ' ')) :
            capitalize(event.status.replace(/_/g, ' '))
          if (chatId) {
            upsertChatTask({
              reqId: event.req_id,
              chatId,
              cap: event.cap,
              id: event.id,
              status: event.status,
              stage: event.stage,
              statusText: event.log?.trim() ? undefined : label + '…',
              streamContent: event.log?.trim() || task?.streamContent,
            })
          }
          if (onActiveChat) {
            updateThinking(event.req_id, event.log?.trim() ? '' : label + '…')
            if (event.log?.trim()) updateThinkingContent(event.req_id, event.log)
          }
          break
        }
        case 'task:result': {
          const text = event.text.trim() || event.log?.trim() || ''
          if (onActiveChat) resolveThinking(event.req_id, text, 'complete')
          else if (chatId && token) {
            refreshChatMessages(chatId)
          }
          finishChatTask(event.req_id, 'completed', true)
          break
        }
        case 'task:failed':
          if (onActiveChat) resolveThinking(event.req_id, `⚠ ${event.error}`, 'failed')
          else if (chatId && token) refreshChatMessages(chatId)
          finishChatTask(event.req_id, 'failed', true)
          break
        case 'error':
          if (event.req_id) {
            if (onActiveChat) resolveThinking(event.req_id, `⚠ ${event.message}`, 'failed')
            else if (chatId && token) refreshChatMessages(chatId)
            finishChatTask(event.req_id, 'failed', true)
          }
          break
      }
    })
  }, [ws.subscribe, token, upsertChatTask, appendChatWsEvent, finishChatTask]) // eslint-disable-line react-hooks/exhaustive-deps

  const debugTask = latestChatTaskForChat(activeChatId)

  function findMessageIndex(prev: Message[], reqId: string, msgId: string): number {
    const byId = prev.findIndex(m => m.id === msgId)
    if (byId >= 0) return byId
    return prev.findIndex(m => m.reqId === reqId)
  }

  function updateThinking(reqId: string, statusText: string) {
    const msgId = reqToMsgId.current.get(reqId) ?? pendingMessageId(reqId)
    setMessages(prev => {
      const idx = findMessageIndex(prev, reqId, msgId)
      if (idx < 0) return prev
      return prev.map((m, i) => (i === idx ? { ...m, statusText } : m))
    })
  }

  function updateThinkingContent(reqId: string, content: string) {
    const msgId = reqToMsgId.current.get(reqId) ?? pendingMessageId(reqId)
    setMessages(prev => {
      const idx = findMessageIndex(prev, reqId, msgId)
      if (idx < 0) return prev
      return prev.map((m, i) => (i === idx ? { ...m, content } : m))
    })
  }

  function resolveThinking(reqId: string, content: string, status: MessageStatus) {
    const msgId = reqToMsgId.current.get(reqId) ?? pendingMessageId(reqId)
    reqToMsgId.current.delete(reqId)
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === msgId || m.reqId === reqId)
      if (idx < 0) {
        return [
          ...prev,
          {
            id: uid(),
            role: 'assistant' as const,
            content,
            status,
          },
        ]
      }
      return prev.map((m, i) =>
        i === idx ? { ...m, content, status, statusText: undefined, reqId: undefined } : m,
      )
    })
  }

  function refreshChatMessages(chatId: string) {
    if (!token) return
    getChatMessages(token, chatId)
      .then(records => {
        if (activeChatIdRef.current !== chatId) return
        const merged = mergeInFlightMessages(
          records.map(recordToMessage).filter((m): m is Message => m != null),
          chatTasksForChat(chatId),
        )
        setMessages(merged)
        restoreReqMappings(merged)
      })
      .catch(console.error)
  }

  const showSystemStudio = !loadingMessages && (!activeChatId || messages.length === 0)

  // ── Scroll ────────────────────────────────────────────────────────────────

  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  /** When true, new content keeps the transcript pinned to the bottom. */
  const autoScrollRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  /** Ignore onScroll while we programmatically pin (DOM swaps reset scrollTop → false "scroll up"). */
  const suppressScrollHandlerRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const BOTTOM_THRESHOLD_PX = 48

  const isStreaming = useMemo(
    () => messages.some(m => isMessagePending(m)),
    [messages],
  )

  function distanceFromBottom(el: HTMLDivElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }

  function handleScroll() {
    if (suppressScrollHandlerRef.current) return
    const el = scrollRef.current
    if (!el) return
    const { scrollTop } = el
    const dist = distanceFromBottom(el)

    // Any upward scroll disables follow; reaching the end re-enables it.
    if (scrollTop < lastScrollTopRef.current - 1) {
      autoScrollRef.current = false
    } else if (dist <= BOTTOM_THRESHOLD_PX) {
      autoScrollRef.current = true
    }

    lastScrollTopRef.current = scrollTop
    setShowScrollBtn(!autoScrollRef.current)
  }

  function maxScrollTop(el: HTMLDivElement): number {
    return Math.max(0, el.scrollHeight - el.clientHeight)
  }

  /** Pin transcript to the bottom sentinel (inside the scroll container only). */
  function scrollTranscriptToEnd(behavior: ScrollBehavior = 'instant') {
    const el = scrollRef.current
    const end = messagesEndRef.current
    if (end) {
      end.scrollIntoView({ block: 'end', behavior })
    } else if (el) {
      const top = maxScrollTop(el)
      el.scrollTop = top
    }
    if (el) lastScrollTopRef.current = el.scrollTop
  }

  function followTranscriptBottom(behavior: ScrollBehavior = 'instant') {
    if (!autoScrollRef.current) return
    suppressScrollHandlerRef.current = true
    scrollTranscriptToEnd(behavior)
    requestAnimationFrame(() => {
      scrollTranscriptToEnd('instant')
      const el = scrollRef.current
      if (el) lastScrollTopRef.current = el.scrollTop
      setShowScrollBtn(false)
      requestAnimationFrame(() => {
        suppressScrollHandlerRef.current = false
      })
    })
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = 'smooth') {
    autoScrollRef.current = true
    suppressScrollHandlerRef.current = true
    scrollTranscriptToEnd(behavior)
    const el = scrollRef.current
    if (el) lastScrollTopRef.current = el.scrollTop
    setShowScrollBtn(false)
    requestAnimationFrame(() => {
      suppressScrollHandlerRef.current = false
    })
  }

  useLayoutEffect(() => {
    if (showSystemStudio || loadingMessages) return
    followTranscriptBottom('instant')
  }, [messages, isStreaming, showSystemStudio, loadingMessages])

  useEffect(() => {
    autoScrollRef.current = true
    setShowScrollBtn(false)
    requestAnimationFrame(() => followTranscriptBottom('instant'))
  }, [activeChatId])

  // ── Textarea auto-resize ──────────────────────────────────────────────────

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [input])

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleNewChat() {
    if (!token) return
    try {
      const chat = await createChat(token, {
        systemPrompt,
        lastModel: selectedModel,
      })
      setChats(prev => [chat, ...prev])
      setActiveChatId(chat.id)
      setMessages([])
      setInput('')
    } catch (e) {
      console.error('failed to create chat', e)
    }
  }

  async function handleDeleteChat(e: React.MouseEvent, chatId: string) {
    e.stopPropagation()
    if (!token) return
    const title = chats.find(c => c.id === chatId)?.title || 'New chat'
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return
    try {
      await deleteChat(token, chatId)
      setChats(prev => prev.filter(c => c.id !== chatId))
      if (activeChatId === chatId) {
        setActiveChatId(null)
        setMessages([])
      }
    } catch (e) {
      console.error('failed to delete chat', e)
    }
  }

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || !selectedModel || ws.status !== 'connected' || !activeChatId) return
    if (!modelListed(selectedModel, ws.capabilities)) return

    const reqId = nextReqId('chat')
    const assistantMsgId = uid()

    const userMsg: Message = { id: uid(), role: 'user', content: text, status: 'complete' }
    const thinkingMsg: Message = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      status: 'thinking',
      reqId,
      statusText: 'Sending…',
    }

    autoScrollRef.current = true
    suppressScrollHandlerRef.current = true
    setMessages(prev => [...prev, userMsg, thinkingMsg])
    setInput('')
    setShowScrollBtn(false)
    reqToMsgId.current.set(reqId, assistantMsgId)

    upsertChatTask({
      reqId,
      chatId: activeChatId,
      cap: '',
      id: '',
      status: 'sending',
      statusText: 'Sending…',
    })

    // Update sidebar title optimistically after first message
    setChats(prev =>
      prev.map(c =>
        c.id === activeChatId
          ? {
              ...c,
              ...(c.title === '' ? { title: text.slice(0, 50) } : {}),
              last_model: selectedModel,
            }
          : c,
      ),
    )

    ws.send({ type: 'chat', req_id: reqId, capability: selectedModel, chat_id: activeChatId, content: text })
  }, [input, selectedModel, ws, activeChatId, upsertChatTask])

  function scrollToBottom() {
    scrollMessagesToBottom('smooth')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const selectedModelOnline =
    !!selectedModel &&
    (ws.capabilities.find(c => c.base === selectedModel)?.online ?? false)
  const canSend =
    !!input.trim() && selectedModelOnline && ws.status === 'connected' && !!activeChatId

  const activeChatTask = latestChatTaskForChat(activeChatId)
  const isGenerating =
    (activeChatTask != null && !activeChatTask.terminal) ||
    messages.some(m => isMessagePending(m))
  const canCancelTask = !!(activeChatTask?.cap && activeChatTask?.id)

  const handleCancel = useCallback(async () => {
    if (!token || !activeChatTask?.cap || !activeChatTask.id) return
    const { reqId, cap, id } = activeChatTask
    try {
      await cancelOffloadTask(token, cap, id)
      if (activeChatIdRef.current === activeChatTask.chatId) {
        resolveThinking(reqId, '⚠ Task was canceled', 'failed')
      }
      finishChatTask(reqId, 'canceled', true)
    } catch (e) {
      console.error('cancel chat task', e)
    }
  }, [token, activeChatTask, finishChatTask])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="chat-page"
    >
      {/* ── Sidebar: fixed header + independently scrollable chat list ── */}
      <aside
        className={cn(
          'flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar',
          'transition-[width] duration-200',
          sidebarOpen ? 'w-64' : 'w-0',
        )}
        data-testid="chat-sidebar"
      >
        <div className="flex items-center justify-between px-3 h-11 border-b border-border shrink-0">
          <span className="text-sm font-semibold text-sidebar-foreground">Chats</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleNewChat}
            title="New chat"
            data-testid="new-chat-btn"
          >
            <Pencil />
          </Button>
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 px-1"
          data-testid="chat-sidebar-list"
        >
          {loadingChats ? (
            <div className="flex justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : chats.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4 px-3">
              No chats yet
            </p>
          ) : (
            chats.map(chat => {
              const inProgress = inProgressByChatId.has(chat.id)
              return (
                <div
                  key={chat.id}
                  className={cn(
                    'group/chat-item flex items-center rounded-lg transition-colors',
                    chat.id === activeChatId
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'hover:bg-sidebar-accent/50 text-sidebar-foreground',
                  )}
                  data-in-progress={inProgress || undefined}
                >
                  <button
                    type="button"
                    onClick={() => setActiveChatId(chat.id)}
                    data-testid={`chat-item-${chat.id}`}
                    aria-busy={inProgress}
                    className="flex flex-1 items-center gap-2 min-w-0 px-3 py-2 text-left"
                  >
                    {inProgress ? (
                      <Loader2
                        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                        aria-hidden
                        data-testid={`chat-item-${chat.id}-loader`}
                      />
                    ) : null}
                    <span className="truncate text-sm leading-tight min-w-0 flex-1">
                      {chat.title || 'New chat'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleDeleteChat(e, chat.id)}
                    title="Delete chat"
                    aria-label={`Delete chat ${chat.title || 'New chat'}`}
                    data-testid={`delete-chat-${chat.id}`}
                    className={cn(
                      'shrink-0 mr-1 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all',
                      chat.id === activeChatId
                        ? 'opacity-100 text-muted-foreground'
                        : 'opacity-0 group-hover/chat-item:opacity-100',
                    )}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* ── Main: header + scrollable transcript + fixed input ── */}
      <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden">
        {/* topbar */}
        <header className="flex items-center gap-2 px-3 h-11 border-b border-border shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarOpen(v => !v)}
            title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <span className="text-sm font-medium text-muted-foreground truncate">
            {activeChat?.title || (activeChatId ? 'New chat' : 'Select a chat')}
          </span>
          <span className="flex-1" />
          {activeChatId && (
            <ToolDebugHeaderButton
              onClick={() => setDebugOpen(true)}
              active={toolDebugReady(debugTask?.cap, debugTask?.id)}
            />
          )}
          <WsStatusDot status={ws.status} />
        </header>

        <ToolDebugModal
          open={debugOpen}
          onOpenChange={setDebugOpen}
          cap={debugTask?.cap}
          taskId={debugTask?.id}
          subject={activeChat?.title || 'New chat'}
          disabledReason={
            debugTask ? undefined : 'Send a message to capture OffloadMQ task ids.'
          }
        />

        {/* messages — only this region scrolls */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onWheel={e => {
            if (e.deltaY < 0) autoScrollRef.current = false
          }}
          className="relative min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain"
          data-testid="messages-area"
        >
          {!token ? null : showSystemStudio ? (
            <div className="flex flex-col items-center px-4 py-8">
              <SystemPromptStudio
                token={token}
                value={systemPrompt}
                onChange={setSystemPrompt}
                onApply={applySystemPrompt}
                compact={!!activeChatId}
              />
              {activeChatId && (
                <p className="mt-6 max-w-md text-center text-xs text-muted-foreground">
                  Send your first message below — the model will follow this system prompt.
                </p>
              )}
              {!activeChatId && (
                <Button variant="outline" size="sm" className="mt-4" onClick={() => void handleNewChat()}>
                  <Pencil className="mr-1.5 size-3.5" />
                  New chat with this prompt
                </Button>
              )}
              <div ref={messagesEndRef} className="h-px shrink-0" aria-hidden />
            </div>
          ) : loadingMessages ? (
            <div className="flex min-h-[50vh] items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
              <SystemPromptBlock content={systemPrompt} />
              {messages.map(msg => (
                <motion.div
                  key={msg.id}
                  className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}
                  data-testid={`message-${msg.id}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                >
                  {isMessagePending(msg) ? (
                    <ThinkingBubble statusText={msg.statusText} content={msg.content} />
                  ) : (
                    <div
                      className={cn(
                        'max-w-[80%] rounded-2xl px-4 py-2.5',
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground rounded-br-sm'
                          : msg.status === 'failed'
                            ? 'bg-destructive/10 text-destructive rounded-bl-sm'
                            : 'bg-muted text-foreground rounded-bl-sm',
                      )}
                    >
                      <MarkdownContent
                        tone={msg.role === 'user' ? 'inverted' : 'default'}
                        className={msg.status === 'failed' ? 'text-destructive' : undefined}
                      >
                        {msg.content}
                      </MarkdownContent>
                    </div>
                  )}
                </motion.div>
              ))}
              <div ref={messagesEndRef} className="h-px shrink-0" aria-hidden />
            </div>
          )}

          {showScrollBtn && (
            <div className="sticky bottom-4 flex justify-center pointer-events-none">
              <Button
                size="icon-sm"
                variant="outline"
                onClick={scrollToBottom}
                title="Scroll to bottom"
                className="pointer-events-auto shadow-md"
              >
                <ArrowUp className="rotate-180" />
              </Button>
            </div>
          )}
        </div>

        {/* ── Input — pinned below transcript ── */}
        <div className="shrink-0 border-t border-border bg-background px-4 pb-4 pt-2">
          <div className="max-w-2xl mx-auto">
            <div
              className="group/input-group rounded-2xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
              data-testid="chat-input-box"
            >
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  !activeChatId ? 'Select or create a chat first' :
                  ws.status === 'connected' ? 'Message…' : 'Connecting…'
                }
                disabled={ws.status !== 'connected' || !activeChatId}
                rows={1}
                data-testid="chat-input"
                className="block w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
                style={{ minHeight: '44px', maxHeight: '200px' }}
              />

              <div className="flex items-center gap-2 px-2 pb-2">
                <Button
                  variant="outline"
                  size="icon-xs"
                  title="Attach"
                  className="rounded-full shrink-0"
                  disabled
                >
                  <Plus />
                </Button>

                <ModelPicker
                  capabilities={ws.capabilities}
                  selected={selectedModel}
                  onSelect={handleModelSelect}
                  onRefresh={ws.refreshCapabilities}
                  wsStatus={ws.status}
                />

                <span className="flex-1" />

                {isGenerating ? (
                  <motion.button
                    type="button"
                    onClick={() => void handleCancel()}
                    disabled={!canCancelTask}
                    aria-label="Cancel"
                    data-testid="chat-cancel-btn"
                    title={canCancelTask ? 'Cancel response' : 'Waiting for task id…'}
                    whileTap={canCancelTask ? { scale: 0.85 } : undefined}
                    className={cn(
                      'size-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                      canCancelTask
                        ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                        : 'bg-muted text-muted-foreground cursor-not-allowed',
                    )}
                  >
                    <Square className="size-3.5 fill-current" />
                  </motion.button>
                ) : (
                  <motion.button
                    onClick={send}
                    disabled={!canSend}
                    aria-label="Send"
                    data-testid="send-btn"
                    whileTap={canSend ? { scale: 0.85 } : undefined}
                    className={cn(
                      'size-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                      canSend
                        ? 'bg-foreground text-background hover:bg-foreground/80'
                        : 'bg-muted text-muted-foreground cursor-not-allowed',
                    )}
                  >
                    <ArrowUp className="size-4" />
                  </motion.button>
                )}
              </div>
            </div>

            <p className="text-center text-xs text-muted-foreground mt-2 select-none">
              Shift+Enter for new line · Enter to send
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
