# Agent Transport Migration Guide

This document explains how to migrate the `offload-agent` task plane from HTTP polling/reporting to other protocols (WebSocket, gRPC, custom binary, etc.) with minimal code churn.

## Goal

Decouple task lifecycle logic from HTTP transport so protocol changes only affect transport adapters, not executor/business logic.

## Current Baseline

A transport seam now exists in:

- `offload-agent/app/transport.py`
  - `AgentTransport` protocol
  - `HttpAgentTransport` implementation
- `offload-agent/app/core.py`
  - main task loop (`poll_task`, `take_task`, `serve_tasks`) now uses `AgentTransport`
- `offload-agent/app/exec/helpers.py`
  - progress/resolve reporting can use transport-native APIs
  - temporary compatibility fallback still allows legacy `HttpClient` callers

This means the core loop is no longer tightly coupled to raw HTTP route calls.

## Transport Contract

Any new protocol implementation should satisfy the `AgentTransport` surface:

- `poll_task(timeout=...) -> dict[str, Any]`
- `take_task(raw_id, raw_cap, timeout=...) -> dict[str, Any]`
- `post_task_progress(task_id, report, timeout=...) -> ResponseLike`
- `post_task_result(report, timeout=...) -> ResponseLike`
- `upload_file(bucket_uid, filename, content, content_type, timeout=...) -> str`
- optional passthrough `get/post` methods if needed by transitional code

Behavioral expectations:

- Preserve cancellation semantics (`499` equivalent).
- Raise protocol-specific errors that map cleanly to retry/permanent categories.
- Keep payload shapes identical to server API schema (`TaskProgressReport.to_wire()`, `TaskResultReport.to_wire()`).

## Migration Strategy (Phased)

### Phase 1 - Stabilize Interface (done)

- Introduce `AgentTransport`.
- Route core polling/take path through transport.
- Keep HTTP implementation as default.

### Phase 2 - Remove Legacy Reporting Fallback (done)

All executors and helper callsites now accept/pass `AgentTransport` instead of `HttpClient`:

- All `offload-agent/app/exec/*.py` executors: parameter renamed `http: HttpClient` → `transport: AgentTransport`
- All `offload-agent/app/exec/imggen/*.py` files: same migration
- `offload-agent/app/exec/helpers.py`: `ReportClient` simplified to `AgentTransport`, `hasattr` fallbacks removed
- `offload-agent/app/capabilities.py`: `rescan_and_push()` accepts `AgentTransport`
- `offload-agent/app/httphelpers.py`: `update_agent_capabilities()` accepts `AgentTransport`
- `offload-agent/app/core.py`: rescan scheduler uses `HttpAgentTransport` instead of `HttpClient`
- `offload-agent/app/exec/imggen/output.py`: direct `http.base`/`http.headers` access replaced with `transport.upload_file()`
- `AgentTransport` protocol extended with `upload_file()` method for bucket file uploads

`HttpClient` is now an implementation detail of `HttpAgentTransport` only — no executor or helper imports it.

### Phase 3 - Introduce Second Protocol Adapter

Add e.g. `WebSocketAgentTransport` in `app/transport_ws.py` (or within `transport.py`):

- maintain task stream subscription (push or request/response)
- implement ack/take semantics atomically
- map server cancel event -> local `TaskCancelled` behavior
- support progress/result frames with delivery confirmation

### Phase 4 - Runtime Selection

Select transport in startup/config:

- config key example: `"transport": "http" | "ws" | "custom"`
- CLI/WebUI option for protocol
- factory method (example): `build_transport(config) -> AgentTransport`

### Phase 5 - Reliability Hardening

- Backoff/retry policy per protocol
- reconnect strategy (especially WS)
- in-flight progress buffering and replay guarantees
- idempotency for `take`, `progress`, and `resolve`

## Suggested Directory Layout

- `app/transport.py` - protocol + shared types/factory
- `app/transport_http.py` - HTTP implementation (optional split)
- `app/transport_ws.py` - WebSocket implementation
- `app/transport_custom.py` - custom protocol implementation

Keeping one file per transport reduces merge conflicts and makes testing easier.

## Error Mapping Guidance

Define a small, protocol-agnostic error model:

- `AuthRejected` (maps to HTTP `403`, WS auth close code, etc.)
- `TaskCancelledRemote` (maps to HTTP `499`, cancel frame/event)
- `TransientTransportError` (retryable)
- `PermanentTransportError` (non-retryable)

Then map protocol-specific failures into these categories inside each adapter.

## Testing Plan

Minimum coverage before enabling non-HTTP transport in production:

- Unit tests for each transport adapter method:
  - payload shape
  - timeout behavior
  - error mapping
- Integration test:
  - poll -> take -> execute -> progress -> resolve
  - cancellation mid-task
  - reconnect during active workload
- Regression tests:
  - ensure HTTP behavior remains unchanged when `transport=http`

## Rollout Plan

1. Land executor signature migration (`AgentTransport` everywhere).
2. Land second adapter behind feature flag.
3. Enable in dev only.
4. Enable for canary agents.
5. Promote to default only after success/error parity with HTTP.

## Definition of Done

- No executor or helper depends on `HttpClient` directly for task-plane operations.
- Transport selected via config/factory.
- At least two transport implementations pass the same lifecycle integration tests.
- HTTP remains backward-compatible as a first-class adapter.
