import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientCommand, LlmCapabilityInfo, ServerEvent } from '../types/ws'

export type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WsChatHandle {
  status: WsStatus
  capabilities: LlmCapabilityInfo[]
  send: (cmd: ClientCommand) => void
  subscribe: (handler: (event: ServerEvent) => void) => () => void
  refreshCapabilities: () => void
}

function buildWsUrl(path: string, token: string): string {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url.toString()
}

let _reqCounter = 0
export function nextReqId(prefix = 'r'): string {
  return `${prefix}_${++_reqCounter}`
}

export function useWsChat(token: string | null): WsChatHandle {
  const [status, setStatus] = useState<WsStatus>('disconnected')
  const [capabilities, setCapabilities] = useState<LlmCapabilityInfo[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef(new Set<(event: ServerEvent) => void>())
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryDelay = useRef(1500)
  const destroyed = useRef(false)
  // Stable ref so the retry closure always has current token
  const tokenRef = useRef(token)
  tokenRef.current = token

  const send = useCallback((cmd: ClientCommand) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(cmd))
    }
  }, [])

  const subscribe = useCallback((handler: (event: ServerEvent) => void) => {
    handlersRef.current.add(handler)
    return () => { handlersRef.current.delete(handler) }
  }, [])

  const refreshCapabilities = useCallback(() => {
    send({ type: 'list_capabilities', req_id: nextReqId('caps') })
  }, [send])

  useEffect(() => {
    if (!token) return

    destroyed.current = false
    retryDelay.current = 1500

    function connect() {
      const t = tokenRef.current
      if (destroyed.current || !t) return

      const ws = new WebSocket(buildWsUrl('/api/ws/chat', t))
      wsRef.current = ws
      setStatus('connecting')

      ws.onopen = () => {
        if (destroyed.current) { ws.close(); return }
        setStatus('connected')
        retryDelay.current = 1500
        ws.send(JSON.stringify({ type: 'list_capabilities', req_id: 'init' }))
      }

      ws.onmessage = (e) => {
        let event: ServerEvent
        try { event = JSON.parse(e.data as string) as ServerEvent }
        catch { return }

        if (event.type === 'capabilities') {
          setCapabilities(event.capabilities)
        }
        handlersRef.current.forEach(h => h(event))
      }

      ws.onerror = () => setStatus('error')

      ws.onclose = () => {
        if (destroyed.current) return
        setStatus('disconnected')
        const delay = retryDelay.current
        retryDelay.current = Math.min(delay * 2, 30_000)
        retryTimer.current = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      destroyed.current = true
      if (retryTimer.current) clearTimeout(retryTimer.current)
      wsRef.current?.close()
      setStatus('disconnected')
      setCapabilities([])
    }
  }, [token])

  return { status, capabilities, send, subscribe, refreshCapabilities }
}
