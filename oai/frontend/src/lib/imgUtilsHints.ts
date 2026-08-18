import { RESIZE_WORKFLOW } from '../api/imgUtils'

/** Short blurb per known operation; unknown ones fall back to a generic line.
 *  Keyed on the operation (`depth`), not the pack directory — packs are named
 *  after the model (`image_lotus_depth_v1_1`). */
const OPERATION_HINTS: Record<string, string> = {
  depth: 'Estimate a depth map from the image.',
  face_swap: 'Replace the face in the target image with the face from the reference image.',
  upscale: 'Upscale the image with SeedVR2 by the chosen multiplier.',
  [RESIZE_WORKFLOW]:
    'Scale the image with Pillow — no GPU or ComfyUI needed, so any online agent can run it.',
}

export function operationHint(workflow: string): string {
  return OPERATION_HINTS[workflow] ?? 'Run this ComfyUI transform on the uploaded image.'
}
