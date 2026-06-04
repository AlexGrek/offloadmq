//! Server-initiated task dispatch — the heart of the push model.
//!
//! When work becomes available (a task is submitted) or an agent frees up
//! (connects / resolves a task), the dispatcher selects an eligible **connected**
//! agent, atomically assigns a task to it (reusing [`service::take_task`], so the
//! side effects are identical to an HTTP take), and **pushes** the resulting
//! `AssignedTask` over the agent's WebSocket.
//!
//! Safety / concurrency:
//! - Assignment atomicity (the urgent store / Sled transaction inside `take_task`)
//!   is the single-winner guarantee: concurrent dispatches and HTTP pollers cannot
//!   both claim the same task; losers see `AppError::Conflict` and move on.
//! - The dispatcher never holds a registry lock across `.await` and uses
//!   `try_send`, so a wedged or dead socket never stalls a submit.
//! - On a push send failure the freshly-made assignment is reverted (re-queued)
//!   so the task is never stuck on an agent that never received it.

use std::collections::HashSet;
use std::sync::Arc;

use log::{debug, warn};

use crate::{
    api::agent::service,
    error::AppError,
    models::Agent,
    mq::{
        registry::WsOut,
        scheduler::{
            all_online_agents_for, find_assignable_non_urgent_tasks_with_capabilities_for_tier,
            find_urgent_tasks_with_capabilities, try_unassign_non_urgent_task,
        },
    },
    schema::TaskId,
    state::AppState,
    utils::base_capability,
};

/// Bound on dispatch loop iterations — a backstop against any pathological state
/// that would otherwise spin (it should always terminate naturally when no
/// assignable agent/task pair remains).
const MAX_DISPATCH_ITERS: usize = 1000;

/// Concurrency slots for an agent. Treat 0 as 1 so a legacy/misconfigured agent
/// still receives exactly one pushed task at a time rather than none or unbounded.
fn effective_capacity(agent: &Agent) -> usize {
    agent.capacity.max(1) as usize
}

enum PushOutcome {
    /// Task was assigned and the push was accepted by the connection's writer.
    Delivered,
    /// Assignment lost to a concurrent taker — nothing pushed; re-evaluate.
    Conflict,
    /// The connection is gone/unhealthy; the assignment was reverted. Stop using
    /// this agent for the remainder of the current dispatch pass.
    Unhealthy,
}

/// Pick the next task this agent could take: urgent first (FIFO, runner-pinned),
/// then regular (tier-filtered). Returns just the id — the atomic claim happens
/// in [`service::take_task`].
async fn next_task_for(state: &Arc<AppState>, agent: &Agent) -> Option<TaskId> {
    if let Some(t) =
        find_urgent_tasks_with_capabilities(&state.urgent, &agent.capabilities, &agent.uid).await
    {
        return Some(t.id);
    }
    find_assignable_non_urgent_tasks_with_capabilities_for_tier(
        &state.regular,
        &agent.capabilities,
        agent.tier,
        &state.storage.agents,
        &agent.uid,
    )
    .await
    .map(|t| t.id)
}

/// Revert a just-made assignment after a failed push so the task returns to the
/// queue instead of being stuck on an agent that never received it. Urgent first
/// (no-op if the task isn't urgent), then regular.
async fn revert_assignment(state: &Arc<AppState>, agent: &Agent, task_id: &TaskId) {
    // `take_task` counted this against the agent's load; reverting frees it again.
    state.agent_load.released(&agent.uid, task_id);
    state.registry.untrack_assigned(&agent.uid, task_id);
    if state.urgent.unassign_task(task_id).await {
        return;
    }
    if let Err(e) =
        try_unassign_non_urgent_task(&state.regular, &state.storage.tasks, task_id).await
    {
        warn!("Failed to revert task {task_id} after push failure: {e}");
    }
}

/// Atomically assign `task_id` to `agent` and push it over the agent's WS.
async fn push_assign(state: &Arc<AppState>, agent: &Agent, task_id: &TaskId) -> PushOutcome {
    let assigned = match service::take_task(agent, task_id.clone(), state).await {
        Ok(a) => a,
        Err(AppError::Conflict(_)) => return PushOutcome::Conflict,
        Err(e) => {
            warn!("take_task during dispatch failed for {task_id}: {e}");
            return PushOutcome::Conflict;
        }
    };

    let payload = match serde_json::to_value(&assigned) {
        Ok(task) => serde_json::json!({ "type": "task", "task": task }).to_string(),
        Err(e) => {
            warn!("Failed to serialize pushed task {task_id}: {e}");
            revert_assignment(state, agent, task_id).await;
            return PushOutcome::Conflict;
        }
    };

    match state.registry.sender(&agent.uid) {
        Some(tx) => match tx.try_send(WsOut::Text(payload)) {
            Ok(()) => {
                debug!("Pushed task {task_id} to agent {}", agent.uid_short);
                PushOutcome::Delivered
            }
            Err(e) => {
                warn!(
                    "Push to agent {} failed ({e}); reverting task {task_id}",
                    agent.uid_short
                );
                revert_assignment(state, agent, task_id).await;
                PushOutcome::Unhealthy
            }
        },
        None => {
            // Connection vanished between selection and push.
            revert_assignment(state, agent, task_id).await;
            PushOutcome::Unhealthy
        }
    }
}

/// Re-queue tasks an agent held but never started, after its WS connection drops.
/// Started (`Starting`/`Running`) and terminal tasks are left untouched — the
/// agent owns them across reconnects, with orphan recovery as the backstop. The
/// revert helpers are themselves gated to un-started (`Assigned`) tasks, so this
/// simply attempts a revert for each id and re-dispatches what came back.
pub async fn requeue_disconnected(state: &Arc<AppState>, task_ids: Vec<TaskId>) {
    let mut requeued_caps: HashSet<String> = HashSet::new();
    for task_id in task_ids {
        if state.urgent.unassign_task(&task_id).await {
            debug!("Re-queued un-started urgent task {task_id} after disconnect");
            requeued_caps.insert(task_id.cap.clone());
            continue;
        }
        match try_unassign_non_urgent_task(&state.regular, &state.storage.tasks, &task_id).await {
            Ok(true) => {
                debug!("Re-queued un-started task {task_id} after disconnect");
                requeued_caps.insert(task_id.cap.clone());
            }
            // Started or already resolved/gone — leave it to the agent / recovery.
            Ok(false) => {}
            Err(e) => warn!("Failed to re-queue task {task_id} after disconnect: {e}"),
        }
    }
    // Hand the re-queued work to another connected agent right away.
    for cap in requeued_caps {
        dispatch_for_capability(state, &cap).await;
    }
}

/// Push as many queued tasks for `cap` as possible to eligible connected agents.
/// Best-effort and non-blocking: tasks with no connected taker are left in the
/// queue for HTTP pollers or a future agent connect. Called on task submission.
pub async fn dispatch_for_capability(state: &Arc<AppState>, cap: &str) {
    let base = base_capability(cap).to_string();
    // Agents whose push failed this pass — excluded so we don't re-pick the
    // reverted task and spin against a dead socket.
    let mut unhealthy: HashSet<String> = HashSet::new();

    for _ in 0..MAX_DISPATCH_ITERS {
        let candidates: Vec<Agent> = all_online_agents_for(&base, &state.storage.agents)
            .await
            .into_iter()
            .filter(|a| !unhealthy.contains(&a.uid))
            .filter(|a| state.registry.is_connected(&a.uid))
            .filter(|a| state.agent_load.in_flight(&a.uid) < effective_capacity(a))
            .collect();
        if candidates.is_empty() {
            break;
        }

        let mut progressed = false;
        for agent in &candidates {
            if state.agent_load.in_flight(&agent.uid) >= effective_capacity(agent) {
                continue;
            }
            let Some(task_id) = next_task_for(state, agent).await else {
                continue;
            };
            match push_assign(state, agent, &task_id).await {
                PushOutcome::Delivered | PushOutcome::Conflict => {
                    progressed = true;
                    break;
                }
                PushOutcome::Unhealthy => {
                    unhealthy.insert(agent.uid.clone());
                    progressed = true;
                    break;
                }
            }
        }
        if !progressed {
            break;
        }
    }
}

/// Drain queued tasks to a single connected agent, up to its capacity. Reloads
/// the agent fresh from storage so a mid-connection `info/update` (tier/caps/
/// capacity change) is honored. Called when an agent connects and after it
/// resolves a task (freeing a slot).
pub async fn dispatch_to_agent(state: &Arc<AppState>, uid: &str) {
    for _ in 0..MAX_DISPATCH_ITERS {
        if !state.registry.is_connected(uid) {
            break;
        }
        let Some(agent) = state.storage.get_agent(uid) else {
            break;
        };
        if state.agent_load.in_flight(uid) >= effective_capacity(&agent) {
            break;
        }
        let Some(task_id) = next_task_for(state, &agent).await else {
            break;
        };
        match push_assign(state, &agent, &task_id).await {
            PushOutcome::Delivered | PushOutcome::Conflict => continue,
            PushOutcome::Unhealthy => break,
        }
    }
}
