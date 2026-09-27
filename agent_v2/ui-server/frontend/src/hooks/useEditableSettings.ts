import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { useDebouncedSave, type SaveStatus } from "./useDebouncedSave";

/**
 * Shared "load a form from the server, edit fields locally, auto-save on a
 * debounce" wiring used by every settings-style page (Connection, Settings,
 * Kokoro, ...): load once on mount, merge partial edits into local state, and
 * schedule the *full* merged value through {@link useDebouncedSave}.
 *
 * `load` receives the underlying `schedule` function so a loader can persist
 * a derived default (e.g. an auto-generated display name) immediately after
 * fetching, the same way a plain edit would.
 */
export function useEditableSettings<T>(
  initial: T,
  load: (schedule: (value: T) => void) => Promise<T>,
  save: (value: T) => Promise<unknown> | unknown,
  delay = 600
): {
  form: T;
  setForm: Dispatch<SetStateAction<T>>;
  edit: (patch: Partial<T>) => void;
  flush: () => void;
  status: SaveStatus;
  error: string | null;
} {
  const [form, setForm] = useState<T>(initial);
  const { schedule, flush, status, error } = useDebouncedSave<T>(save, delay);

  useEffect(() => {
    load(schedule).then(setForm);
    // Runs once on mount — `load`/`schedule` are expected to be stable
    // (schedule is; load is typically an inline closure over api.* calls).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const edit = (patch: Partial<T>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      schedule(next);
      return next;
    });
  };

  return { form, setForm, edit, flush, status, error };
}
