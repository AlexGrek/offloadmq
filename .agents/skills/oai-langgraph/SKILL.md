---
name: oai-langgraph
description: OAI LangGraph app at /app/langgraph: Python/code editors, pyproject dependencies, prompts, input models, unsafe LLM runtime tasks, history and artifacts. Read before editing LangGraph feature files; stack with oai-backend/frontend/itests as applicable.
---

# OAI LangGraph

Read `docs/oai-langgraph.md` and `docs/llm-runtime-api.md` before changing the
contract. Reuse the existing OffloadMQ runtime; never execute Python on OAI itself.
Runner runtime enablement plus exact sensitive capability approvals are mandatory.

- Backend: `services/langgraph.rs`, `routes/langgraph.rs`, `db/langgraph.rs`,
  `db/entities/langgraph_jobs.rs`, `jobs/langgraph_worker.rs`, `offload/runtime.rs`.
- Frontend: `pages/LanggraphPage.tsx`, `api/langgraph.ts`,
  `components/langgraph/CodeEditor.tsx`, `lib/langgraph/defaults.ts`.
- Tests: `itests/tests/test_langgraph.py`, `e2e/tests/langgraph.spec.ts`.

Use `JobReconciler` and `OffloadJobEntity` for lifecycle. Each run snapshots the
entire request as JSON text. List responses omit source/results. Primary model
comes from the selected runtime capability; named roles go in payload.models.
The scheduler requires every selected runtime model on one approved runner.

Parse pyproject TOML in OAI; only project.dependencies is installed by the runner.
Unsupported build/tool/uv/extras/groups settings must fail explicitly. The runner
uses Python 3.11. Defaults expose a dummy tool, validate the allowlist, and print
the final LLM answer; they must remain runnable with the documented stdin contract.

Preserve stdout/stderr on terminal failures via on_poll. Download successful
artifacts before marking completed; then the generic driver deletes the output
bucket. Blob paths use `image_paths::langgraph_artifact_path`, indexed numeric slots.
Only the job owner can download; serve attachment/octet-stream with nosniff.
Deletion is terminal-only and cleans all declared slots, including partial writes.

Drafts are browser-local and per user. History viewing preserves the draft;
Edit as new replaces it. Models use online selects, never free text. System/user
prompts reuse `langgraph-system` / `langgraph-user` library buckets. Keep CodeMirror
behind a lazy page import so its dependencies do not inflate every OAI page.

Run cargo test, frontend build/lint, LangGraph integration tests against the live
backend, and Playwright. Live runtime integration tests skip only when no runtime
capability is available; use an isolated runner config for execution tests.
