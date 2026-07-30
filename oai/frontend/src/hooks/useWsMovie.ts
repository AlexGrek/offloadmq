import { useCallback, useEffect, useRef, useState } from 'react'
import type { CapabilitiesStatus } from '../lib/capabilitiesStatus'
import type { LlmCapabilityInfo } from '../types/ws'
import type { MovieClientCommand, MovieServerEvent } from '../types/ws-movie'

export type { CapabilitiesStatus } from '../lib/capabilitiesStatus'

export type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface MovieCapabilities {
  llm: LlmCapabilityInfo[]
  video: LlmCapabilityInfo[]
}

const EMPTY_CAPABILITIES: MovieCapabilities = { llm: [], video: [] }

export interface WsMovieHandle {
  status: WsStatus
  capabilities: MovieCapabilities
  capabilitiesStatus: CapabilitiesStatus
  capabilitiesError: string | null
  send: (cmd: MovieClientCommand) => boolean
  subscribe: (handler: (event: MovieServerEvent) => void) => () => void
  refreshCapabilities: () => void
}

function buildWsUrl(path: string, token: string): string {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url.toString()
}

let _reqCounter = 0
export function nextMovieReqId(prefix = 'mv'): string {
  return `${prefix}_${++_reqCounter}`
}

export function useWsMovie(token: string | null): WsMovieHandle {
  const [status, setStatus] = useState<WsStatus>('disconnected')
  const [capabilities, setCapabilities] = useState<MovieCapabilities>(EMPTY_CAPABILITIES)
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('idle')
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pendingCapsReq = useRef<string | null>(null)
  const handlersRef = useRef(new Set<(event: MovieServerEvent) => void>())
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const retryDelay = useRef(1500)
  const destroyed = useRef(false)
  const tokenRef = useRef(token)
  tokenRef.current = token

  const send = useCallback((cmd: MovieClientCommand): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(cmd))
      return true
    }
    return false
  }, [])

  const subscribe = useCallback((handler: (event: MovieServerEvent) => void) => {
    handlersRef.current.add(handler)
    return () => { handlersRef.current.delete(handler) }
  }, [])

  const requestCapabilities = useCallback((reqId: string) => {
    pendingCapsReq.current = reqId
    setCapabilitiesStatus('loading')
    setCapabilitiesError(null)
    send({ type: 'list_capabilities', req_id: reqId })
  }, [send])

  const refreshCapabilities = useCallback(() => {
    requestCapabilities(nextMovieReqId('caps'))
  }, [requestCapabilities])

  useEffect(() => {
    if (!token) return

    destroyed.current = false
    retryDelay.current = 1500

    function connect() {
      const t = tokenRef.current
      if (destroyed.current || !t) return

      const ws = new WebSocket(buildWsUrl('/api/ws/movie', t))
      wsRef.current = ws
      setStatus('connecting')

      ws.onopen = () => {
        if (destroyed.current) { ws.close(); return }
        setStatus('connected')
        retryDelay.current = 1500
        pendingCapsReq.current = 'init'
        setCapabilitiesStatus('loading')
        setCapabilitiesError(null)
        ws.send(JSON.stringify({ type: 'list_capabilities', req_id: 'init' }))
        if (pingTimer.current) clearInterval(pingTimer.current)
        pingTimer.current = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'ping' }))
          }
        }, 25_000)
      }

      ws.onmessage = (e) => {
        let event: MovieServerEvent
        try { event = JSON.parse(e.data as string) as MovieServerEvent }
        catch { return }

        if (event.type === 'movie_capabilities') {
          pendingCapsReq.current = null
          setCapabilities({ llm: event.llm, video: event.video })
          setCapabilitiesStatus('ready')
          setCapabilitiesError(null)
        } else if (
          event.type === 'error' &&
          event.req_id != null &&
          event.req_id === pendingCapsReq.current
        ) {
          pendingCapsReq.current = null
          setCapabilitiesStatus('error')
          setCapabilitiesError(event.message)
        }
        handlersRef.current.forEach(h => h(event))
      }

      ws.onerror = () => setStatus('error')

      ws.onclose = () => {
        if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null }
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
      if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null }
      wsRef.current?.close()
      setStatus('disconnected')
      setCapabilities(EMPTY_CAPABILITIES)
      setCapabilitiesStatus('idle')
      setCapabilitiesError(null)
      pendingCapsReq.current = null
    }
  }, [token])

  return {
    status,
    capabilities,
    capabilitiesStatus,
    capabilitiesError,
    send,
    subscribe,
    refreshCapabilities,
  }
}
