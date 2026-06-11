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
import {
  listChatDocuments,
  referenceDocumentAttachment,
  type ChatAttachment,
} from '@/api/chatAttachments'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Modal to reference a previously uploaded document. */
export function DocumentReferencePicker({
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
  const [documents, setDocuments] = useState<ChatAttachment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !token) return
    let active = true
    setLoading(true)
    setError(null)
    listChatDocuments(token)
      .then(docs => {
        if (active) setDocuments(docs)
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
          <DialogTitle>Attach document</DialogTitle>
          <DialogDescription>
            Reference a document you uploaded before.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {loading ? (
            <div className="flex min-h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <p className="text-sm text-destructive" data-testid="doc-picker-error">{error}</p>
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
                  data-testid={`doc-picker-item-${doc.id}`}
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
