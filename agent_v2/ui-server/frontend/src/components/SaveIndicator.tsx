import { Check, Loader2 } from "lucide-react";

import type { SaveStatus } from "@/hooks/useDebouncedSave";

export function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === "saving")
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Saving…
      </span>
    );
  if (status === "saved")
    return (
      <span className="flex items-center gap-1 text-xs text-green-500">
        <Check className="size-3" /> Saved
      </span>
    );
  return null;
}
