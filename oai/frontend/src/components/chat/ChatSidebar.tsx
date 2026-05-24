import { Loader2, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ChatSummary } from '@/api/chats'

/** Collapsible chat list: fixed header + independently scrollable list. */
export function ChatSidebar({
  open,
  chats,
  activeChatId,
  loading,
  runningChatIds,
  onSelectChat,
  onNewChat,
  onDeleteChat,
}: {
  open: boolean
  chats: ChatSummary[]
  activeChatId: string | null
  loading: boolean
  runningChatIds: Set<string>
  onSelectChat: (id: string) => void
  onNewChat: () => void
  onDeleteChat: (e: React.MouseEvent, id: string) => void
}) {
  return (
    <aside
      className={cn(
        'flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar',
        'transition-[width] duration-200',
        open ? 'w-64' : 'w-0',
      )}
      data-testid="chat-sidebar"
    >
      <div className="flex items-center justify-between px-3 h-11 border-b border-border shrink-0">
        <span className="text-sm font-semibold text-sidebar-foreground">Chats</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onNewChat}
          title="New chat"
          data-testid="new-chat-btn"
        >
          <Pencil />
        </Button>
      </div>

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
            No chats yet
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
                    {chat.title || 'New chat'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={(e) => onDeleteChat(e, chat.id)}
                  title="Delete chat"
                  aria-label={`Delete chat ${chat.title || 'New chat'}`}
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
    </aside>
  )
}
