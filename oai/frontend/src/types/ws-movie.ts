// Mirrors backend ws/events.rs MovieClientCommand + shared ServerEvent.

import type { MovieJobView } from '../api/movie'
import type { LlmCapabilityInfo } from './ws'
import type { ServerEvent as BaseServerEvent } from './ws'

export type { ServerEvent, LlmCapabilityInfo } from './ws'
export type { MovieJobView, SceneView } from '../api/movie'

export type MovieClientCommand =
  | { type: 'list_capabilities'; req_id: string }
  | { type: 'watch_job'; req_id: string; job_id: string }
  | { type: 'ping' }

export type MovieServerEvent =
  | BaseServerEvent
  | {
      type: 'movie_capabilities'
      req_id: string
      llm: LlmCapabilityInfo[]
      video: LlmCapabilityInfo[]
    }
  | {
      type: 'movie:update'
      req_id: string
      job: MovieJobView
      terminal: boolean
    }

export type MovieCapability = import('./ws').LlmCapabilityInfo
