/**
 * Identity-preserving updates for polled job lists.
 *
 * Job pages re-fetch the same jobs every few seconds. Swapping in the fresh
 * objects unconditionally re-renders every row (and the whole page) even when
 * nothing moved; these helpers keep the previous object whenever a job's
 * fingerprint is unchanged, so memoized views and `setState` bail out.
 */

type Job = { job_id: string }

/** `next` unless it has the same id and fingerprint as `prev`. */
export function keepIfUnchanged<T extends Job>(
  prev: T | null | undefined,
  next: T,
  fingerprint: (job: T) => string,
): T {
  return prev && prev.job_id === next.job_id && fingerprint(prev) === fingerprint(next)
    ? prev
    : next
}

/**
 * Reconciles a freshly fetched list with the current one: unchanged jobs keep
 * their previous object, and if nothing changed at all `prev` itself is returned.
 */
export function mergeJobList<T extends Job>(
  prev: T[],
  next: T[],
  fingerprint: (job: T) => string,
): T[] {
  const byId = new Map(prev.map(j => [j.job_id, j]))
  let changed = prev.length !== next.length
  const merged = next.map((job, i) => {
    const kept = keepIfUnchanged(byId.get(job.job_id), job, fingerprint)
    if (kept !== prev[i]) changed = true
    return kept
  })
  return changed ? merged : prev
}

/**
 * Puts one fetched job into a newest-first list: replaces it in place (keeping
 * identity when unchanged) or prepends it if it is new.
 */
export function upsertJob<T extends Job>(
  prev: T[],
  job: T,
  fingerprint: (job: T) => string,
): T[] {
  const idx = prev.findIndex(j => j.job_id === job.job_id)
  if (idx < 0) return [job, ...prev]
  const kept = keepIfUnchanged(prev[idx], job, fingerprint)
  if (kept === prev[idx]) return prev
  const next = [...prev]
  next[idx] = kept
  return next
}
