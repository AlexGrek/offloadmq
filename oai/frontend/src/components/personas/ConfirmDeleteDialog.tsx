import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Props = {
  open: boolean
  title: string
  description: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  testIdPrefix: string
}

/** In-app replacement for `window.confirm` on destructive persona actions. */
export function ConfirmDeleteDialog({ open, title, description, busy, onConfirm, onCancel, testIdPrefix }: Props) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !busy) onCancel() }}>
      <DialogContent className="sm:max-w-sm" data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>{null}</DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy} data-testid={`${testIdPrefix}-cancel`}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy} data-testid={`${testIdPrefix}-confirm`}>
            {busy && <Loader2 className="animate-spin" />} Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
