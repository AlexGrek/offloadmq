import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { useResetOnChange } from '@/hooks/useResetOnChange'
import { useLocation, useNavigate } from 'react-router-dom'
import { Feather } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkload } from '../../contexts/WorkloadContext'
import { ToolDebugModal } from '../ToolDebugModal'
import { toolDebugReady } from '../../lib/toolDebug'
import { cancelOffloadTask } from '../../api/tasks'
import { useWsChat, nextReqId } from '../../hooks/useWsChat'
import { useTranscriptScroll } from '../../hooks/useTranscriptScroll'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useToolSidebarOpen } from '../../hooks/useToolSidebarOpen'
import type { ServerEvent } from '../../types/ws'
import {
  listChats,
  createChat,
  deleteChat,
  getChatMessages,
  updateChatSystemPrompt,
  updateChatLastModel,
  type ChatKind,
  type ChatSummary,
} from '../../api/chats'
import { recordRecentPrompt } from '../../api/prompts'
import type { ImggenRouteState } from '../../lib/imggen'
import {
  ANOTHER_ONE_MESSAGE,
  PROMPT_STUDIO_TEMPLATE_BUCKET,
  extractPrompt,
  composeFirstMessage,
  renderTemplate,
  type PromptStudioRouteState,
} from '../../lib/promptStudio'
import { PromptStudioSetup } from '../promptStudio/PromptStudioSetup'
import { PromptActions } from '../promptStudio/PromptActions'
import type { ChatSidebarLabels } from './ChatSidebar'
import { useDefaultPrompts } from '../../hooks/useDefaultPrompts'
import { readChatPrompt, rememberChatPrompt } from '../../lib/chat/promptCache'
import {
  ChatTimeoutDrawer,
} from './ChatTimeoutDrawer'
import { DEFAULT_TIMEOUT_SETTINGS, type ChatTimeoutSettings } from '../../lib/chat/timeoutSettings'
import { ChatSidebar } from './ChatSidebar'
import { ChatHeader } from './ChatHeader'
import { ChatTranscript } from './ChatTranscript'
import { ChatComposer } from './ChatComposer'
import { DocumentReferencePicker } from './DocumentReferencePicker'
import { ImagePickerModal } from '../imggen/ImagePickerModal'
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  cloneAttachmentsForResend,
  createImageAttachment,
  uploadDocumentAttachment,
  uploadImageAttachment,
  type ChatAttachment,
} from '../../api/chatAttachments'
import {
  capitalize,
  isMessagePending,
  mergeInFlightMessages,
  modelListed,
  pendingMessageId,
  recordToMessage,
  resolveChatModel,
  staleChatTasks,
  uid,
  type Message,
  type MessageStatus,
} from '../../lib/chat/messages'

type ChatTimeoutEntry = ChatTimeoutSettings & { timeoutUserSet: boolean }

/** Per-kind differences; everything else (WS, streaming, attachments, cancel) is shared. */
const KIND_CONFIG: Record<
  ChatKind,
  {
    pageTestId: string
    labels: ChatSidebarLabels
    noChatTitle: string
    enterSends: boolean
    allowDocuments: boolean
  }
> = {
  chat: {
    pageTestId: 'chat-page',
    labels: {
      title: 'Chats',
      newItem: 'New chat',
      empty: 'No chats yet',
      untitled: 'New chat',
      delete: 'Delete chat',
    },
    noChatTitle: 'Select a chat',
    enterSends: true,
    allowDocuments: true,
  },
  prompt_studio: {
    pageTestId: 'prompt-studio-page',
    labels: {
      titleLines: 2,
      title: 'Studio sessions',
      newItem: 'New session',
      empty: 'No sessions yet',
      untitled: 'New session',
      delete: 'Delete session',
    },
    noChatTitle: 'New session',
    enterSends: false,
    allowDocuments: false,
  },
}

/**
 * Sidebar + transcript + composer chat UI shared by LLM Chat (`kind="chat"`) and
 * Prompt Studio (`kind="prompt_studio"`). Both are `chats` rows on the backend,
 * listed separately by kind.
 */
export function ChatWorkspace({ kind }: { kind: ChatKind }) {
  const config = KIND_CONFIG[kind]
  const isStudio = kind === 'prompt_studio'
  const { token, user } = useAuth()
  const userId = user?.id
  const navigate = useNavigate()
  const location = useLocation()
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
  const [sidebarOpen, setSidebarOpen] = useToolSidebarOpen(isMobile)
  const [input, setInput] = useState('')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [loadingChats, setLoadingChats] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const promptDefaults = useDefaultPrompts()
  const defaultPrompt = isStudio ? promptDefaults.prompt_studio_system : promptDefaults.chat
  const [systemPrompt, setSystemPrompt] = useState(() =>
    (user ? readChatPrompt(user.id, kind) : null) ?? defaultPrompt,
  )
  // Prompt Studio setup: the example prompt rendered through a message template becomes
  // the first message (shown as a preview; the message box adds optional extra text).
  const defaultTemplate = promptDefaults.prompt_studio_template
  const [examplePrompt, setExamplePrompt] = useState('')
  const [template, setTemplate] = useState(defaultTemplate)
  // A just-created studio session has no history; skip its REST load so it can't
  // race (and wipe) the optimistic first message.
  const skipLoadForChatRef = useRef<string | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [timeoutDrawerOpen, setTimeoutDrawerOpen] = useState(false)
  const [chatTimeoutMap, setChatTimeoutMap] = useState<Map<string, ChatTimeoutEntry>>(new Map())
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [imagePickerOpen, setImagePickerOpen] = useState(false)
  const [documentPickerOpen, setDocumentPickerOpen] = useState(false)

  // Per-chat UI state starts fresh whenever another chat opens.
  useResetOnChange(activeChatId, () => {
    setDebugOpen(false)
    setTimeoutDrawerOpen(false)
    setPendingAttachments([])
    setAttachError(null)
    setImagePickerOpen(false)
    setDocumentPickerOpen(false)
  })


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

  useResetOnChange(token ? `${token}|${kind}` : null, key => {
    if (key) setLoadingChats(true)
  })

  useEffect(() => {
    if (!token) return
    listChats(token, kind)
      .then(setChats)
      .catch(console.error)
      .finally(() => setLoadingChats(false))
  }, [token, kind])

  // ── Prompt Studio: seed a new session from another app (`PromptStudioRouteState`)

  const incomingSeed = (() => {
    const state = location.state as PromptStudioRouteState | null
    return isStudio && state && typeof state.examplePrompt === 'string'
      ? (state as PromptStudioRouteState & { examplePrompt: string })
      : null
  })()
  useResetOnChange(incomingSeed, seed => {
    if (!seed) return
    setActiveChatId(null)
    setMessages([])
    setExamplePrompt(seed.examplePrompt)
    setInput('')
  })
  // The seed is one-shot: consume it so a reload or back-navigation doesn't replay it.
  useEffect(() => {
    if (incomingSeed) navigate(location.pathname, { replace: true, state: null })
  }, [incomingSeed, location.pathname, navigate])

  // ── Load messages when active chat changes ────────────────────────────────

  /* eslint-disable react-hooks/set-state-in-effect -- async transcript load keyed on the
     open chat: cancel-guarded, and it consumes `skipLoadForChatRef` (a just-created
     session must not refetch over its optimistic first message). */
  useEffect(() => {
    if (!activeChatId || !token) {
      setMessages([])
      return
    }
    if (skipLoadForChatRef.current === activeChatId) {
      skipLoadForChatRef.current = null
      setLoadingMessages(false)
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
        // A reply that finished while the page was closed never delivered its result
        // event — retire that task instead of resurrecting a "thinking" bubble.
        const stale = staleChatTasks(records, running)
        for (const t of stale) finishChatTask(t.reqId, 'completed', true)
        const merged = mergeInFlightMessages(
          records.map(recordToMessage).filter((m): m is Message => m != null),
          running.filter(t => !stale.includes(t)),
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
  }, [activeChatId, token, finishChatTask])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- the next three effects reconcile
     state with external, asynchronously-arriving data (model list, chat list, in-flight
     task registry); they cannot be derived during render without changing when they fire. */
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
  /* eslint-enable react-hooks/set-state-in-effect */

  const activeChat = chats.find(c => c.id === activeChatId)
  const activeSystemPrompt = activeChat?.system_prompt

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

  // The open chat's stored system prompt becomes the current one (string key: re-runs on value change).
  useResetOnChange(
    activeChatId && activeSystemPrompt !== undefined
      ? `${activeChatId}\u0000${activeSystemPrompt}\u0000${defaultPrompt}`
      : null,
    key => {
      if (key) setSystemPrompt((activeSystemPrompt ?? '').trim() || defaultPrompt)
    },
  )
  useEffect(() => {
    if (activeChatId && activeSystemPrompt !== undefined && userId !== undefined) {
      rememberChatPrompt(userId, activeSystemPrompt.trim() || defaultPrompt, kind)
    }
  }, [activeChatId, activeSystemPrompt, defaultPrompt, userId, kind])

  const applySystemPrompt = useCallback(
    async (content: string) => {
      if (!token) return
      const text = content.trim() || defaultPrompt
      if (!activeChatId) {
        const chat = await createChat(token, {
          systemPrompt: text,
          lastModel: selectedModel,
          kind,
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
    [token, activeChatId, selectedModel, defaultPrompt, kind],
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

  /* eslint-disable react-hooks/set-state-in-effect -- re-resolves the selected model when
     the (async) capability list or chat list changes; see the note above. */
  // If capabilities refresh and current selection vanished, re-resolve for this chat.
  useEffect(() => {
    if (ws.capabilities.length === 0 || !activeChatId) return
    if (modelListed(selectedModel, ws.capabilities)) return
    const chat = chats.find(c => c.id === activeChatId)
    const model = resolveChatModel(chat?.last_model, [], ws.capabilities)
    if (model) setSelectedModel(model)
  }, [ws.capabilities, activeChatId, chats, selectedModel])

  // Prompt Studio draft (no session yet): default to the most recent session's model.
  useEffect(() => {
    if (!isStudio || activeChatId || ws.capabilities.length === 0) return
    if (modelListed(selectedModel, ws.capabilities)) return
    const model = resolveChatModel(chats[0]?.last_model, [], ws.capabilities)
    if (model) setSelectedModel(model)
  }, [isStudio, activeChatId, chats, ws.capabilities, selectedModel])
  /* eslint-enable react-hooks/set-state-in-effect */

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
  /** Prompt Studio before the first message: the composer lives inside the setup form. */
  const studioSetup = isStudio && showSystemStudio
  const studioSeed = studioSetup ? renderTemplate(template, examplePrompt) : ''

  const scroll = useTranscriptScroll({
    messages,
    showSystemStudio,
    loadingMessages,
    activeChatId,
  })

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleNewChat() {
    if (!token) return
    if (isStudio) {
      // A studio session is created on its first send, from the setup panel.
      setActiveChatId(null)
      setMessages([])
      setInput('')
      setExamplePrompt('')
      setPendingAttachments([])
      setAttachError(null)
      if (isMobile) setSidebarOpen(false)
      return
    }
    try {
      const chat = await createChat(token, {
        systemPrompt: systemPrompt.trim() || defaultPrompt,
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
    const title = chats.find(c => c.id === chatId)?.title || config.labels.untitled
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

  const sendWithText = useCallback((
    text: string,
    attachments: ChatAttachment[] = [],
    chatId: string | null = activeChatId,
  ) => {
    if ((!text && attachments.length === 0) || !selectedModel || ws.status !== 'connected' || !chatId) return
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
      chatId,
      cap: '',
      id: '',
      status: 'sending',
      statusText: 'Sending…',
    })

    setChats(prev =>
      prev.map(c =>
        c.id === chatId
          ? {
              ...c,
              ...(c.title === '' && text ? { title: text.slice(0, 50) } : {}),
              last_model: selectedModel,
            }
          : c,
      ),
    )

    const entry = chatTimeoutMap.get(chatId)
    const modelOnline = ws.capabilities.find(c => c.base === selectedModel)?.online ?? false
    ws.send({
      type: 'chat',
      req_id: reqId,
      capability: selectedModel,
      chat_id: chatId,
      content: text,
      ...(attachments.length > 0 && { attachment_ids: attachments.map(a => a.id) }),
      model_online: modelOnline,
      ...(entry?.timeoutSecs != null && { timeout_secs: entry.timeoutSecs }),
      ...(entry?.maxWaitSecs != null && { max_wait_secs: entry.maxWaitSecs }),
      ...(entry?.runtimeSecs != null && { runtime_secs: entry.runtimeSecs }),
    })
  }, [selectedModel, ws, activeChatId, upsertChatTask, chatTimeoutMap, scroll])

  /**
   * Prompt Studio: the setup panel's system prompt applies on the first send —
   * create the session (draft) or update an empty one whose prompt was edited.
   */
  const ensureStudioSession = useCallback(async (): Promise<string | null> => {
    if (!token) return null
    const text = systemPrompt.trim() || defaultPrompt
    if (!activeChatId) {
      // Name the session after the example prompt, else the template — the first message
      // is mostly the template, so first-N-chars titles all look the same.
      const title = examplePrompt.trim() || template.trim()
      const chat = await createChat(token, { systemPrompt: text, lastModel: selectedModel, kind, title })
      setChats(prev => [chat, ...prev])
      skipLoadForChatRef.current = chat.id
      setActiveChatId(chat.id)
      return chat.id
    }
    if (messages.length === 0 && text !== activeChat?.system_prompt) {
      const chat = await updateChatSystemPrompt(token, activeChatId, text)
      setChats(prev => prev.map(c => (c.id === chat.id ? chat : c)))
    }
    return activeChatId
  }, [token, systemPrompt, defaultPrompt, activeChatId, selectedModel, kind, messages.length, activeChat?.system_prompt, examplePrompt, template])

  const send = useCallback(async () => {
    const text = studioSetup ? composeFirstMessage(studioSeed, input) : input.trim()
    if (!text && pendingAttachments.length === 0) return
    const attachments = pendingAttachments
    const firstTurn = messages.length === 0
    let chatId = activeChatId
    if (isStudio) {
      try {
        chatId = await ensureStudioSession()
      } catch (e) {
        setAttachError((e as Error).message)
        return
      }
      if (!chatId) return
    }
    setInput('')
    setPendingAttachments([])
    setAttachError(null)
    sendWithText(text, attachments, chatId)
    // The studio template library records templates actually used to open a session.
    if (isStudio && firstTurn && token && studioSeed && template.trim()) {
      recordRecentPrompt(token, PROMPT_STUDIO_TEMPLATE_BUCKET, template.trim()).catch(console.error)
    }
  }, [input, pendingAttachments, sendWithText, messages.length, activeChatId, isStudio, ensureStudioSession, token, studioSetup, studioSeed, template])

  const handleUseAsPrompt = useCallback(
    (prompt: string) => {
      const text = prompt.trim()
      if (!text) return
      const state: ImggenRouteState = { usePrompt: text }
      navigate('/app/images', { state })
    },
    [navigate],
  )

  const renderPromptActions = useCallback(
    (msg: Message) =>
      token ? (
        <PromptActions
          token={token}
          prompt={extractPrompt(msg.content)}
          onUse={handleUseAsPrompt}
          tone={msg.role === 'user' ? 'muted' : 'default'}
          testIdPrefix={msg.role === 'user' ? 'prompt-studio-user' : 'prompt-studio'}
        />
      ) : null,
    [token, handleUseAsPrompt],
  )

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
    (!!input.trim() || !!studioSeed || pendingAttachments.length > 0) &&
    !attaching &&
    modelListed(selectedModel, ws.capabilities) &&
    ws.status === 'connected' &&
    ws.capabilitiesStatus === 'ready' &&
    (isStudio || !!activeChatId)

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

  const canSendAnother =
    isStudio &&
    !isGenerating &&
    !attaching &&
    lastMsg?.role === 'assistant' &&
    lastMsg.status === 'complete' &&
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

  const composerProps: ComponentProps<typeof ChatComposer> = {
    value: input,
    onChange: setInput,
    onSend: () => void send(),
    wsStatus: ws.status,
    hasActiveChat: isStudio || !!activeChatId,
    capabilities: ws.capabilities,
    selectedModel,
    onModelSelect: handleModelSelect,
    onRefreshCapabilities: ws.refreshCapabilities,
    capabilitiesStatus: ws.capabilitiesStatus,
    capabilitiesError: ws.capabilitiesError,
    isGenerating,
    canSend,
    canCancelTask,
    onCancel: () => void handleCancel(),
    attachments: pendingAttachments,
    attaching,
    attachError,
    attachDisabled: pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE,
    onUploadImages: files => void uploadAttachments(files, 'image'),
    onUploadDocuments: files => void uploadAttachments(files, 'document'),
    onRemoveAttachment: removeAttachment,
    onOpenImageLibrary: () => setImagePickerOpen(true),
    onOpenDocumentPicker: () => setDocumentPickerOpen(true),
    visionWarning,
    enterSends: config.enterSends,
    allowDocuments: config.allowDocuments,
    topSlot: canSendAnother ? (
      <div className="mb-2 flex justify-center">
        <button
          type="button"
          onClick={() => sendWithText(ANOTHER_ONE_MESSAGE)}
          data-testid="prompt-studio-another"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-blue-500/10 px-3.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/20 dark:text-blue-300"
        >
          <Feather className="size-3.5" />
          {ANOTHER_ONE_MESSAGE}
        </button>
      </div>
    ) : undefined,
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid={config.pageTestId}
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
        labels={config.labels}
      />

      {/* ── Main: header + scrollable transcript + fixed input ── */}
      <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden">
        <ChatHeader
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(v => !v)}
          title={activeChat?.title || (activeChatId ? config.labels.untitled : config.noChatTitle)}
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
          subject={activeChat?.title || config.labels.untitled}
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
          renderPromptActions={isStudio ? renderPromptActions : undefined}
          emptyState={
            isStudio && token ? (
              <PromptStudioSetup
                token={token}
                systemPrompt={systemPrompt}
                onSystemPromptChange={setSystemPrompt}
                defaultSystemPrompt={defaultPrompt}
                examplePrompt={examplePrompt}
                onExamplePromptChange={setExamplePrompt}
                template={template}
                onTemplateChange={setTemplate}
                defaultTemplate={defaultTemplate}
                onUsePrompt={handleUseAsPrompt}
                composer={
                  <ChatComposer
                    {...composerProps}
                    inline
                    placeholder={
                      studioSeed
                        ? 'Add instructions (optional) — sent together with the example'
                        : 'Describe what you want, or start from an example prompt above'
                    }
                  />
                }
              />
            ) : undefined
          }
        />

        {!studioSetup && <ChatComposer {...composerProps} />}
      </div>

      {token && (
        <ImagePickerModal
          open={imagePickerOpen}
          onClose={() => setImagePickerOpen(false)}
          onSelect={img => void pickLibraryImage(img.image_id)}
          token={token}
        />
      )}

      {config.allowDocuments && (
        <DocumentReferencePicker
          open={documentPickerOpen}
          onOpenChange={setDocumentPickerOpen}
          onPick={addAttachment}
          disabled={pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
        />
      )}
    </div>
  )
}
