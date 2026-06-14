/**
 * Prompt generator types — generation runs over WebSocket (`useWsPromptGen`).
 * REST `/api/promptgen/*` routes remain on the backend for compatibility.
 */
export type {
  LlmCapabilityInfo,
  PromptGenCapability,
  PromptGenClientCommand,
  PromptGenServerEvent,
  PromptGenTaskId,
  ServerEvent,
} from '../types/ws-promptgen'
