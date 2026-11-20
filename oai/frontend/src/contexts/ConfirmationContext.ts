import { createContext, useContext } from 'react'

export type ConfirmationOptions = {
  title: string
  description: string
  confirmLabel?: string
}

export const ConfirmationContext = createContext<((options: ConfirmationOptions) => Promise<boolean>) | null>(null)

export function useConfirmation() {
  const confirm = useContext(ConfirmationContext)
  if (!confirm) throw new Error('useConfirmation requires ConfirmationProvider')
  return confirm
}
