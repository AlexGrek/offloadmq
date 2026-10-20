import type { UploadedImage } from '../api/images'

/** Image handed off from another app's lightbox to a new run. */
export type ImageCycleRouteState = { cycleImage?: UploadedImage }
