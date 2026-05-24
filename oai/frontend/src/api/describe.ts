export interface DescribeCapability {
  base: string
  tags: string[]
  raw: string
}

export interface DescribeSubmitResponse {
  cap: string
  id: string
}

export interface DescribePollResponse {
  status: string
  stage?: string | null
  output?: unknown
  log?: string | null
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
  return res.json() as Promise<T>
}

export function listDescribeCapabilities(
  token: string,
): Promise<{ capabilities: DescribeCapability[] }> {
  return request('/api/describe/capabilities', token)
}

export function submitDescribeTask(
  token: string,
  capability: string,
  prompt: string,
  image: File,
): Promise<DescribeSubmitResponse> {
  const form = new FormData()
  form.append('capability', capability)
  form.append('prompt', prompt)
  form.append('image', image)
  return request('/api/describe/submit', token, { method: 'POST', body: form })
}

export function pollDescribeTask(
  token: string,
  cap: string,
  id: string,
): Promise<DescribePollResponse> {
  return request('/api/describe/poll', token, {
    method: 'POST',
    body: JSON.stringify({ cap, id }),
  })
}
