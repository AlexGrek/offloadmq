import { useEffect, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { useAuth } from '@/contexts/AuthContext'
import { listFiles, type UserFile } from '@/api/files'
import {
  createImageAttachment,
  listChatDocuments,
  referenceDocumentAttachment,
  type ChatAttachment,
} from '@/api/chatAttachments'
import { cn } from '@/lib/utils'

type Tab = 'images' | 'documents'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Modal to reference an existing image (uploaded/generated) or prior document. */
export function AttachmentReferencePicker({
  open,
  onOpenChange,
  onPick,
  disabled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (attachment: ChatAttachment) => void
  disabled?: boolean
}) {
  const { token } = useAuth()
  const [tab, setTab] = useState<Tab>('images')
  const [images, setImages] = useState<UserFile[]>([])
  const [documents, setDocuments] = useState<ChatAttachment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !token) return
    let active = true
    setLoading(true)
    setError(null)
    Promise.all([listFiles(token), listChatDocuments(token)])
      .then(([files, docs]) => {
        if (!active) return
        setImages(files.files.filter(f => f.is_image))
        setDocuments(docs)
      })
      .catch(err => {
        if (active) setError((err as Error).message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, token])

  async function pickImage(file: UserFile) {
    if (!token || disabled) return
    setBusyId(file.id)
    setError(null)
    try {
      const att = await createImageAttachment(token, file.id)
      onPick(att)
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function pickDocument(doc: ChatAttachment) {
    if (!token || disabled) return
    setBusyId(doc.id)
    setError(null)
    try {
      const att = await referenceDocumentAttachment(token, doc.id)
      onPick(att)
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Attach from your files</DialogTitle>
          <DialogDescription>
            Reference an uploaded or generated image, or a document you uploaded before.
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 gap-1 border-b border-border px-4 pt-2">
          {(['images', 'documents'] as Tab[]).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize transition-colors',
                tab === t
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              data-testid={`ref-picker-tab-${t}`}
            >
              {t}
            </button>
          ))}
        </div>

        <DialogBody>
          {loading ? (
            <div className="flex min-h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <p className="text-sm text-destructive" data-testid="ref-picker-error">{error}</p>
          ) : tab === 'images' ? (
            images.length === 0 ? (
              <p className="text-sm text-muted-foreground">No images yet. Upload or generate one first.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {images.map(file => (
                  <button
                    key={file.id}
                    type="button"
                    disabled={busyId != null}
                    onClick={() => void pickImage(file)}
                    title={file.filename}
                    className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted transition-opacity hover:opacity-90 disabled:opacity-50"
                    data-testid={`ref-picker-image-${file.id}`}
                  >
                    <img
                      src={file.thumbnail_url}
                      alt={file.filename}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                    {busyId === file.id && (
                      <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                        <Loader2 className="size-4 animate-spin" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )
          ) : documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {documents.map(doc => (
                <button
                  key={doc.id}
                  type="button"
                  disabled={busyId != null}
                  onClick={() => void pickDocument(doc)}
                  className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
                  data-testid={`ref-picker-doc-${doc.id}`}
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium">{doc.filename}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(doc.size_bytes)}
                  </span>
                  {busyId === doc.id && <Loader2 className="size-4 shrink-0 animate-spin" />}
                </button>
              ))}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
