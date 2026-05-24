import { Loader2, Wifi, WifiOff } from 'lucide-react'

/** Compact WebSocket connection indicator for the chat header. */
export function WsStatusDot({ status }: { status: string }) {
  if (status === 'connected') return <Wifi className="size-3.5 text-emerald-500" />
  if (status === 'connecting') return <Loader2 className="size-3.5 text-amber-500 animate-spin" />
  return <WifiOff className="size-3.5 text-muted-foreground" />
}
