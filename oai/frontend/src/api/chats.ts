import type { ChatAttachment } from './chatAttachments'
import { apiRequest as request } from './http'

/** `chat` = LLM Chat, `prompt_studio` = Prompt Studio session. Same API, separate lists. */
export type ChatKind = 'chat' | 'prompt_studio'

export interface ChatSummary {
  id: string
  title: string
  system_prompt: string
  last_model: string | null
  kind?: ChatKind
  created_at: string
  updated_at: string
}

export interface ChatMessageRecord {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  status: 'complete' | 'failed' | 'thinking' | 'pending'
  model: string | null
  created_at: string
  attachments?: ChatAttachment[]
}

export function listChats(token: string, kind: ChatKind = 'chat'): Promise<ChatSummary[]> {
  return request(`/api/chats?kind=${kind}`, token)
}

export function createChat(
  token: string,
  options?: { systemPrompt?: string; lastModel?: string | null; kind?: ChatKind; title?: string },
): Promise<ChatSummary> {
  const body: { system_prompt?: string; last_model?: string; kind?: ChatKind; title?: string } = {}
  if (options?.kind) body.kind = options.kind
  const sp = options?.systemPrompt?.trim()
  if (sp) body.system_prompt = sp
  const title = options?.title?.trim()
  if (title) body.title = title
  const lm = options?.lastModel?.trim()
  if (lm) body.last_model = lm
  return request('/api/chats', token, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateChatLastModel(
  token: string,
  chatId: string,
  capability: string,
): Promise<ChatSummary> {
  return request(`/api/chats/${chatId}/last-model`, token, {
    method: 'PATCH',
    body: JSON.stringify({ capability }),
  })
}

export function updateChatSystemPrompt(
  token: string,
  chatId: string,
  content: string,
): Promise<ChatSummary> {
  return request(`/api/chats/${chatId}/system-prompt`, token, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  })
}

export function deleteChat(token: string, chatId: string): Promise<void> {
  return request(`/api/chats/${chatId}`, token, { method: 'DELETE' })
}

export function getChatMessages(token: string, chatId: string): Promise<ChatMessageRecord[]> {
  return request(`/api/chats/${chatId}/messages`, token)
}
