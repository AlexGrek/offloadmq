use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    response::IntoResponse,
};
use log::{debug, info};
use serde_json::json;

use crate::{
    db::agent::CachedAgentStorage,
    error::AppError,
    models::UnassignedTask,
    mq::{
        scheduler::
            has_potential_agents_for
        ,
        urgent::UrgentTaskStore,
    },
    schema::TaskStatus,
};

pub mod heuristic;
pub mod scheduler;
pub mod urgent;