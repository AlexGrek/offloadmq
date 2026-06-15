// Mirrors backend ws/events.rs DebateClientCommand + shared ServerEvent.

import type { LlmDebateJob } from '../api/llmDebate'
import type { ServerEvent as BaseServerEvent } from './ws'

export type { ServerEvent, LlmCapabilityInfo } from './ws'

export type DebateClientCommand =
  | { type: 'list_capabilities'; req_id: string }
  | { type: 'watch_job'; req_id: string; job_id: string }
  | { type: 'ping' }

export type DebateServerEvent =
  | BaseServerEvent
  | {
      type: 'debate:update'
      req_id: string
      job: LlmDebateJob
      terminal: boolean
    }

export type DebateCapability = import('./ws').LlmCapabilityInfo
