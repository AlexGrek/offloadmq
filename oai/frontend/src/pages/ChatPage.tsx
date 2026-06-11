import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useWorkload } from '../contexts/WorkloadContext'
import { ToolDebugModal, toolDebugReady } from '../components/ToolDebugModal'
import { cancelOffloadTask } from '../api/tasks'
import { useWsChat, nextReqId } from '../hooks/useWsChat'
import { useTranscriptScroll } from '../hooks/useTranscriptScroll'
import { useIsMobile } from '../hooks/useIsMobile'
import type { ServerEvent } from '../types/ws'
import {
  listChats,
  createChat,
  deleteChat,
  getChatMessages,
  updateChatSystemPrompt,
  updateChatLastModel,
  type ChatSummary,
} from '../api/chats'
import { DEFAULT_PROMPT } from '../components/chat/SystemPromptStudio'
import {
  ChatTimeoutDrawer,
  type ChatTimeoutSettings,
  DEFAULT_TIMEOUT_SETTINGS,
} from '../components/chat/ChatTimeoutDrawer'
import { ChatSidebar } from '../components/chat/ChatSidebar'
import { ChatHeader } from '../components/chat/ChatHeader'
import { ChatTranscript } from '../components/chat/ChatTranscript'
import { ChatComposer } from '../components/chat/ChatComposer'
import { DocumentReferencePicker } from '../components/chat/DocumentReferencePicker'
import { ImagePickerModal } from '../components/imggen/ImagePickerModal'
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  cloneAttachmentsForResend,
  createImageAttachment,
  uploadDocumentAttachment,
  uploadImageAttachment,
  type ChatAttachment,
} from '../api/chatAttachments'
import {
  capitalize,
  isMessagePending,
  mergeInFlightMessages,
  modelListed,
  pendingMessageId,
  recordToMessage,
  resolveChatModel,
  uid,
  type Message,
  type MessageStatus,
} from '../lib/chat/messages'

type ChatTimeoutEntry = ChatTimeoutSettings & { timeoutUserSet: boolean }

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

  const runningChatIds = useMemo(
    () => new Set(runningChatTasks.map(t => t.chatId)),
    [runningChatTasks],
  )
  const ws = useWsChat(token)

  const [chats, setChats] = useState<ChatSummary[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const activeChatIdRef = useRef<string | null>(null)
  const chatTasksRef = useRef(chatTasks)
  activeChatIdRef.current = activeChatId
  chatTasksRef.current = chatTasks
  const chatsRef = useRef(chats)
  const capsRef = useRef(ws.capabilities)
  chatsRef.current = chats
  capsRef.current = ws.capabilities
  const [messages, setMessages] = useState<Message[]>([])
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile)
  const [input, setInput] = useState('')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [loadingChats, setLoadingChats] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT)
  const [debugOpen, setDebugOpen] = useState(false)
  const [timeoutDrawerOpen, setTimeoutDrawerOpen] = useState(false)
  const [chatTimeoutMap, setChatTimeoutMap] = useState<Map<string, ChatTimeoutEntry>>(new Map())
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [imagePickerOpen, setImagePickerOpen] = useState(false)
  const [documentPickerOpen, setDocumentPickerOpen] = useState(false)

  useEffect(() => {
    setDebugOpen(false)
    setTimeoutDrawerOpen(false)
    setPendingAttachments([])
    setAttachError(null)
    setImagePickerOpen(false)
    setDocumentPickerOpen(false)
  }, [activeChatId])

  // On mobile the sidebar is a full-screen overlay — collapse it when we cross
  // into a narrow viewport so it never starts covering the conversation.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [isMobile])

  const addAttachment = useCallback((att: ChatAttachment) => {
    setPendingAttachments(prev =>
      prev.length >= MAX_ATTACHMENTS_PER_MESSAGE || prev.some(a => a.id === att.id)
        ? prev
        : [...prev, att],
    )
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  const uploadAttachments = useCallback(
    async (files: File[], kind: 'image' | 'document') => {
      if (!token) return
      setAttachError(null)
      setAttaching(true)
      try {
        for (const file of files) {
          const att =
            kind === 'image'
              ? await uploadImageAttachment(token, file)
              : await uploadDocumentAttachment(token, file)
          setPendingAttachments(prev =>
            prev.length >= MAX_ATTACHMENTS_PER_MESSAGE ? prev : [...prev, att],
          )
        }
      } catch (e) {
        setAttachError((e as Error).message)
      } finally {
        setAttaching(false)
      }
    },
    [token],
  )

  const pickLibraryImage = useCallback(
    async (imageId: string) => {
      if (!token) return
      setAttachError(null)
      setAttaching(true)
      try {
        const att = await createImageAttachment(token, imageId)
        addAttachment(att)
      } catch (e) {
        setAttachError((e as Error).message)
      } finally {
        setAttaching(false)
      }
    },
    [token, addAttachment],
  )

  function updateChatTimeout(key: keyof ChatTimeoutSettings, value: number | null) {
    if (!activeChatId) return
    setChatTimeoutMap((prev: Map<string, ChatTimeoutEntry>) => {
      const next = new Map(prev)
      const cur: ChatTimeoutEntry = next.get(activeChatId) ?? { ...DEFAULT_TIMEOUT_SETTINGS, timeoutUserSet: false }
      const updated: ChatTimeoutEntry = { ...cur, [key]: value }
      if (key === 'timeoutSecs') {
        updated.timeoutUserSet = value !== null
      } else if (!cur.timeoutUserSet) {
        const wait = key === 'maxWaitSecs' ? value : cur.maxWaitSecs
        const runtime = key === 'runtimeSecs' ? value : cur.runtimeSecs
        if (wait !== null && runtime !== null) updated.timeoutSecs = wait + runtime
      }
      next.set(activeChatId, updated)
      return next
    })
  }

  // reqId → assistant message id in the current messages list
  const reqToMsgId = useRef<Map<string, string>>(new Map())
  // Wall-clock of the last WS frame received — drives the stall watchdog below so a
  // half-open socket (status stuck "connected", no events) still falls back to REST.
  const lastWsEventAtRef = useRef<number>(Date.now())
  // Previous ws.status, to detect a fresh (re)connect and resync from the DB.
  const prevWsStatusRef = useRef(ws.status)

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
        // Resolve from refs so this effect runs ONLY on chat switch — depending on
        // `chats`/capabilities here would refetch the whole transcript on every send
        // (title/last_model update `chats`), racing the optimistic + streaming UI.
        const chat = chatsRef.current.find(c => c.id === activeChatId)
        const model = resolveChatModel(chat?.last_model, records, capsRef.current)
        if (model) setSelectedModel(model)
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoadingMessages(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeChatId, token])

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

  // Stall watchdog: whenever an assistant reply is in flight, fall back to polling
  // the DB if the live stream isn't delivering — covers a dropped socket, a half-open
  // socket (status stuck "connected"), and the "came back later" / post-restart path
  // where no live WS task owns the reply. A healthy stream emits a progress event ~1/s,
  // so this never fires while events are actually flowing.
  const hasPendingReply = messages.some(isMessagePending)
  useEffect(() => {
    if (!activeChatId || !token || !hasPendingReply) return
    const interval = setInterval(() => {
      const stale = ws.status !== 'connected' || Date.now() - lastWsEventAtRef.current > 6000
      if (stale && activeChatIdRef.current) refreshChatMessages(activeChatIdRef.current)
    }, 2500)
    return () => clearInterval(interval)
  }, [activeChatId, token, hasPendingReply, ws.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // On a fresh (re)connect, resync the open chat from the DB. The poll loop's events
  // for an in-flight task are bound to the dropped socket and are gone; the DB row is
  // the durable record, so this is what recovers state without a manual page reload.
  useEffect(() => {
    const prev = prevWsStatusRef.current
    prevWsStatusRef.current = ws.status
    if (ws.status === 'connected' && prev !== 'connected' && activeChatId && token) {
      refreshChatMessages(activeChatId)
    }
  }, [ws.status, activeChatId, token]) // eslint-disable-line react-hooks/exhaustive-deps

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
      lastWsEventAtRef.current = Date.now()
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
        const restPending = records.some(
          r => r.role === 'assistant' && (r.status === 'pending' || r.status === 'thinking'),
        )
        // The DB says this chat's reply is finalized — clear any in-flight task so a
        // dropped/reconnected socket (whose stream events are gone) doesn't strand a
        // "thinking" bubble or duplicate it alongside the persisted reply.
        if (!restPending) {
          for (const t of chatTasksForChat(chatId)) finishChatTask(t.reqId, 'completed', true)
        }
        const merged = mergeInFlightMessages(
          records.map(recordToMessage).filter((m): m is Message => m != null),
          restPending ? chatTasksForChat(chatId) : [],
        )
        setMessages(merged)
        restoreReqMappings(merged)
      })
      .catch(console.error)
  }

  const showSystemStudio = !loadingMessages && (!activeChatId || messages.length === 0)

  const scroll = useTranscriptScroll({
    messages,
    showSystemStudio,
    loadingMessages,
    activeChatId,
  })

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
      setPendingAttachments([])
      setAttachError(null)
      if (isMobile) setSidebarOpen(false)
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

  const sendWithText = useCallback((text: string, attachments: ChatAttachment[] = []) => {
    if ((!text && attachments.length === 0) || !selectedModel || ws.status !== 'connected' || !activeChatId) return
    if (!modelListed(selectedModel, ws.capabilities)) return

    const reqId = nextReqId('chat')
    const assistantMsgId = uid()

    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: text,
      status: 'complete',
      attachments: attachments.length > 0 ? attachments : undefined,
    }
    const thinkingMsg: Message = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      status: 'thinking',
      reqId,
      statusText: 'Sending…',
    }

    scroll.pinForOutgoing()
    setMessages(prev => [...prev, userMsg, thinkingMsg])
    reqToMsgId.current.set(reqId, assistantMsgId)

    upsertChatTask({
      reqId,
      chatId: activeChatId,
      cap: '',
      id: '',
      status: 'sending',
      statusText: 'Sending…',
    })

    setChats(prev =>
      prev.map(c =>
        c.id === activeChatId
          ? {
              ...c,
              ...(c.title === '' && text ? { title: text.slice(0, 50) } : {}),
              last_model: selectedModel,
            }
          : c,
      ),
    )

    const entry = chatTimeoutMap.get(activeChatId)
    const modelOnline = ws.capabilities.find(c => c.base === selectedModel)?.online ?? false
    ws.send({
      type: 'chat',
      req_id: reqId,
      capability: selectedModel,
      chat_id: activeChatId,
      content: text,
      ...(attachments.length > 0 && { attachment_ids: attachments.map(a => a.id) }),
      model_online: modelOnline,
      ...(entry?.timeoutSecs != null && { timeout_secs: entry.timeoutSecs }),
      ...(entry?.maxWaitSecs != null && { max_wait_secs: entry.maxWaitSecs }),
      ...(entry?.runtimeSecs != null && { runtime_secs: entry.runtimeSecs }),
    })
  }, [selectedModel, ws, activeChatId, upsertChatTask, chatTimeoutMap, scroll])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text && pendingAttachments.length === 0) return
    const attachments = pendingAttachments
    setInput('')
    setPendingAttachments([])
    setAttachError(null)
    sendWithText(text, attachments)
  }, [input, pendingAttachments, sendWithText])

  const retry = useCallback(() => {
    let lastFailedIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].status === 'failed') {
        lastFailedIdx = i
        break
      }
    }
    if (lastFailedIdx < 0) return
    let lastUserMsg: Message | undefined
    for (let i = lastFailedIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserMsg = messages[i]; break }
    }
    if (!lastUserMsg) return
    const content = lastUserMsg.content
    const priorAttachments = lastUserMsg.attachments ?? []
    setMessages((prev: Message[]) => prev.filter((_: Message, i: number) => i !== lastFailedIdx))

    // Already-linked attachments won't re-stage; clone them into fresh refs so
    // the model sees them again on retry (re-stage on retry only).
    if (priorAttachments.length > 0 && token) {
      setAttaching(true)
      cloneAttachmentsForResend(token, priorAttachments)
        .then(cloned => sendWithText(content, cloned))
        .catch(e => setAttachError((e as Error).message))
        .finally(() => setAttaching(false))
    } else {
      sendWithText(content)
    }
  }, [messages, sendWithText, token])

  const selectedCapInfo = ws.capabilities.find(c => c.base === selectedModel)
  const visionWarning =
    pendingAttachments.some(a => a.kind === 'image') &&
    selectedCapInfo != null &&
    !selectedCapInfo.tags.includes('vision')
      ? 'The selected model has no "vision" tag — it may ignore attached images. Text documents are still read on any model.'
      : null

  const canSend =
    (!!input.trim() || pendingAttachments.length > 0) &&
    !attaching &&
    modelListed(selectedModel, ws.capabilities) &&
    ws.status === 'connected' &&
    ws.capabilitiesStatus === 'ready' &&
    !!activeChatId

  const activeChatTask = latestChatTaskForChat(activeChatId)
  const isGenerating =
    (activeChatTask != null && !activeChatTask.terminal) ||
    messages.some((m: Message) => isMessagePending(m))
  const canCancelTask = !!(activeChatTask?.cap && activeChatTask?.id)

  const lastMsg = messages.at(-1)
  const canRetry =
    !isGenerating &&
    lastMsg?.role === 'assistant' &&
    lastMsg?.status === 'failed' &&
    modelListed(selectedModel, ws.capabilities) &&
    ws.status === 'connected' &&
    !!activeChatId

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
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="chat-page"
    >
      <ChatSidebar
        open={sidebarOpen}
        isMobile={isMobile}
        chats={chats}
        activeChatId={activeChatId}
        loading={loadingChats}
        runningChatIds={runningChatIds}
        onSelectChat={id => {
          setActiveChatId(id)
          if (isMobile) setSidebarOpen(false)
        }}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onClose={() => setSidebarOpen(false)}
      />

      {/* ── Main: header + scrollable transcript + fixed input ── */}
      <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden">
        <ChatHeader
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(v => !v)}
          title={activeChat?.title || (activeChatId ? 'New chat' : 'Select a chat')}
          hasActiveChat={!!activeChatId}
          onOpenTimeout={() => setTimeoutDrawerOpen(v => !v)}
          onOpenDebug={() => setDebugOpen(true)}
          debugActive={toolDebugReady(debugTask?.cap, debugTask?.id)}
          wsStatus={ws.status}
        />

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

        <ChatTimeoutDrawer
          open={timeoutDrawerOpen}
          onClose={() => setTimeoutDrawerOpen(false)}
          settings={chatTimeoutMap.get(activeChatId ?? '') ?? DEFAULT_TIMEOUT_SETTINGS}
          onChange={updateChatTimeout}
        />

        <ChatTranscript
          scrollRef={scroll.scrollRef}
          contentRef={scroll.contentRef}
          messagesEndRef={scroll.messagesEndRef}
          onScroll={scroll.handleScroll}
          onWheel={scroll.handleWheel}
          showScrollBtn={scroll.showScrollBtn}
          onScrollToBottom={() => scroll.scrollToBottom('smooth')}
          token={token}
          showSystemStudio={showSystemStudio}
          loadingMessages={loadingMessages}
          hasActiveChat={!!activeChatId}
          systemPrompt={systemPrompt}
          onSystemPromptChange={setSystemPrompt}
          onApplySystemPrompt={applySystemPrompt}
          onNewChat={handleNewChat}
          messages={messages}
          canRetry={canRetry}
          onRetry={retry}
        />

        <ChatComposer
          value={input}
          onChange={setInput}
          onSend={send}
          wsStatus={ws.status}
          hasActiveChat={!!activeChatId}
          capabilities={ws.capabilities}
          selectedModel={selectedModel}
          onModelSelect={handleModelSelect}
          onRefreshCapabilities={ws.refreshCapabilities}
          capabilitiesStatus={ws.capabilitiesStatus}
          capabilitiesError={ws.capabilitiesError}
          isGenerating={isGenerating}
          canSend={canSend}
          canCancelTask={canCancelTask}
          onCancel={() => void handleCancel()}
          attachments={pendingAttachments}
          attaching={attaching}
          attachError={attachError}
          attachDisabled={pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
          onUploadImages={files => void uploadAttachments(files, 'image')}
          onUploadDocuments={files => void uploadAttachments(files, 'document')}
          onRemoveAttachment={removeAttachment}
          onOpenImageLibrary={() => setImagePickerOpen(true)}
          onOpenDocumentPicker={() => setDocumentPickerOpen(true)}
          visionWarning={visionWarning}
        />
      </div>

      {token && (
        <ImagePickerModal
          open={imagePickerOpen}
          onClose={() => setImagePickerOpen(false)}
          onSelect={img => void pickLibraryImage(img.image_id)}
          token={token}
        />
      )}

      <DocumentReferencePicker
        open={documentPickerOpen}
        onOpenChange={setDocumentPickerOpen}
        onPick={addAttachment}
        disabled={pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
      />
    </div>
  )
}
