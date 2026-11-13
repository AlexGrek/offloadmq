import { apiRequest } from '@/api/http'
import { recordRecentPrompt } from '@/api/prompts'
import type { ChatSummary } from '@/api/chats'
import type { ServerEvent } from '@/types/ws'
import { extractPrompt, PROMPT_STUDIO_TEMPLATE_BUCKET } from './promptStudio'
import type { WallpaperJobProgress } from './hallucinate'

export class WallpaperCancellationError extends Error {}

export interface WallpaperPromptSettings {
  capability: string
  systemPrompt: string
  template: string
}

/** A saved studio conversation, owned by one wallpaper run. Each turn has its own socket. */
export function wallpaperPromptGenerator(token: string, settings: WallpaperPromptSettings) {
  let chatId: string | undefined
  return async (content: string, signal: AbortSignal, report: (patch: Partial<WallpaperJobProgress>) => void) => {
    signal.throwIfAborted()
    if (!chatId) {
      await recordRecentPrompt(token, PROMPT_STUDIO_TEMPLATE_BUCKET, settings.template, AbortSignal.any([signal, AbortSignal.timeout(15000)]))
      signal.throwIfAborted()
      const chat = await apiRequest<ChatSummary>('/api/chats', token, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ kind: 'prompt_studio', system_prompt: settings.systemPrompt, last_model: settings.capability }),
      })
      chatId = chat.id
      signal.throwIfAborted()
    }
    return new Promise<string>((resolve, reject) => {
      const url = new URL('/api/ws/chat', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('token', token)
      const socket = new WebSocket(url)
      const reqId = `wallpaper-${crypto.randomUUID()}`
      let task: { cap: string; id: string } | undefined
      let startedAt: string | null = null
      let sent = false
      let settled = false
      let canceling = false
      let abortTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: unknown, text?: string) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        clearTimeout(abortTimer)
        clearInterval(heartbeat)
        signal.removeEventListener('abort', abort)
        socket.close()
        if (error) reject(error)
        else resolve(text ?? '')
      }
      const cancel = async () => {
        if (!task || canceling || settled) return
        canceling = true
        clearTimeout(abortTimer)
        try {
          await apiRequest(`/api/tasks/cancel/${encodeURIComponent(task.cap)}/${encodeURIComponent(task.id)}`, token, {
            method: 'POST', signal: AbortSignal.timeout(15000),
          })
          finish(signal.reason ?? new Error('Prompt generation stopped'))
        } catch (error) {
          finish(new WallpaperCancellationError(`Prompt cancellation failed: ${String(error)}`))
        }
      }
      const abort = () => {
        if (!sent) { finish(signal.reason); return }
        if (task) { void cancel(); return }
        // Keep listening for a late queued ID so Pause can cancel a racing submission.
        abortTimer = setTimeout(() => finish(new WallpaperCancellationError('Prompt submission did not return a task ID; it may finish in Prompt Studio history.')), 15000)
      }
      const deadline = setTimeout(() => {
        if (task) {
          void apiRequest(`/api/tasks/cancel/${encodeURIComponent(task.cap)}/${encodeURIComponent(task.id)}`, token, {
            method: 'POST', signal: AbortSignal.timeout(15000),
          }).catch(() => {})
        }
        finish(new Error('Prompt generation timed out. Check Prompt Studio history before retrying.'))
      }, 330000)
      const heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
      }, 25000)
      signal.addEventListener('abort', abort, { once: true })
      socket.onopen = () => {
        if (signal.aborted) { finish(signal.reason); return }
        sent = true
        socket.send(JSON.stringify({ type: 'chat', req_id: reqId, chat_id: chatId, capability: settings.capability, content, model_online: true }))
      }
      socket.onmessage = event => {
        let message: ServerEvent
        try { message = JSON.parse(event.data as string) as ServerEvent } catch { return }
        if (!('req_id' in message) || message.req_id !== reqId) return
        if (message.type === 'task:queued' || message.type === 'task:progress') {
          task = { cap: message.cap, id: message.id }
          if (message.type === 'task:progress' && message.status === 'running' && !startedAt) startedAt = new Date().toISOString()
          report({ startedAt, jobId: message.id, status: signal.aborted ? 'cancelRequested' : message.type === 'task:queued' ? 'queued' : message.status,
            ...(message.type === 'task:progress' ? { stage: message.stage ?? null } : {}) })
          if (signal.aborted) void cancel()
        } else if (message.type === 'task:result') {
          if (signal.aborted) { finish(signal.reason); return }
          const prompt = extractPrompt(message.text)
          if (!prompt) { finish(new Error('The LLM returned an empty image prompt.')); return }
          report({ status: 'completed', finishedAt: new Date().toISOString() })
          finish(undefined, prompt)
        } else if (message.type === 'task:failed' || message.type === 'error') {
          finish(signal.aborted ? signal.reason : new Error(message.type === 'error' ? message.message : message.error))
        }
      }
      socket.onerror = () => finish(new Error('Prompt connection failed. Check Prompt Studio history before retrying.'))
      socket.onclose = () => finish(new Error('Prompt connection closed. Check Prompt Studio history before retrying.'))
    })
  }
}
