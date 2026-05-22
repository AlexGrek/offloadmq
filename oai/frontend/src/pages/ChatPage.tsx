import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  Loader2,
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
import { useWsChat, nextReqId } from '../hooks/useWsChat'
import type { LlmCapabilityInfo, ServerEvent } from '../types/ws'
import {
  listChats,
  createChat,
  deleteChat,
  getChatMessages,
  type ChatSummary,
  type ChatMessageRecord,
} from '../api/chats'

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

function recordToMessage(r: ChatMessageRecord): Message {
  return {
    id: r.id,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    status: r.status as MessageStatus,
  }
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

  const selectedCap = capabilities.find(c => c.base === selected)
  const label =
    wsStatus === 'connecting' ? 'Connecting…' :
    wsStatus !== 'connected'  ? 'Offline' :
    capabilities.length === 0 ? 'No models' :
    selectedCap               ? modelLabel(selectedCap) :
                                'Pick model'

  const canOpen = wsStatus === 'connected' && capabilities.length > 0

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
        <span className="max-w-30 truncate">{label}</span>
        {canOpen && <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />}
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-1 left-0 z-50 min-w-45 rounded-xl border border-border bg-popover shadow-md py-1 text-sm"
          data-testid="model-picker-dropdown"
        >
          <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground border-b border-border mb-1">
            <span>Available models</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRefresh() }}
              title="Refresh"
              className="hover:text-foreground transition-colors"
            >
              <RefreshCw className="size-3" />
            </button>
          </div>
          {capabilities.map(cap => (
            <button
              key={cap.raw}
              type="button"
              onClick={() => { onSelect(cap.base); setOpen(false) }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted transition-colors',
                cap.base === selected && 'bg-muted font-medium',
              )}
            >
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
      )}
    </div>
  )
}

// ── Thinking bubble ───────────────────────────────────────────────────────────

function ThinkingBubble({ statusText }: { statusText?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span>{statusText || 'Thinking…'}</span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ChatPage() {
  const { token } = useAuth()
  const ws = useWsChat(token)

  const [chats, setChats] = useState<ChatSummary[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [input, setInput] = useState('')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [loadingChats, setLoadingChats] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)

  // reqId → optimistic assistant message id
  const reqToMsgId = useRef<Map<string, string>>(new Map())

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
    setLoadingMessages(true)
    getChatMessages(token, activeChatId)
      .then(records => setMessages(records.map(recordToMessage)))
      .catch(console.error)
      .finally(() => setLoadingMessages(false))
  }, [activeChatId, token])

  // ── Auto-select first model; re-validate on capability list change ────────

  useEffect(() => {
    if (ws.capabilities.length === 0) return
    const valid = ws.capabilities.some(c => c.base === selectedModel)
    if (!valid) setSelectedModel(ws.capabilities[0].base)
  }, [ws.capabilities, selectedModel])

  // ── Subscribe to WS events ────────────────────────────────────────────────

  useEffect(() => {
    return ws.subscribe((event: ServerEvent) => {
      switch (event.type) {
        case 'task:queued':
          updateThinking(event.req_id, 'Queued…')
          break
        case 'task:progress': {
          const label =
            event.stage ? capitalize(event.stage.replace(/_/g, ' ')) :
            capitalize(event.status.replace(/_/g, ' '))
          updateThinking(event.req_id, label + '…')
          break
        }
        case 'task:result':
          resolveThinking(event.req_id, event.text, 'complete')
          break
        case 'task:failed':
          resolveThinking(event.req_id, `⚠ ${event.error}`, 'failed')
          break
        case 'error':
          if (event.req_id) resolveThinking(event.req_id, `⚠ ${event.message}`, 'failed')
          break
      }
    })
  }, [ws.subscribe]) // eslint-disable-line react-hooks/exhaustive-deps

  function updateThinking(reqId: string, statusText: string) {
    const msgId = reqToMsgId.current.get(reqId)
    if (!msgId) return
    setMessages(prev =>
      prev.map(m => m.id === msgId ? { ...m, statusText } : m),
    )
  }

  function resolveThinking(reqId: string, content: string, status: MessageStatus) {
    const msgId = reqToMsgId.current.get(reqId)
    if (!msgId) return
    reqToMsgId.current.delete(reqId)
    setMessages(prev =>
      prev.map(m =>
        m.id === msgId ? { ...m, content, status, statusText: undefined, reqId: undefined } : m,
      ),
    )
  }

  // ── Scroll ────────────────────────────────────────────────────────────────

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = atBottom
    setShowScrollBtn(!atBottom)
  }

  useEffect(() => {
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setShowScrollBtn(false)
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
      const chat = await createChat(token)
      setChats(prev => [chat, ...prev])
      setActiveChatId(chat.id)
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

    setMessages(prev => [...prev, userMsg, thinkingMsg])
    setInput('')
    atBottomRef.current = true
    setShowScrollBtn(false)
    reqToMsgId.current.set(reqId, assistantMsgId)

    // Update sidebar title optimistically after first message
    setChats(prev =>
      prev.map(c =>
        c.id === activeChatId && c.title === ''
          ? { ...c, title: text.slice(0, 50) }
          : c,
      ),
    )

    ws.send({ type: 'chat', req_id: reqId, capability: selectedModel, chat_id: activeChatId, content: text })
  }, [input, selectedModel, ws, activeChatId])

  function scrollToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    atBottomRef.current = true
    setShowScrollBtn(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const activeChat = chats.find(c => c.id === activeChatId)
  const canSend = !!input.trim() && !!selectedModel && ws.status === 'connected' && !!activeChatId

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background" data-testid="chat-page">
      {/* ── Sidebar ── */}
      <aside
        className={cn(
          'flex flex-col border-r border-border bg-sidebar shrink-0 overflow-hidden',
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

        <div className="flex-1 overflow-y-auto py-1 px-1">
          {loadingChats ? (
            <div className="flex justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : chats.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4 px-3">
              No chats yet
            </p>
          ) : (
            chats.map(chat => (
              <div
                key={chat.id}
                className={cn(
                  'group/chat-item flex items-center rounded-lg transition-colors',
                  chat.id === activeChatId
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'hover:bg-sidebar-accent/50 text-sidebar-foreground',
                )}
              >
                <button
                  onClick={() => setActiveChatId(chat.id)}
                  data-testid={`chat-item-${chat.id}`}
                  className="flex-1 text-left px-3 py-2 text-sm truncate min-w-0"
                >
                  {chat.title || 'New chat'}
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
            ))
          )}
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="flex flex-col flex-1 min-w-0">
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
          <WsStatusDot status={ws.status} />
        </header>

        {/* messages */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="relative flex-1 overflow-y-auto"
          data-testid="messages-area"
        >
          {!activeChatId ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground select-none">
              <p className="text-sm">No chat selected</p>
              <Button variant="outline" size="sm" onClick={handleNewChat}>
                <Pencil className="size-3.5 mr-1.5" />
                New chat
              </Button>
            </div>
          ) : loadingMessages ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground select-none">
              Start a conversation
            </div>
          ) : (
            <div className="max-w-2xl mx-auto px-4 py-6 flex flex-col gap-5">
              {messages.map(msg => (
                <div
                  key={msg.id}
                  className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}
                  data-testid={`message-${msg.id}`}
                >
                  {msg.role === 'assistant' && msg.status === 'thinking' ? (
                    <ThinkingBubble statusText={msg.statusText} />
                  ) : (
                    <div
                      className={cn(
                        'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed',
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground rounded-br-sm'
                          : msg.status === 'failed'
                            ? 'bg-destructive/10 text-destructive rounded-bl-sm'
                            : 'bg-muted text-foreground rounded-bl-sm',
                      )}
                    >
                      {msg.content}
                    </div>
                  )}
                </div>
              ))}
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

        {/* ── Input ── */}
        <div className="shrink-0 px-4 pb-4 pt-2">
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
                  onSelect={setSelectedModel}
                  onRefresh={ws.refreshCapabilities}
                  wsStatus={ws.status}
                />

                <span className="flex-1" />

                <button
                  onClick={send}
                  disabled={!canSend}
                  aria-label="Send"
                  data-testid="send-btn"
                  className={cn(
                    'size-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                    canSend
                      ? 'bg-foreground text-background hover:bg-foreground/80'
                      : 'bg-muted text-muted-foreground cursor-not-allowed',
                  )}
                >
                  <ArrowUp className="size-4" />
                </button>
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
