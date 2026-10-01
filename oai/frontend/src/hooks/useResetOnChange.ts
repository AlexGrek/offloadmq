import { useState } from 'react'

const UNSET = Symbol('unset')

/**
 * Calls `reset(key)` during render whenever `key` changes — React's "adjust
 * state when a prop changes" pattern, used instead of an effect that sets state,
 * so the reset lands before paint without an extra commit. On mount it runs only
 * for an active key (not `null`/`undefined`/`false`), so an idle component (a
 * closed dialog) mounts without a render-phase update. `reset` must only call
 * this component's state setters.
 */
export function useResetOnChange<K>(key: K, reset: (key: K) => void) {
  const [prev, setPrev] = useState<K | typeof UNSET>(() =>
    key == null || key === false ? key : UNSET,
  )
  if (!Object.is(prev, key)) {
    setPrev(key)
    reset(key)
  }
}
