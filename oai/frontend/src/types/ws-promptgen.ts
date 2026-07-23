// Mirrors backend ws/events.rs PromptGenClientCommand + shared ServerEvent.

import type { ServerEvent } from './ws'

export type { ServerEvent, LlmCapabilityInfo } from './ws'

export type PromptGenClientCommand =
  | { type: 'list_capabilities'; req_id: string }
  | {
      type: 'generate_prompt'
      req_id: string
      mode: string
      capability: string
      query: string
      prompt: string
    }
  | {
      type: 'generate_video_prompt'
      req_id: string
      capability: string
      /** OAI image id (snowflake, as string) of the uploaded frame. */
      image_id: string
    }
  | { type: 'ping' }

export interface PromptGenTaskId {
  cap: string
  id: string
}

export type PromptGenCapability = import('./ws').LlmCapabilityInfo

export type PromptGenServerEvent = ServerEvent
