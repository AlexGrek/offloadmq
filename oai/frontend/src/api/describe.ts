export interface DescribeCapability {
  base: string
  tags: string[]
  raw: string
}

export interface DescribeJob {
  job_id: string
  status: string
  prompt: string
  capability: string
  input_image_id: string | null
  result: string | null
  stage: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
  created_at: string
  updated_at: string
}

export interface StartDescribeJobRequest {
  capability: string
  prompt: string
  image_id: string
  /** OffloadMQ `dataPreparation` map (glob → action) to rescale the image before analysis. */
  data_preparation?: Record<string, string> | null
}

export interface StartDescribeJobResponse {
  job_id: string
  status: string
}

export interface CancelDescribeJobResponse {
  job_id: string
  status: string
  message: string
}

async function request<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const isFormData = options?.body instanceof FormData
  const headers = new Headers(options?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (!isFormData) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) {
    return undefined as T
  }
  return res.json() as Promise<T>
}

export function listDescribeCapabilities(
  token: string,
): Promise<{ capabilities: DescribeCapability[] }> {
  return request('/api/describe/capabilities', token)
}

export function startDescribeJob(
  token: string,
  payload: StartDescribeJobRequest,
): Promise<StartDescribeJobResponse> {
  return request('/api/describe/jobs', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listDescribeJobs(token: string): Promise<DescribeJob[]> {
  return request('/api/describe/jobs', token)
}

export function getDescribeJob(token: string, jobId: string): Promise<DescribeJob> {
  return request(`/api/describe/jobs/${encodeURIComponent(jobId)}`, token)
}

export function pollDescribeJob(token: string, jobId: string): Promise<DescribeJob> {
  return request(`/api/describe/jobs/${encodeURIComponent(jobId)}/poll`, token, {
    method: 'POST',
  })
}

export function cancelDescribeJob(
  token: string,
  jobId: string,
): Promise<CancelDescribeJobResponse> {
  return request(`/api/describe/jobs/${encodeURIComponent(jobId)}/cancel`, token, {
    method: 'POST',
  })
}

export function retryDescribeJob(
  token: string,
  jobId: string,
): Promise<StartDescribeJobResponse> {
  return request(`/api/describe/jobs/${encodeURIComponent(jobId)}/retry`, token, {
    method: 'POST',
  })
}

export function deleteDescribeJob(token: string, jobId: string): Promise<void> {
  return request(`/api/describe/jobs/${encodeURIComponent(jobId)}`, token, {
    method: 'DELETE',
  })
}
