export const IMAGE_SIZE_STORAGE_KEY = 'oai_image_size'
/** Video generation keeps its own remembered size, so an image preference never leaks into it. */
export const VIDEO_SIZE_STORAGE_KEY = 'oai_video_size'
export type ImageSize = readonly [number, number]

/** Video default; used whenever no (valid) video size has been remembered. */
export const DEFAULT_VIDEO_SIZE: ImageSize = [768, 768]

/** Video presets: video models are run well below 1024px, so most chips are smaller than that. */
export const VIDEO_SIZE_PRESETS: [number, number][] = [
  [512, 512], [640, 640], [768, 768], [1024, 1024],
  [512, 768], [480, 832], [576, 1024], [720, 1280],
  [768, 512], [832, 480], [1024, 576], [1280, 720],
]

export const IMAGE_SIZE_PRESETS: [number, number][] = [
  [1024, 1024], [1280, 1280], [1536, 1536], [2048, 2048],
  [1536, 1024], [1920, 1080], [2048, 1536],
  [1024, 1536], [1080, 1920], [1536, 2048],
]

export function validImageSize(width: number, height: number, max = 8192): boolean {
  return [width, height].every(n => Number.isInteger(n) && n > 0 && n <= max)
}

export function rememberedImageSize(fallback: ImageSize = [1024, 1024], max = 8192, min = 1, key = IMAGE_SIZE_STORAGE_KEY): ImageSize {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (Array.isArray(value) && value.length === 2 && validImageSize(value[0], value[1], max) && value.every(n => n >= min)) return [value[0], value[1]]
  } catch { /* Invalid or unavailable storage uses the app default. */ }
  return fallback
}

export function rememberImageSize(width: number, height: number, key = IMAGE_SIZE_STORAGE_KEY) {
  if (!validImageSize(width, height)) return
  try { localStorage.setItem(key, JSON.stringify([width, height])) } catch { /* Storage may be disabled. */ }
}
