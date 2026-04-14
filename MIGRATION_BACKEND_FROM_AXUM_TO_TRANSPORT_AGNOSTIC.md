# Backend Migration Plan: Axum to Transport-Agnostic Core

This plan defines how to decouple backend business logic from Axum endpoint types so the system can support alternate protocols (WebSocket, gRPC, internal RPC, custom gateways) without rewriting core scheduling/storage logic.

## Objectives

- Keep core queue/domain logic independent of HTTP framework concerns.
- Restrict Axum-specific code to adapter layers (`api/*`, middleware, response mappers).
- Create clean service boundaries usable by any transport.
- Preserve behavior and compatibility with existing HTTP API during migration.

## Scope

In scope:

- `src/api/client/*`, `src/api/agent/*`
- `src/mq/*` (especially scheduler functions leaking response types)
- `src/error.rs` and error mapping
- auth middleware and request extraction boundaries

Out of scope (for this migration):

- changing API payload schemas
- replacing Axum now
- changing persistence engines (Sled/OpenDAL)

## Current Coupling Gaps

1. `src/mq/scheduler.rs` has business function(s) returning Axum response types.
2. `src/api/client/mod.rs` embeds substantial business rules in handlers.
3. `src/error.rs` mixes domain error model with Axum `IntoResponse`.
4. `apikey_auth_middleware_user` parses JSON body in middleware (transport-shape coupling).

## Target Architecture

- **Domain/Core** (no Axum imports)
  - scheduling decisions
  - task lifecycle transitions
  - bucket ownership/use invariants
  - cancellation policy
- **Service Layer** (no Axum imports)
  - orchestrates domain + storage for specific workflows
  - returns domain DTOs / result enums
- **Transport Adapter Layer** (Axum only)
  - request extraction/validation
  - map service results to HTTP status + JSON shape
  - middleware and protocol-specific auth extraction

## Phased Plan

### Phase 0 - Baseline and Safety Nets

- Add integration tests for current behavior:
  - urgent submit blocking response behavior
  - non-urgent submit/poll/cancel lifecycle
  - bucket ownership + `rm_after_task` constraints
  - cancel-requested semantics for assigned tasks
- Add regression tests for known status mapping (`403`, `404`, `409`, `499`).

Exit criteria:

- Tests capture existing behavior before refactor.

### Phase 1 - Extract Client Service Layer

Create `src/api/client/service.rs` with pure-Rust service functions:

- `submit_task(...) -> ClientSubmitResult`
- `submit_task_blocking(...) -> ClientBlockingResult`
- `poll_task_status(...) -> TaskStatusResult`
- `cancel_task(...) -> CancelResult`
- `validate_file_buckets(...) -> Result<(), DomainError>`

Move business rules from `src/api/client/mod.rs` into this service:

- bucket ownership validation
- `rm_after_task` constraint checks
- cancel transition logic
- queued->canceled conversion logic

Keep handlers thin:

- parse request/extractors
- call service
- map result to HTTP response

Exit criteria:

- `src/api/client/mod.rs` mostly adapter glue.
- No domain transitions in handler bodies.

### Phase 2 - Remove Axum Types from Scheduler/Core

Refactor `src/mq/scheduler.rs`:

- change `submit_urgent_task(...)` return type from `impl IntoResponse` to domain enum, e.g.:
  - `UrgentSubmitOutcome::Completed(AssignedTask)`
  - `UrgentSubmitOutcome::CompletedWithoutAssignment { id, status, message }`
- move JSON/HTTP response shaping to client adapter layer (`api/client/mod.rs`).

Audit `mq` for any remaining Axum imports and remove them.

Exit criteria:

- `src/mq/*` has zero Axum imports.

### Phase 3 - Split Domain Errors from HTTP Mapping

Refactor error handling:

- Keep `AppError` (or introduce `DomainError`) as framework-agnostic.
- Move `IntoResponse` implementation and status mapping to adapter module:
  - e.g. `src/api/http_error.rs` with `HttpError(AppError)`.

Guideline:

- core/service returns domain errors only.
- adapters decide protocol status codes and payload envelopes.

Exit criteria:

- core/service modules do not depend on Axum error traits.

### Phase 4 - Normalize Auth Boundaries

Refactor `apikey_auth_middleware_user`:

- avoid parsing JSON payload in middleware.
- preferred path: use header-based key extraction for all relevant routes.
- if body-key compatibility must remain, implement a dedicated extractor in adapter layer instead of global middleware body parsing.

Exit criteria:

- middleware only handles protocol-level concerns (headers/tokens/extensions), not request-body schema.

### Phase 5 - Introduce Transport-Neutral Service Contracts

Define explicit service contracts and DTOs that can be used by non-HTTP adapters:

- task submission command/result types
- task polling/cancellation query/result types
- capability list query/result types

Optional:

- add `src/ports/` or `src/services/` module boundaries for stable interfaces.

Exit criteria:

- creating a new transport adapter requires no changes in `mq`/`db` logic.

### Phase 6 - Add Secondary Adapter (Pilot)

Implement one non-Axum-facing adapter path (e.g. internal RPC service or WS gateway) that calls the same services.

Use parity tests:

- same commands -> same domain/service outcomes as HTTP.

Exit criteria:

- at least one non-HTTP adapter proven against parity tests.

## Suggested Deliverable Sequence (PRs)

1. Tests only baseline PR.
2. Client service extraction PR.
3. Scheduler de-Axum PR.
4. Error mapping split PR.
5. Auth boundary cleanup PR.
6. Secondary adapter pilot PR.

Each PR should be behavior-neutral and independently releasable.

## Risk Management

- **Behavior drift risk:** mitigate with parity tests and snapshot-like response assertions.
- **Large refactor risk:** keep PRs narrow and phase-gated.
- **Client compatibility risk:** preserve HTTP payload shape/status codes until explicitly versioned.
- **Operational risk:** feature flags for any new adapter path.

## Definition of Done

- `src/mq/*` and service modules contain no Axum imports.
- Client and agent handlers are thin adapters only.
- Error model is protocol-agnostic; HTTP mapping isolated.
- Auth middleware no longer depends on JSON body schema.
- Existing HTTP API behavior remains unchanged.
- One alternate adapter path can invoke core services without touching scheduler/storage internals.
