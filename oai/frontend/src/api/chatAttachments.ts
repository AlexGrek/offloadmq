import { uploadImage } from './images'

export const MAX_ATTACHMENTS_PER_MESSAGE = 10
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024

/** Document extensions the offload agent extracts text from. */
export const DOCUMENT_EXTENSIONS = [
  'pdf', 'txt', 'md', 'csv', 'json', 'xml', 'yml', 'yaml', 'log',
] as const

export const DOCUMENT_ACCEPT = DOCUMENT_EXTENSIONS.map(e => `.${e}`).join(',')

export interface ChatAttachment {
  id: string
  kind: 'image' | 'document'
  filename: string
  content_type: string
  size_bytes: number
  /** image_files id for image attachments (used to build preview URLs). */
  image_id: string | null
  created_at: string
}

interface AttachmentResponse {
  attachment: ChatAttachment
}

async function request<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const isFormData = options?.body instanceof FormData
  const headers = new Headers(options?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (!isFormData) headers.set('Content-Type', 'application/json')
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** Uploads a new image (via the shared image store) and wraps it as a chat attachment. */
export async function uploadImageAttachment(token: string, file: File): Promise<ChatAttachment> {
  const img = await uploadImage(token, file)
  return createImageAttachment(token, img.image_id)
}

/** References an existing image_files row (uploaded or AI-generated) as an attachment. */
export async function createImageAttachment(
  token: string,
  imageId: string,
): Promise<ChatAttachment> {
  const res = await request<AttachmentResponse>('/api/chat/attachments/image', token, {
    method: 'POST',
    body: JSON.stringify({ image_id: imageId }),
  })
  return res.attachment
}

/** Uploads a new document and records it as a chat attachment. */
export async function uploadDocumentAttachment(
  token: string,
  file: File,
): Promise<ChatAttachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await request<AttachmentResponse>('/api/chat/attachments/upload', token, {
    method: 'POST',
    body: form,
  })
  return res.attachment
}

/** Re-references a previously uploaded document as a fresh attachment. */
export async function referenceDocumentAttachment(
  token: string,
  attachmentId: string,
): Promise<ChatAttachment> {
  const res = await request<AttachmentResponse>('/api/chat/attachments/reference', token, {
    method: 'POST',
    body: JSON.stringify({ attachment_id: attachmentId }),
  })
  return res.attachment
}

/** Lists the user's previously uploaded documents (for the reference picker). */
export async function listChatDocuments(token: string): Promise<ChatAttachment[]> {
  const res = await request<{ documents: ChatAttachment[] }>(
    '/api/chat/attachments/documents',
    token,
  )
  return res.documents
}

/** URL for a document attachment's bytes — JWT travels in `?token=`. */
export function documentDownloadUrl(
  attachmentId: string,
  token: string | null | undefined,
): string {
  const base = `/api/chat/attachments/${encodeURIComponent(attachmentId)}/download`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

/** True when the filename has a supported document extension. */
export function isSupportedDocument(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * Re-references a set of attachments as fresh, unlinked rows so they can be
 * re-staged into a new task bucket (used on retry — already-linked rows won't
 * re-stage). Images re-reference their image_files row; documents re-reference
 * the stored bytes.
 */
export async function cloneAttachmentsForResend(
  token: string,
  attachments: ChatAttachment[],
): Promise<ChatAttachment[]> {
  return Promise.all(
    attachments.map(att =>
      att.kind === 'image' && att.image_id
        ? createImageAttachment(token, att.image_id)
        : referenceDocumentAttachment(token, att.id),
    ),
  )
}
