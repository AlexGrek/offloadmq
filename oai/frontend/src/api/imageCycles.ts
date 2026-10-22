import { apiRequest as request } from './http'

export interface ImageCycleParams {
  expected_quality?: number | null
  max_steps?: number | null
  bootstrap_model?: string | null
  improvement_workflow?: 'img2img' | 'txt2img'
  initial_prompt: string | null
  input_image_id: string | null
  describe_prompt: string
  vision_model: string
  image_model: string
  cycles: number
  width: number
  height: number
}
export interface ImageCycleModelChanges {
  vision_model?: string
  image_model?: string
  bootstrap_model?: string
}
export interface ImageCycleStep {
  cycle: number
  model?: string | null
  reused?: boolean
  kind: 'describe' | 'generate'
  status: string
  prompt: string
  input_image_id: string | null
  output_image_id: string | null
  result: string | null
  child_job_id: string | null
  stage: string | null
  error: string | null
  quality?: number | null
  improve_prompt?: string | null
}
export interface ImageCycleJob {
  job_id: string
  app?: 'image-cycles' | 'generator-improver'
  stop_reason?: 'target_reached' | 'max_steps_reached' | null
  status: string
  params: ImageCycleParams
  steps: ImageCycleStep[]
  error: string | null
  created_at: string
  updated_at: string
}
function createApi(app: string) {
  const root = `/api/${app}/jobs`
  const path = (id: string) => `${root}/${encodeURIComponent(id)}`
  return {
    listImageCycles: (token: string) => request<ImageCycleJob[]>(root, token),
    getImageCycle: (token: string, id: string) =>
      request<ImageCycleJob>(path(id), token),
    pollImageCycle: (token: string, id: string) =>
      request<ImageCycleJob>(`${path(id)}/poll`, token, { method: 'POST' }),
    cancelImageCycle: (token: string, id: string) =>
      request<ImageCycleJob>(`${path(id)}/cancel`, token, { method: 'POST' }),
    pauseImageCycle: (token: string, id: string) =>
      request<ImageCycleJob>(`${path(id)}/pause`, token, { method: 'POST' }),
    resumeImageCycle: (token: string, id: string) =>
      request<ImageCycleJob>(`${path(id)}/resume`, token, { method: 'POST' }),
    restartImageCycle: (token: string, id: string) =>
      request<{ job_id: string; status: string }>(
        `${path(id)}/restart`,
        token,
        { method: 'POST' },
      ),
    restartImageCycleFromStep: (token: string, id: string, index: number) =>
      request<{ job_id: string; status: string }>(
        `${path(id)}/steps/${index}/restart`,
        token,
        { method: 'POST' },
      ),
    updateImageCycleModels: (
      token: string,
      id: string,
      models: ImageCycleModelChanges,
    ) =>
      request<ImageCycleJob>(`${path(id)}/models`, token, {
        method: 'PATCH',
        body: JSON.stringify(models),
      }),
    updateImageCycleVisionPrompt: (
      token: string,
      id: string,
      describePrompt: string,
    ) =>
      request<ImageCycleJob>(`${path(id)}/vision-prompt`, token, {
        method: 'PATCH',
        body: JSON.stringify({ describe_prompt: describePrompt }),
      }),
    deleteImageCycle: (token: string, id: string) =>
      request<void>(path(id), token, { method: 'DELETE' }),
    retryImageCycle: (token: string, id: string) =>
      request<{ job_id: string; status: string }>(`${path(id)}/retry`, token, {
        method: 'POST',
      }),
    startImageCycle: (token: string, params: ImageCycleParams) =>
      request<{ job_id: string; status: string }>(root, token, {
        method: 'POST',
        body: JSON.stringify(params),
      }),
  }
}
const cyclesApi = createApi('image-cycles')
const improverApi = createApi('generator-improver')
export const imageCycleApi = (improver: boolean) =>
  improver ? improverApi : cyclesApi
