const EXPOSED_LABELS = new Set([
  'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
  'ANUS_EXPOSED',
  'BUTTOCKS_EXPOSED',
  'BELLY_EXPOSED',
  'MALE_BREAST_EXPOSED',
  'FEET_EXPOSED',
  'ARMPITS_EXPOSED',
])

const FACE_LABELS = new Set(['FACE_FEMALE', 'FACE_MALE'])

export const DEFAULT_NUDENET_THRESHOLD = 0.25

export function nudeLabelColor(label: string): string {
  if (EXPOSED_LABELS.has(label)) return 'text-red-500'
  if (FACE_LABELS.has(label)) return 'text-blue-500'
  return 'text-amber-500'
}

export function nudeLabelBgColor(label: string): string {
  if (EXPOSED_LABELS.has(label)) return 'bg-red-500/15 text-red-600 dark:text-red-400'
  if (FACE_LABELS.has(label)) return 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
  return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
}

export function nudeLabelShort(label: string): string {
  return label.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

export function hasExposedDetections(
  detections: { label: string }[] | undefined,
): boolean {
  return detections?.some(d => EXPOSED_LABELS.has(d.label)) ?? false
}

export function resultBorderClass(
  error: string | undefined,
  detectionCount: number,
  detections: { label: string }[] | undefined,
): string {
  if (error) return 'border-l-red-500'
  if (hasExposedDetections(detections)) return 'border-l-red-500'
  if (detectionCount > 0) return 'border-l-amber-500'
  return 'border-l-emerald-500'
}

export function totalDetectionCount(
  result: { results?: { detection_count: number }[] } | null | undefined,
): number {
  return result?.results?.reduce((sum, r) => sum + r.detection_count, 0) ?? 0
}
