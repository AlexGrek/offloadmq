function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

export interface RunningJobItem {
  key: string
  source: string
  label: string
  status: string
  stage: string | null
  job_id: string
  offload_cap: string
  offload_task_id: string
  started_at?: string | null
  typical_runtime_seconds?: number | null
  submitted_at?: string | null
}

export interface RunningJobsResponse {
  jobs: RunningJobItem[]
}

export function fetchRunningImageJobs(token: string): Promise<RunningJobsResponse> {
  return fetch('/api/progress/running', { headers: authHeaders(token) }).then(async res => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
    }
    return res.json() as Promise<RunningJobsResponse>
  })
}
