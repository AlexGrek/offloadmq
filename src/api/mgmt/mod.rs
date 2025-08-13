use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, Json};
use chrono::Utc;
use log::{debug, info};
use rand::seq::IndexedRandom;

use crate::{
    db::agent::CachedAgentStorage,
    error::AppError,
    middleware::AuthenticatedAgent,
    models::UnassignedTask,
    mq::{
        scheduler::{
            find_assignable_non_urgent_tasks_with_capabilities_for_tier,
            find_urgent_tasks_with_capabilities, has_potential_agents_for, report_non_urgent_task,
            report_urgent_task, try_pick_up_non_urgent_task, try_pick_up_urgent_task,
        },
        urgent::UrgentTaskStore,
    },
    schema::{TaskResultReport, TaskStatus, TaskSubmissionRequest},
    state::AppState,
};