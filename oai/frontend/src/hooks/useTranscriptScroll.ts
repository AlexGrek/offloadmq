import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isMessagePending, type Message } from '@/lib/chat/messages'

const BOTTOM_THRESHOLD_PX = 48

/**
 * Owns the chat transcript's auto-follow scrolling.
 *
 * Pins to the bottom only while the user is already at the bottom; any upward
 * scroll disables follow, and scrolling back to the end re-enables it. Returns
 * the refs/handlers the transcript wires up plus `pinForOutgoing()` for the page
 * to call right before appending the user's own message.
 */
export function useTranscriptScroll(opts: {
  messages: Message[]
  showSystemStudio: boolean
  loadingMessages: boolean
  activeChatId: string | null
}) {
  const { messages, showSystemStudio, loadingMessages, activeChatId } = opts

  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  /** When true, new content keeps the transcript pinned to the bottom. */
  const autoScrollRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  /** Ignore onScroll while we programmatically pin (DOM swaps reset scrollTop → false "scroll up"). */
  const suppressScrollHandlerRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const isStreaming = messages.some(isMessagePending)

  function distanceFromBottom(el: HTMLDivElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }

  function maxScrollTop(el: HTMLDivElement): number {
    return Math.max(0, el.scrollHeight - el.clientHeight)
  }

  const handleScroll = useCallback(() => {
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
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) autoScrollRef.current = false
  }, [])

  /** Pin transcript to the bottom sentinel (inside the scroll container only). */
  function scrollTranscriptToEnd(behavior: ScrollBehavior = 'instant') {
    const el = scrollRef.current
    const end = messagesEndRef.current
    if (end) {
      end.scrollIntoView({ block: 'end', behavior })
    } else if (el) {
      el.scrollTop = maxScrollTop(el)
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

  /** Manual "scroll to bottom" button — re-enables follow. */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    autoScrollRef.current = true
    suppressScrollHandlerRef.current = true
    scrollTranscriptToEnd(behavior)
    const el = scrollRef.current
    if (el) lastScrollTopRef.current = el.scrollTop
    setShowScrollBtn(false)
    requestAnimationFrame(() => {
      suppressScrollHandlerRef.current = false
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Call right before appending an outgoing message so we stay pinned. */
  const pinForOutgoing = useCallback(() => {
    autoScrollRef.current = true
    suppressScrollHandlerRef.current = true
    setShowScrollBtn(false)
  }, [])

  useLayoutEffect(() => {
    if (showSystemStudio || loadingMessages) return
    followTranscriptBottom('instant')
  }, [messages, isStreaming, showSystemStudio, loadingMessages]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    autoScrollRef.current = true
    setShowScrollBtn(false)
    requestAnimationFrame(() => followTranscriptBottom('instant'))
  }, [activeChatId]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    scrollRef,
    messagesEndRef,
    showScrollBtn,
    handleScroll,
    handleWheel,
    scrollToBottom,
    pinForOutgoing,
  }
}
