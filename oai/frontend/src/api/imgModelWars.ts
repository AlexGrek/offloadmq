import { apiRequest as request } from './http'

/** Shared request: every model renders exactly this prompt and settings. */
export interface ImgModelWarParams {
  models: string[]
  /** Prompt sent to every model — frontend placeholders already expanded once. */
  prompt: string
  /** Raw textarea text before expansion (saved-prompt previews, Edit). */
  prompt_template?: string | null
  negative_prompt?: string | null
  override_negative: boolean
  width: number
  height: number
  seed?: number | null
}

export interface ImgModelWarSlot {
  model: string
  /** Ordinary image-generation job (also listed in Image Generation history). */
  child_job_id: string
  status: string
  stage: string | null
  /** Prompt the model actually received (`{?}` is expanded per model). */
  prompt: string | null
  error: string | null
  output_image_id: string | null
  output_width: number | null
  output_height: number | null
  submitted_at: string | null
  started_at: string | null
  typical_runtime_seconds: number | null
  execution_seconds: number | null
}

export interface ImgModelWarJob {
  job_id: string
  status: string
  params: ImgModelWarParams
  slots: ImgModelWarSlot[]
  error: string | null
  created_at: string
  updated_at: string
}

const base = '/api/img-model-wars/jobs'

export const startImgModelWar = (token: string, params: ImgModelWarParams) =>
  request<{ job_id: string; status: string }>(base, token, {
    method: 'POST',
    body: JSON.stringify(params),
  })

export const listImgModelWars = (token: string) => request<ImgModelWarJob[]>(base, token)

export const getImgModelWar = (token: string, id: string) =>
  request<ImgModelWarJob>(`${base}/${encodeURIComponent(id)}`, token)

export const cancelImgModelWar = (token: string, id: string) =>
  request<ImgModelWarJob>(`${base}/${encodeURIComponent(id)}/cancel`, token, { method: 'POST' })

export const retryImgModelWar = (token: string, id: string) =>
  request<{ job_id: string; status: string }>(`${base}/${encodeURIComponent(id)}/retry`, token, {
    method: 'POST',
  })

export const deleteImgModelWar = (token: string, id: string) =>
  request<void>(`${base}/${encodeURIComponent(id)}`, token, { method: 'DELETE' })
