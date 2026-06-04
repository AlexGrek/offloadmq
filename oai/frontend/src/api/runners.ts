import { apiRequest as request } from './http'

export interface RunnerSummary {
  uid: string
  uid_short: string
  display_name: string | null
  tier: number
  capacity: number
  last_contact: string | null
  capabilities: string[]
}

export interface ListRunnersResponse {
  runners: RunnerSummary[]
}

export function listOnlineRunners(token: string): Promise<ListRunnersResponse> {
  return request('/api/runners/online', token)
}
