import { useCallback, useEffect, useRef, useState } from "react";

export type SaveStatus = "idle" | "saving" | "saved";

/**
 * Auto-save helper: debounces saves while typing and exposes flush() for
 * blur/Enter so focus changes never drop an edit. The latest scheduled value
 * wins, so rapid edits collapse into a single save.
 */
export function useDebouncedSave<T>(
  save: (value: T) => Promise<unknown> | unknown,
  delay = 600
): {
  schedule: (value: T) => void;
  flush: () => void;
  status: SaveStatus;
} {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ value: T } | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const run = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!pending.current) return;
    const { value } = pending.current;
    pending.current = null;
    setStatus("saving");
    try {
      await saveRef.current(value);
      setStatus("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setStatus("idle"), 1500);
    } catch {
      setStatus("idle");
    }
  }, []);

  const schedule = useCallback(
    (value: T) => {
      pending.current = { value };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void run(), delay);
    },
    [delay, run]
  );

  const flush = useCallback(() => void run(), [run]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    []
  );

  return { schedule, flush, status };
}
