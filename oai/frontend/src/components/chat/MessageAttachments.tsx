import { FileText } from 'lucide-react'
import type { ChatAttachment } from '@/api/chatAttachments'
import { documentDownloadUrl } from '@/api/chatAttachments'
import { imageFileUrl, imageThumbnailUrl } from '@/api/images'
import { cn } from '@/lib/utils'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Renders a message's attachments: image thumbnails (open full-size) + document chips. */
export function MessageAttachments({
  attachments,
  token,
  align = 'start',
}: {
  attachments: ChatAttachment[]
  token: string | null
  align?: 'start' | 'end'
}) {
  if (attachments.length === 0) return null
  const images = attachments.filter(a => a.kind === 'image' && a.image_id)
  const docs = attachments.filter(a => a.kind === 'document')

  return (
    <div
      className={cn('flex flex-col gap-2', align === 'end' ? 'items-end' : 'items-start')}
      data-testid="message-attachments"
    >
      {images.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', align === 'end' ? 'justify-end' : 'justify-start')}>
          {images.map(att => (
            <a
              key={att.id}
              href={imageFileUrl(att.image_id!, token)}
              target="_blank"
              rel="noopener noreferrer"
              title={att.filename}
              className="block size-20 overflow-hidden rounded-lg border border-border bg-muted transition-opacity hover:opacity-90"
              data-testid={`attachment-image-${att.id}`}
            >
              <img
                src={imageThumbnailUrl(att.image_id!, token)}
                alt={att.filename}
                className="size-full object-cover"
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}
      {docs.map(att => (
        <a
          key={att.id}
          href={documentDownloadUrl(att.id, token)}
          target="_blank"
          rel="noopener noreferrer"
          title={att.filename}
          className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-xs transition-colors hover:bg-muted"
          data-testid={`attachment-doc-${att.id}`}
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{att.filename}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(att.size_bytes)}</span>
        </a>
      ))}
    </div>
  )
}
