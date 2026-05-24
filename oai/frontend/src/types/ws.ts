// Mirrors the Rust ws/events.rs types exactly.

export interface LlmCapabilityInfo {
  base: string    // "llm.mistral"
  tags: string[]  // ["7b", "quantized"]
  raw: string     // "llm.mistral[7b;quantized]"
  online: boolean
  last_available_at: string // RFC3339 — last time OffloadMQ reported this model online
}

// ── Server → Client ──────────────────────────────────────────────────────────

export type ServerEvent =
  | { type: 'hello'; user_id: number }
  | { type: 'pong' }
  | { type: 'capabilities'; req_id: string; capabilities: LlmCapabilityInfo[] }
  | { type: 'task:queued'; req_id: string; cap: string; id: string }
  | { type: 'task:progress'; req_id: string; cap: string; id: string; status: string; stage?: string; log?: string }
  | { type: 'task:result'; req_id: string; cap: string; id: string; text: string; log?: string }
  | { type: 'task:failed'; req_id: string; cap: string; id: string; error: string; log?: string }
  | { type: 'error'; req_id?: string; message: string }

// ── Client → Server ──────────────────────────────────────────────────────────

export type ClientCommand =
  | { type: 'list_capabilities'; req_id: string }
  | { type: 'chat'; req_id: string; capability: string; chat_id: string; content: string; timeout_secs?: number; max_wait_secs?: number; runtime_secs?: number }
  | { type: 'ping' }
