import { Loader2, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ToolSidebar } from '@/components/ToolSidebar'
import type { ChatSummary } from '@/api/chats'

export type ChatSidebarLabels = {
  title: string
  newItem: string
  empty: string
  untitled: string
  delete: string
}

const DEFAULT_LABELS: ChatSidebarLabels = {
  title: 'Chats',
  newItem: 'New chat',
  empty: 'No chats yet',
  untitled: 'New chat',
  delete: 'Delete chat',
}

/**
 * Chat list: fixed header + independently scrollable list.
 * Desktop: inline collapsible column (w-64 / w-0).
 * Mobile: full-screen overlay over the page content; auto-hides on select.
 */
export function ChatSidebar({
  open,
  isMobile,
  chats,
  activeChatId,
  loading,
  runningChatIds,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onClose,
  labels = DEFAULT_LABELS,
}: {
  open: boolean
  isMobile: boolean
  chats: ChatSummary[]
  activeChatId: string | null
  loading: boolean
  runningChatIds: Set<string>
  onSelectChat: (id: string) => void
  onNewChat: () => void
  onDeleteChat: (e: React.MouseEvent, id: string) => void
  onClose: () => void
  /** Wording for the list (Prompt Studio says "session"). */
  labels?: ChatSidebarLabels
}) {
  return (
    <ToolSidebar
      title={labels.title}
      open={open}
      isMobile={isMobile}
      onClose={onClose}
      testId="chat-sidebar"
      headerAction={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onNewChat}
          title={labels.newItem}
          aria-label={labels.newItem}
          data-testid="new-chat-btn"
        >
          <Pencil />
        </Button>
      }
    >
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 px-1"
        data-testid="chat-sidebar-list"
      >
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : chats.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4 px-3">
            {labels.empty}
          </p>
        ) : (
          chats.map(chat => {
            const inProgress = runningChatIds.has(chat.id)
            return (
              <div
                key={chat.id}
                className={cn(
                  'group/chat-item flex items-center rounded-lg transition-colors',
                  chat.id === activeChatId
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'hover:bg-sidebar-accent/50 text-sidebar-foreground',
                )}
                data-in-progress={inProgress || undefined}
              >
                <button
                  type="button"
                  onClick={() => onSelectChat(chat.id)}
                  data-testid={`chat-item-${chat.id}`}
                  aria-busy={inProgress}
                  className="flex flex-1 items-center gap-2 min-w-0 px-3 py-2 text-left"
                >
                  {inProgress ? (
                    <Loader2
                      className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                      aria-hidden
                      data-testid={`chat-item-${chat.id}-loader`}
                    />
                  ) : null}
                  <span className="truncate text-sm leading-tight min-w-0 flex-1">
                    {chat.title || labels.untitled}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={(e) => onDeleteChat(e, chat.id)}
                  title={labels.delete}
                  aria-label={`${labels.delete} ${chat.title || labels.untitled}`}
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
            )
          })
        )}
      </div>
    </ToolSidebar>
  )
}
