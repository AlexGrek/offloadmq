import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isMessagePending, type Message } from '@/lib/chat/messages'

const BOTTOM_THRESHOLD_PX = 48

/**
 * Owns the chat transcript's auto-follow scrolling.
 *
 * Stays pinned to the bottom while the user is at (or near) the bottom, and
 * keeps following as the assistant's reply streams in. Any upward scroll/wheel
 * detaches follow-mode; scrolling back to the end (or hitting the button)
 * re-attaches it.
 *
 * The actual "stick to bottom" is driven by a `ResizeObserver` on the transcript
 * content — so it survives async height changes (markdown relayout, message
 * remounts, image/font loads) that a render-time effect alone would miss. Wire
 * `contentRef` onto the element whose height grows (the messages list), and
 * `scrollRef` onto the scroll container.
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
  /** When true, height changes keep the transcript pinned to the bottom. */
  const followRef = useRef(true)
  /** Ignore scroll events emitted by an in-flight smooth programmatic scroll. */
  const smoothSuppressRef = useRef(false)
  const smoothTimer = useRef<number | null>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const isStreaming = messages.some(isMessagePending)

  function distanceFromBottom(el: HTMLDivElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }

  /** Snap the scroll container (never an ancestor) to its bottom. */
  const snapToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
    const el = scrollRef.current
    if (!el) return
    const top = Math.max(0, el.scrollHeight - el.clientHeight)
    if (behavior === 'smooth') {
      smoothSuppressRef.current = true
      if (smoothTimer.current) clearTimeout(smoothTimer.current)
      smoothTimer.current = window.setTimeout(() => {
        smoothSuppressRef.current = false
      }, 500)
      el.scrollTo({ top, behavior: 'smooth' })
    } else {
      el.scrollTop = top
    }
  }, [])

  const handleScroll = useCallback(() => {
    if (smoothSuppressRef.current) return
    const el = scrollRef.current
    if (!el) return
    // Distance-based: at/near the bottom means "follow", anywhere above means the
    // user is reading history. Our own instant snaps land at the bottom, so they
    // re-affirm follow rather than break it — no direction tracking needed.
    const atBottom = distanceFromBottom(el) <= BOTTOM_THRESHOLD_PX
    followRef.current = atBottom
    setShowScrollBtn(!atBottom)
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current
    if (!el) return
    // Upward intent detaches follow immediately (wins the fight against fast
    // streaming), but only when there's actually room to scroll up.
    if (e.deltaY < 0 && el.scrollHeight > el.clientHeight) {
      followRef.current = false
      setShowScrollBtn(true)
    }
  }, [])

  /** Manual "scroll to bottom" button — re-attaches follow. */
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      followRef.current = true
      setShowScrollBtn(false)
      snapToBottom(behavior)
    },
    [snapToBottom],
  )

  /** Call right before appending an outgoing message so we stay pinned. */
  const pinForOutgoing = useCallback(() => {
    followRef.current = true
    setShowScrollBtn(false)
    snapToBottom('instant')
  }, [snapToBottom])

  // Observe the transcript content: any height change while following snaps us to
  // the bottom. ResizeObserver fires after layout / before paint, so there's no
  // flash, and it catches growth that no React render reports (markdown relayout,
  // images, fonts, message remounts).
  const observerRef = useRef<ResizeObserver | null>(null)
  const observedRef = useRef<HTMLElement | null>(null)
  const setContentRef = useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current && observedRef.current) {
      observerRef.current.unobserve(observedRef.current)
    }
    observedRef.current = el
    if (!el) return
    if (!observerRef.current) {
      observerRef.current = new ResizeObserver(() => {
        if (followRef.current) snapToBottom('instant')
      })
    }
    observerRef.current.observe(el)
  }, [snapToBottom])

  useEffect(
    () => () => {
      observerRef.current?.disconnect()
      if (smoothTimer.current) clearTimeout(smoothTimer.current)
    },
    [],
  )

  // Snap on the window resizing (clientHeight changes don't resize the content box).
  useEffect(() => {
    const onResize = () => {
      if (followRef.current) snapToBottom('instant')
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [snapToBottom])

  // Immediate pre-paint snap when the message list itself changes (covers the
  // first-message studio→transcript swap before the observer attaches).
  useLayoutEffect(() => {
    if (showSystemStudio || loadingMessages) return
    if (followRef.current) snapToBottom('instant')
  }, [messages, isStreaming, showSystemStudio, loadingMessages, snapToBottom])

  // New chat opened: re-attach follow and drop to the bottom once it renders.
  useEffect(() => {
    followRef.current = true
    setShowScrollBtn(false)
    requestAnimationFrame(() => snapToBottom('instant'))
  }, [activeChatId, snapToBottom])

  return {
    scrollRef,
    contentRef: setContentRef,
    messagesEndRef,
    showScrollBtn,
    handleScroll,
    handleWheel,
    scrollToBottom,
    pinForOutgoing,
  }
}
