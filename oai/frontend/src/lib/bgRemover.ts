import type { BgRemoverJob, BgRemoverOptions } from '../api/bgRemover'

/** Friendly names and one-line guidance for the models in `docs/bgremove-api.md`.
 *  Unknown models (a future agent) fall back to their capability slug. */
const MODEL_INFO: Record<string, { label: string; hint: string }> = {
  'birefnet-general': {
    label: 'BiRefNet General',
    hint: 'Best all-round: anime and photos, and it keeps held props like staffs and bows.',
  },
  'birefnet-portrait': {
    label: 'BiRefNet Portrait',
    hint: 'People only. Hair edges are slightly softer and held props tend to be dropped.',
  },
  'birefnet-lite': {
    label: 'BiRefNet Lite',
    hint: 'Smallest and fastest. Can miss thin props and keep background objects.',
  },
}

export function modelLabel(model: string): string {
  return MODEL_INFO[model]?.label ?? model
}

export function modelHint(model: string): string {
  return MODEL_INFO[model]?.hint ?? 'Background-removal model installed on an agent.'
}

/** Below this the model found (almost) no subject; above `HIGH_RATIO` it kept (almost) everything. */
const LOW_RATIO = 0.01
const HIGH_RATIO = 0.95

/** A hint when the result looks wrong, per the guidance in `docs/bgremove-api.md`; null when fine.
 *  A cropped result is mostly subject by construction, so "kept everything" does not apply. */
export function foregroundWarning(job: BgRemoverJob): string | null {
  const ratio = job.foreground_ratio
  if (job.status !== 'completed' || ratio == null) return null
  if (ratio < LOW_RATIO) {
    return 'Almost nothing was kept — the model may not have found a subject. Try another model.'
  }
  if (ratio > HIGH_RATIO && !job.options.crop) {
    return 'Almost everything was kept — the background may not have been removed. Try another model.'
  }
  return null
}

/** `PNG · transparent · cropped +16 px` — what a job produced, for the detail header. */
export function describeBgOptions(o: BgRemoverOptions): string {
  const parts: string[] = [o.format.toUpperCase()]
  parts.push(o.background === 'transparent' ? 'transparent' : `on ${o.background.toUpperCase()}`)
  if (o.crop) parts.push(o.padding > 0 ? `cropped +${o.padding} px` : 'cropped')
  if (o.alpha_threshold != null) parts.push(`hard edge ${o.alpha_threshold}`)
  if (!o.refine_foreground) parts.push('raw edge colours')
  return parts.join(' · ')
}

const PREFS_KEY = 'oai_bgremover_prefs'

export interface BgRemoverPrefs {
  model: string
  options: BgRemoverOptions
}

/** Last-used model + options. UI convenience only: a stale model is ignored when it is
 *  no longer online, and options are re-validated on submit. */
export function readBgRemoverPrefs(): Partial<BgRemoverPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Partial<BgRemoverPrefs>) : {}
  } catch {
    return {}
  }
}

export function writeBgRemoverPrefs(prefs: BgRemoverPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // best-effort — the pick just won't survive a reload
  }
}
