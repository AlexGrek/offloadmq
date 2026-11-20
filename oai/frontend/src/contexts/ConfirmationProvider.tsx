import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { AlertDialog } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { ConfirmationContext, type ConfirmationOptions } from './ConfirmationContext'

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null)
  const pending = useRef<((accepted: boolean) => void) | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const location = useLocation()

  const finish = useCallback((accepted: boolean) => {
    const resolve = pending.current
    pending.current = null
    setOptions(null)
    resolve?.(accepted)
  }, [])

  const confirm = useCallback((next: ConfirmationOptions): Promise<boolean> => {
    // A second click must not replace an unanswered confirmation.
    if (pending.current) return Promise.resolve(false)
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOptions(next)
    return new Promise(resolve => { pending.current = resolve })
  }, [])

  // Never carry a pending destructive action across navigation or unmount.
  useEffect(() => () => finish(false), [location, finish])

  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root open={options !== null} onOpenChange={open => { if (!open) finish(false) }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-[2px]" />
          <AlertDialog.Content
            className="fixed left-1/2 top-1/2 z-[100] w-[calc(100%-1.5rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background shadow-xl outline-none"
            data-testid="confirmation-dialog"
            onCloseAutoFocus={event => {
              event.preventDefault()
              if (opener.current?.isConnected) opener.current.focus()
            }}
          >
            <div className="space-y-2 px-4 py-4">
              <AlertDialog.Title className="font-display text-base font-semibold">{options?.title}</AlertDialog.Title>
              <AlertDialog.Description className="max-h-[50dvh] overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {options?.description}
              </AlertDialog.Description>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline" className="min-h-11" data-testid="confirmation-cancel">Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button type="button" variant="destructive" className="min-h-11" onClick={() => finish(true)} data-testid="confirmation-accept">
                  {options?.confirmLabel ?? 'Delete'}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmationContext.Provider>
  )
}
