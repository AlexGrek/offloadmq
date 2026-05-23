import { useEffect, useRef, useState } from "react";

export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = []
): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedFn = useRef(fn);
  savedFn.current = fn;

  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const result = await savedFn.current();
        if (alive) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    run();
    const id = setInterval(run, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, refresh };
}
