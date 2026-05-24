import { ArrowUp, Loader2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Message } from '@/lib/chat/messages'
import { ChatMessageItem } from './ChatMessageItem'
import { SystemPromptBlock } from './SystemPromptBlock'
import { SystemPromptStudio } from './SystemPromptStudio'

/** Scrollable message region: empty-state prompt studio, loader, or the transcript. */
export function ChatTranscript({
  scrollRef,
  messagesEndRef,
  onScroll,
  onWheel,
  showScrollBtn,
  onScrollToBottom,
  token,
  showSystemStudio,
  loadingMessages,
  hasActiveChat,
  systemPrompt,
  onSystemPromptChange,
  onApplySystemPrompt,
  onNewChat,
  messages,
  canRetry,
  onRetry,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
  onWheel: (e: React.WheelEvent<HTMLDivElement>) => void
  showScrollBtn: boolean
  onScrollToBottom: () => void
  token: string | null
  showSystemStudio: boolean
  loadingMessages: boolean
  hasActiveChat: boolean
  systemPrompt: string
  onSystemPromptChange: (value: string) => void
  onApplySystemPrompt: (content: string) => Promise<void>
  onNewChat: () => void
  messages: Message[]
  canRetry: boolean
  onRetry: () => void
}) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      onWheel={onWheel}
      className="relative min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain"
      data-testid="messages-area"
    >
      {!token ? null : showSystemStudio ? (
        <div className="flex flex-col items-center px-4 py-8">
          <SystemPromptStudio
            token={token}
            value={systemPrompt}
            onChange={onSystemPromptChange}
            onApply={onApplySystemPrompt}
            compact={hasActiveChat}
          />
          {hasActiveChat ? (
            <p className="mt-6 max-w-md text-center text-xs text-muted-foreground">
              Send your first message below — the model will follow this system prompt.
            </p>
          ) : (
            <Button variant="outline" size="sm" className="mt-4" onClick={() => void onNewChat()}>
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
          {messages.map((msg, idx) => (
            <ChatMessageItem
              key={msg.id}
              msg={msg}
              showRetry={idx === messages.length - 1 && canRetry}
              onRetry={onRetry}
            />
          ))}
          <div ref={messagesEndRef} className="h-px shrink-0" aria-hidden />
        </div>
      )}

      {showScrollBtn && (
        <div className="sticky bottom-4 flex justify-center pointer-events-none">
          <Button
            size="icon-sm"
            variant="outline"
            onClick={onScrollToBottom}
            title="Scroll to bottom"
            className="pointer-events-auto shadow-md"
          >
            <ArrowUp className="rotate-180" />
          </Button>
        </div>
      )}
    </div>
  )
}
