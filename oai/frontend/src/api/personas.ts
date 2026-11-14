import { apiRequest as request } from './http'

/** Personas: `/api/personas/*` and `/api/persona-photos/*` (routes/personas.rs). */

export interface PersonaImageRef {
  image_id: string
  filename: string
  content_type: string
  width: number
  height: number
}

export interface EffectiveChoice {
  capability: string
  workflow?: string
  /** `preference` | `most_used` | `only` | `first_online` */
  source: string
  online: boolean
}

export interface EffectiveModels {
  llm: EffectiveChoice | null
  txt2img: EffectiveChoice | null
  img2img: EffectiveChoice | null
  face_swap: EffectiveChoice | null
  upscaler: EffectiveChoice | null
  errors: string[]
}

export interface Persona {
  id: string
  name: string
  system_prompt: string
  rendered_system_prompt: string
  look: string
  face_image_ids: string[]
  faces: PersonaImageRef[]
  llm_capability: string | null
  txt2img_capability: string | null
  img2img_capability: string | null
  face_swap_capability: string | null
  upscaler_capability: string | null
  /** Detail endpoint only. */
  effective?: EffectiveModels
  created_at: string
  updated_at: string
}

/** Create / full-replace body. Model fields: null = automatic. */
export interface PersonaInput {
  name: string
  system_prompt: string
  look: string
  face_image_ids: string[]
  llm_capability: string | null
  txt2img_capability: string | null
  img2img_capability: string | null
  face_swap_capability: string | null
  upscaler_capability: string | null
}

export type ModelSlot = 'llm' | 'txt2img' | 'img2img' | 'face_swap' | 'upscaler'

export const MODEL_SLOTS: { slot: ModelSlot; field: keyof PersonaInput; label: string }[] = [
  { slot: 'llm', field: 'llm_capability', label: 'Chat model' },
  { slot: 'txt2img', field: 'txt2img_capability', label: 'Txt2img model' },
  { slot: 'img2img', field: 'img2img_capability', label: 'Img2img model' },
  { slot: 'face_swap', field: 'face_swap_capability', label: 'Face swap' },
  { slot: 'upscaler', field: 'upscaler_capability', label: 'Upscaler' },
]

export interface ModelOption {
  capability: string
  workflow?: string
  online: boolean
}

export type ModelOptions = Record<ModelSlot, ModelOption[]> & { errors: string[] }

export const PERSONA_TOKENS = ['{p_name}', '{p_look}', '{p_system}'] as const

export function personaInputFrom(p: Persona): PersonaInput {
  return {
    name: p.name,
    system_prompt: p.system_prompt,
    look: p.look,
    face_image_ids: [...p.face_image_ids],
    llm_capability: p.llm_capability,
    txt2img_capability: p.txt2img_capability,
    img2img_capability: p.img2img_capability,
    face_swap_capability: p.face_swap_capability,
    upscaler_capability: p.upscaler_capability,
  }
}

export const EMPTY_PERSONA: PersonaInput = {
  name: '',
  system_prompt: '',
  look: '',
  face_image_ids: [],
  llm_capability: null,
  txt2img_capability: null,
  img2img_capability: null,
  face_swap_capability: null,
  upscaler_capability: null,
}

export function listPersonas(token: string): Promise<Persona[]> {
  return request('/api/personas', token)
}

export function getPersona(token: string, id: string, effective = true): Promise<Persona> {
  return request(`/api/personas/${encodeURIComponent(id)}${effective ? '' : '?effective=false'}`, token)
}

export function createPersona(token: string, input: PersonaInput): Promise<Persona> {
  return request('/api/personas', token, { method: 'POST', body: JSON.stringify(input) })
}

export function updatePersona(token: string, id: string, input: PersonaInput): Promise<Persona> {
  return request(`/api/personas/${encodeURIComponent(id)}`, token, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deletePersona(token: string, id: string): Promise<void> {
  return request(`/api/personas/${encodeURIComponent(id)}`, token, { method: 'DELETE' })
}

export function getPersonaModelOptions(token: string): Promise<ModelOptions> {
  return request('/api/personas/options', token)
}

// ── Photos ──────────────────────────────────────────────────────────────────

export type PhotoStepKind = 'generate' | 'face_swap' | 'upscale'

export interface PhotoStep {
  kind: PhotoStepKind
  /** Child-job status, plus `pending`, `submitting`, `skipped`. */
  status: string
  capability: string
  workflow: string
  child_job_id: string | null
  input_image_id: string | null
  output_image_id: string | null
  stage: string | null
  error: string | null
}

export interface PersonaPhoto {
  job_id: string
  persona_id: string
  status: string
  prompt_template: string
  prompt: string
  params: {
    workflow: string
    image_model: string
    width: number
    height: number
    face_image_id: string | null
    scale: number
  }
  steps: PhotoStep[]
  final_image_id: string | null
  /** Detail / poll only. */
  final_image: PersonaImageRef | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface StartPhotoRequest {
  prompt: string
  negative_prompt?: string
  workflow?: 'txt2img' | 'img2img'
  input_image_id?: string
  width?: number
  height?: number
  seed?: number
  count?: number
  face_image_id?: string
  face_swap?: boolean
  upscale?: boolean
  scale?: number
}

export const PHOTO_TERMINAL = new Set(['completed', 'failed', 'canceled'])

export function listPersonaPhotos(token: string, personaId: string): Promise<PersonaPhoto[]> {
  return request(`/api/personas/${encodeURIComponent(personaId)}/photos`, token)
}

export function startPersonaPhotos(
  token: string,
  personaId: string,
  req: StartPhotoRequest,
): Promise<{ job_ids: string[] }> {
  return request(`/api/personas/${encodeURIComponent(personaId)}/photos`, token, {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function pollPersonaPhoto(token: string, jobId: string): Promise<PersonaPhoto> {
  return request(`/api/persona-photos/${encodeURIComponent(jobId)}/poll`, token, { method: 'POST' })
}

export function cancelPersonaPhoto(token: string, jobId: string): Promise<PersonaPhoto> {
  return request(`/api/persona-photos/${encodeURIComponent(jobId)}/cancel`, token, { method: 'POST' })
}

export function retryPersonaPhoto(token: string, jobId: string): Promise<{ job_id: string }> {
  return request(`/api/persona-photos/${encodeURIComponent(jobId)}/retry`, token, { method: 'POST' })
}

export function deletePersonaPhoto(token: string, jobId: string): Promise<void> {
  return request(`/api/persona-photos/${encodeURIComponent(jobId)}`, token, { method: 'DELETE' })
}
