import { motion } from 'framer-motion'
import { ArrowUp, FileText, FolderOpen, ImageIcon, Loader2, Plus, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { CapabilitiesStatus } from '@/lib/capabilitiesStatus'
import type { LlmCapabilityInfo } from '@/types/ws'
import type { ChatAttachment } from '@/api/chatAttachments'
import { DOCUMENT_ACCEPT } from '@/api/chatAttachments'
import { imageThumbnailUrl } from '@/api/images'
import { useAuth } from '@/contexts/AuthContext'
import { ModelPicker } from './ModelPicker'

/** Pinned message composer: auto-growing textarea, attachments, model picker, send/cancel. */
export function ChatComposer({
  value,
  onChange,
  onSend,
  wsStatus,
  hasActiveChat,
  capabilities,
  selectedModel,
  onModelSelect,
  onRefreshCapabilities,
  capabilitiesStatus,
  capabilitiesError,
  isGenerating,
  canSend,
  canCancelTask,
  onCancel,
  attachments,
  attaching,
  attachError,
  attachDisabled,
  onUploadImages,
  onUploadDocuments,
  onRemoveAttachment,
  onOpenReferencePicker,
  visionWarning,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  wsStatus: string
  hasActiveChat: boolean
  capabilities: LlmCapabilityInfo[]
  selectedModel: string | null
  onModelSelect: (base: string) => void
  onRefreshCapabilities: () => void
  capabilitiesStatus: CapabilitiesStatus
  capabilitiesError: string | null
  isGenerating: boolean
  canSend: boolean
  canCancelTask: boolean
  onCancel: () => void
  attachments: ChatAttachment[]
  attaching: boolean
  attachError: string | null
  attachDisabled: boolean
  onUploadImages: (files: File[]) => void
  onUploadDocuments: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
  onOpenReferencePicker: () => void
  visionWarning: string | null
}) {
  const { token } = useAuth()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const docInputRef = useRef<HTMLInputElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [value])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  function pickFiles(ref: React.RefObject<HTMLInputElement | null>) {
    setMenuOpen(false)
    ref.current?.click()
  }

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 pb-4 pt-2">
      <div className="max-w-2xl mx-auto">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={e => {
            const files = Array.from(e.target.files ?? [])
            if (files.length) onUploadImages(files)
            e.target.value = ''
          }}
        />
        <input
          ref={docInputRef}
          type="file"
          accept={DOCUMENT_ACCEPT}
          multiple
          hidden
          onChange={e => {
            const files = Array.from(e.target.files ?? [])
            if (files.length) onUploadDocuments(files)
            e.target.value = ''
          }}
        />

        <div
          className="group/input-group rounded-2xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
          data-testid="chat-input-box"
        >
          {(attachments.length > 0 || attaching) && (
            <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="composer-attachments">
              {attachments.map(att => (
                <AttachmentChip
                  key={att.id}
                  attachment={att}
                  token={token}
                  onRemove={() => onRemoveAttachment(att.id)}
                />
              ))}
              {attaching && (
                <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Uploading…
                </div>
              )}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              !hasActiveChat ? 'Select or create a chat first' :
              wsStatus === 'connected' ? 'Message…' : 'Connecting…'
            }
            disabled={wsStatus !== 'connected' || !hasActiveChat}
            rows={1}
            data-testid="chat-input"
            className="block w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
            style={{ minHeight: '44px', maxHeight: '200px' }}
          />

          <div className="flex items-center gap-2 px-2 pb-2">
            <div className="relative shrink-0">
              <Button
                variant="outline"
                size="icon-xs"
                title={attachDisabled ? 'Attachment limit reached' : 'Attach files'}
                className="rounded-full"
                disabled={!hasActiveChat || attachDisabled}
                onClick={() => setMenuOpen(v => !v)}
                data-testid="chat-attach-btn"
              >
                <Plus />
              </Button>
              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setMenuOpen(false)}
                    aria-hidden
                  />
                  <div className="absolute bottom-full left-0 z-20 mb-2 w-48 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
                    <MenuItem icon={<ImageIcon className="size-4" />} label="Upload image" onClick={() => pickFiles(imageInputRef)} testId="attach-upload-image" />
                    <MenuItem icon={<FileText className="size-4" />} label="Upload document" onClick={() => pickFiles(docInputRef)} testId="attach-upload-doc" />
                    <MenuItem icon={<FolderOpen className="size-4" />} label="From your files" onClick={() => { setMenuOpen(false); onOpenReferencePicker() }} testId="attach-reference" />
                  </div>
                </>
              )}
            </div>

            <ModelPicker
              capabilities={capabilities}
              selected={selectedModel}
              onSelect={onModelSelect}
              onRefresh={onRefreshCapabilities}
              wsStatus={wsStatus}
              capabilitiesStatus={capabilitiesStatus}
              capabilitiesError={capabilitiesError}
            />

            <span className="flex-1" />

            {isGenerating ? (
              <motion.button
                type="button"
                onClick={onCancel}
                disabled={!canCancelTask}
                aria-label="Cancel"
                data-testid="chat-cancel-btn"
                title={canCancelTask ? 'Cancel response' : 'Waiting for task id…'}
                whileTap={canCancelTask ? { scale: 0.85 } : undefined}
                className={cn(
                  'size-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                  canCancelTask
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed',
                )}
              >
                <Square className="size-3.5 fill-current" />
              </motion.button>
            ) : (
              <motion.button
                onClick={onSend}
                disabled={!canSend}
                aria-label="Send"
                data-testid="send-btn"
                whileTap={canSend ? { scale: 0.85 } : undefined}
                className={cn(
                  'size-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                  canSend
                    ? 'bg-foreground text-background hover:bg-foreground/80'
                    : 'bg-muted text-muted-foreground cursor-not-allowed',
                )}
              >
                <ArrowUp className="size-4" />
              </motion.button>
            )}
          </div>
        </div>

        {attachError && (
          <p className="mt-2 text-center text-xs text-destructive" data-testid="composer-attach-error">
            {attachError}
          </p>
        )}
        {visionWarning && (
          <p className="mt-2 text-center text-xs text-amber-600 dark:text-amber-500" data-testid="composer-vision-warning">
            {visionWarning}
          </p>
        )}
        <p className="text-center text-xs text-muted-foreground mt-2 select-none">
          Shift+Enter for new line · Enter to send
        </p>
      </div>
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  testId,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-popover-foreground transition-colors hover:bg-muted"
    >
      {icon}
      {label}
    </button>
  )
}

function AttachmentChip({
  attachment,
  token,
  onRemove,
}: {
  attachment: ChatAttachment
  token: string | null
  onRemove: () => void
}) {
  const isImage = attachment.kind === 'image' && attachment.image_id
  return (
    <div
      className="group relative flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 py-1 pl-1 pr-1.5"
      data-testid={`composer-chip-${attachment.id}`}
    >
      {isImage ? (
        <img
          src={imageThumbnailUrl(attachment.image_id!, token)}
          alt={attachment.filename}
          className="size-8 rounded object-cover"
        />
      ) : (
        <span className="flex size-8 items-center justify-center rounded bg-background">
          <FileText className="size-4 text-muted-foreground" />
        </span>
      )}
      <span className="max-w-[8rem] truncate text-xs font-medium" title={attachment.filename}>
        {attachment.filename}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.filename}`}
        className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        data-testid={`composer-chip-remove-${attachment.id}`}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
