import { useCallback, useEffect, useRef, useState } from "react";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

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
  error: string | null;
} {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ value: T } | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  // Guards state updates after unmount — the in-flight request itself is
  // still allowed to complete (see the unmount cleanup below).
  const alive = useRef(true);

  const run = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!pending.current) return;
    const { value } = pending.current;
    pending.current = null;
    if (alive.current) setStatus("saving");
    try {
      await saveRef.current(value);
      if (!alive.current) return;
      setError(null);
      setStatus("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setStatus("idle"), 1500);
    } catch (e) {
      if (!alive.current) return;
      // Surface the failure instead of silently resetting to "idle" (which
      // looks identical to "nothing happened" and hides that the edit was
      // never persisted).
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
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

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      // A value typed and then immediately navigated away from (before the
      // debounce timer or a blur/Enter flush fires) would otherwise be
      // silently discarded. Fire it now — the request outlives the
      // component, we just can't react to its result anymore.
      if (pending.current) {
        const { value } = pending.current;
        pending.current = null;
        void saveRef.current(value);
      }
    };
  }, []);

  return { schedule, flush, status, error };
}
