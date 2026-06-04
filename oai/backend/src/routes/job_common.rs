//! Small bits shared by every offload-job route module: id parsing and the two
//! response DTOs that are byte-identical across features (start/retry result and
//! cancel result). Feature-specific request bodies and job-detail DTOs stay in
//! each `routes/<feature>.rs`.

use serde::Serialize;

use crate::error::AppError;

/// Parse a path id (jobs expose their snowflake id as a string).
pub fn parse_id(value: &str, field: &str) -> Result<i64, AppError> {
    value
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest(format!("invalid {field}")))
}

/// Response for `start_job` and `retry_job`.
#[derive(Serialize)]
pub struct StartJobResponse {
    pub job_id: String,
    pub status: String,
}

impl StartJobResponse {
    pub fn submitted(job_id: i64) -> Self {
        Self {
            job_id: job_id.to_string(),
            status: "submitted".into(),
        }
    }
}

/// Response for `cancel_job`.
#[derive(Serialize)]
pub struct CancelJobResponse {
    pub job_id: String,
    pub status: String,
    pub message: String,
}

impl From<crate::services::offload_job::CancelOutcome> for CancelJobResponse {
    fn from(out: crate::services::offload_job::CancelOutcome) -> Self {
        Self {
            job_id: out.job_id.to_string(),
            status: out.status,
            message: out.message,
        }
    }
}
