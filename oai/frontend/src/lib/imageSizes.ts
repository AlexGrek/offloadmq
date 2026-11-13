export const IMAGE_SIZE_STORAGE_KEY = 'oai_image_size'
export type ImageSize = readonly [number, number]

export const IMAGE_SIZE_PRESETS: [number, number][] = [
  [512, 512], [768, 768], [1024, 1024], [1280, 1280], [1536, 1536], [2048, 2048],
  [768, 432], [768, 512], [1024, 576], [1024, 768], [1280, 720], [1536, 864], [1536, 1024], [1920, 1080], [2048, 1536],
  [432, 768], [512, 768], [576, 1024], [768, 1024], [720, 1280], [864, 1536], [1024, 1536], [1080, 1920], [1536, 2048],
]

export function validImageSize(width: number, height: number, max = 8192): boolean {
  return [width, height].every(n => Number.isInteger(n) && n > 0 && n <= max)
}

export function rememberedImageSize(fallback: ImageSize = [1024, 1024], max = 8192, min = 1): ImageSize {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(IMAGE_SIZE_STORAGE_KEY) ?? 'null')
    if (Array.isArray(value) && value.length === 2 && validImageSize(value[0], value[1], max) && value.every(n => n >= min)) return [value[0], value[1]]
  } catch { /* Invalid or unavailable storage uses the app default. */ }
  return fallback
}

export function rememberImageSize(width: number, height: number) {
  if (!validImageSize(width, height)) return
  try { localStorage.setItem(IMAGE_SIZE_STORAGE_KEY, JSON.stringify([width, height])) } catch { /* Storage may be disabled. */ }
}
