//! `img-utils` job orchestration: single-purpose ComfyUI image transforms
//! (depth map, face swap, …). A job stages one or two stored images into an
//! OffloadMQ input bucket, submits an `img-utils.<utility>` task with an output
//! bucket, and downloads the produced image back into `image_files` on
//! completion.
//!
//! The poll/cancel/reconcile state machine is the shared [`offload_job`] driver;
//! this module supplies only the img-utils-specific pieces. Output arrives as
//! bucket files, so — like music generation — it polls with the image client.

use async_trait::async_trait;
use serde::Serialize;

use crate::{
    db::{
        entities::img_utils_jobs::Entity as ImgUtilsJobEntity, image_generation, img_utils,
        offload_jobs,
    },
    error::AppError,
    offload::task_status::{NormalizedPoll, OffloadPoller},
    services::{
        image_jobs, image_processing,
        offload_factory,
        offload_job::{self, CancelOutcome, JobReconciler},
        storage,
    },
    state::AppState,
};

pub const CAPABILITY_PREFIX: &str = "img-utils.";

/// One `img-utils.*` capability advertised by an online agent.
#[derive(Debug, Serialize)]
pub struct ImgUtilCapability {
    /// Base capability, e.g. `img-utils.image_lotus_depth_v1_1`.
    pub base: String,
    /// Capability minus the prefix — the workflow pack, named after the model
    /// (`image_lotus_depth_v1_1`), *not* the operation.
    pub utility: String,
    /// Operations the pack installs, from the agent's bracket attributes
    /// (`["depth"]`). These are the values `workflow` accepts.
    pub workflows: Vec<String>,
    pub raw: String,
    /// True when one of the operations consumes a second "source" image.
    pub needs_source_image: bool,
}

pub struct StartJobParams {
    pub capability: String,
    /// Operation to run. When omitted it is resolved from the capability's
    /// advertised operations — unambiguous for the usual single-operation pack.
    pub workflow: Option<String>,
    pub input_image_id: i64,
    pub source_image_id: Option<i64>,
    /// Extra workflow knobs forwarded verbatim as `payload.secondary_prompts`.
    pub options: Option<serde_json::Map<String, serde_json::Value>>,
}

/// Whether an operation takes a second image. Keyed on the *operation* rather
/// than the pack directory: a pack is named after its model, so
/// `img-utils.face_swap_reactor` and `img-utils.roop` must both be recognised
/// via their `face_swap` task type.
fn workflow_needs_source_image(workflow: &str) -> bool {
    workflow.starts_with("face_swap") || workflow.starts_with("face-swap")
}

/// Drives the generic poll/cancel/reconcile lifecycle for img-utils jobs.
struct ImgUtilsReconciler;

#[async_trait]
impl JobReconciler for ImgUtilsReconciler {
    type Entity = ImgUtilsJobEntity;

    fn label(&self) -> &'static str {
        "img_utils"
    }

    fn failure_fallback(&self) -> &'static str {
        "img-utils task failed"
    }

    async fn poller(&self, state: &AppState) -> Result<Box<dyn OffloadPoller>, AppError> {
        Ok(Box::new(offload_factory::image_client(state).await?))
    }

    async fn on_completed(
        &self,
        state: &AppState,
        job: &img_utils::ImgUtilsJob,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError> {
        // Already finalized by a concurrent poll — nothing to download twice.
        if job.output_image_id.is_some() {
            return Ok(());
        }
        let fail = |reason: &'static str| async move {
            offload_jobs::update_status::<ImgUtilsJobEntity>(
                &state.db,
                job.id,
                "failed",
                None,
                Some(reason),
            )
            .await
        };

        let Some(output) = poll.output.as_ref() else {
            return fail("img-utils task returned no output").await;
        };
        let Some(image) = output
            .get("images")
            .and_then(|v| v.as_array())
            .and_then(|a| a.last())
        else {
            return fail("img-utils task returned no output images").await;
        };
        // No reference to fetch means retrying can never succeed — fail now rather
        // than let the background worker re-poll this job forever.
        if image.get("file_uid").and_then(|v| v.as_str()).is_none()
            && image.get("data_base64").and_then(|v| v.as_str()).is_none()
        {
            return fail("img-utils output image has neither file_uid nor data_base64").await;
        }
        let Some(bucket) = job
            .output_bucket_uid
            .as_deref()
            .or_else(|| output.get("output_bucket").and_then(|v| v.as_str()))
        else {
            return fail("img-utils task output has no bucket to download from").await;
        };

        let file = image_jobs::store_offload_output_image(
            state,
            job.user_id,
            &format!("img-utils/{}", job.utility),
            bucket,
            image,
            // Embedded in the stored JPEG's EXIF as the image's provenance.
            &job.capability,
        )
        .await?;
        img_utils::set_output_image(&state.db, job.id, file.id).await
    }
}

pub async fn list_capabilities(state: &AppState) -> Result<Vec<ImgUtilCapability>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let caps = client.list_capabilities_with_prefix(CAPABILITY_PREFIX).await?;
    Ok(caps
        .into_iter()
        .map(|c| {
            let utility = c
                .base
                .strip_prefix(CAPABILITY_PREFIX)
                .unwrap_or(&c.base)
                .to_string();
            ImgUtilCapability {
                needs_source_image: c.tags.iter().any(|t| workflow_needs_source_image(t)),
                utility,
                base: c.base,
                workflows: c.tags,
                raw: c.raw,
            }
        })
        .collect())
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    params: StartJobParams,
) -> Result<i64, AppError> {
    storage::operator(state)?;

    let capability = crate::offload::base_capability(&params.capability).to_string();
    if !capability.starts_with(CAPABILITY_PREFIX) {
        return Err(AppError::BadRequest(format!(
            "capability must start with `{CAPABILITY_PREFIX}`"
        )));
    }
    let utility = capability[CAPABILITY_PREFIX.len()..].to_string();
    if utility.is_empty() {
        return Err(AppError::BadRequest("capability is missing a utility name".into()));
    }
    let workflow = match params.workflow.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(w) => w.to_string(),
        // The pack directory is named after the model, so it is never a usable
        // task type — ask the agent which operations it actually installed.
        None => resolve_sole_workflow(state, &capability).await?,
    };

    if workflow_needs_source_image(&workflow) && params.source_image_id.is_none() {
        return Err(AppError::BadRequest(format!(
            "{workflow} requires a source (face reference) image"
        )));
    }

    let input = image_generation::get_image_file(&state.db, params.input_image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let source = match params.source_image_id {
        Some(id) => Some(
            image_generation::get_image_file(&state.db, id, user_id)
                .await?
                .ok_or(AppError::NotFound)?,
        ),
        None => None,
    };

    let options_json = params
        .options
        .as_ref()
        .filter(|m| !m.is_empty())
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| AppError::Internal(format!("serialize options: {e}")))?;

    let job_id = state.next_id();
    img_utils::create_job(
        &state.db,
        img_utils::NewJobInput {
            id: job_id,
            user_id,
            capability: &capability,
            utility: &utility,
            workflow: &workflow,
            input_image_id: Some(input.id),
            source_image_id: source.as_ref().map(|f| f.id),
            options_json: options_json.as_deref(),
        },
    )
    .await?;

    let client = offload_factory::image_client(state).await?;
    let in_bucket = client.create_bucket(true).await?;
    let out_bucket = client.create_bucket(false).await?;

    // Bucket files are matched by name on the agent, so the two inputs must not
    // collide even when the same upload is used for both slots.
    let input_name = stage_image(state, &client, &in_bucket.bucket_uid, &input, "input").await?;
    let source_name = match source.as_ref() {
        Some(file) => {
            Some(stage_image(state, &client, &in_bucket.bucket_uid, file, "source").await?)
        }
        None => None,
    };

    let payload = build_task_payload(
        &workflow,
        &input_name,
        source_name.as_deref(),
        &input,
        params.options.as_ref(),
    );
    let (task_id, _) = client
        .submit_img_task(
            &capability,
            payload,
            Some(&in_bucket.bucket_uid),
            &out_bucket.bucket_uid,
            None,
        )
        .await?;

    offload_jobs::set_offload_task::<ImgUtilsJobEntity>(
        &state.db,
        job_id,
        &task_id.cap,
        &task_id.id,
        Some(&out_bucket.bucket_uid),
    )
    .await?;

    Ok(job_id)
}

/// The single operation a pack installs, for callers that did not name one.
/// Errors rather than guessing when a pack offers several — running the wrong
/// transform silently would be worse than a 400.
async fn resolve_sole_workflow(state: &AppState, capability: &str) -> Result<String, AppError> {
    let caps = list_capabilities(state).await?;
    let Some(cap) = caps.into_iter().find(|c| c.base == capability) else {
        return Err(AppError::BadRequest(format!(
            "no online agent provides `{capability}`"
        )));
    };
    match cap.workflows.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(AppError::BadRequest(format!(
            "`{capability}` declares no operations"
        ))),
        many => Err(AppError::BadRequest(format!(
            "`{capability}` provides several operations ({}) — specify `workflow`",
            many.join(", ")
        ))),
    }
}

/// Upload one stored image into the task's input bucket under a collision-free
/// name, returning the name the agent will see.
async fn stage_image(
    state: &AppState,
    client: &crate::offload::image_tasks::OffloadImageClient,
    bucket_uid: &str,
    file: &image_generation::ImageFile,
    slot: &str,
) -> Result<String, AppError> {
    let op = storage::operator(state)?;
    let bytes = storage::read(op, &file.storage_path).await?;
    let processed = image_processing::process_image(bytes, Some(file.content_type.clone()))?;
    let name = format!("{slot}_{}.jpg", file.id);
    client
        .upload_bucket_file(bucket_uid, processed.bytes, &name, &processed.content_type)
        .await?;
    Ok(name)
}

fn build_task_payload(
    workflow: &str,
    input_name: &str,
    source_name: Option<&str>,
    input: &image_generation::ImageFile,
    options: Option<&serde_json::Map<String, serde_json::Value>>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "workflow": workflow,
        "input_image": input_name,
        // Not injected by any img-utils workflow, but it lets the OffloadMQ
        // scheduler scale its runtime estimate by the work actually requested.
        "resolution": { "width": input.stored_width, "height": input.stored_height },
    });
    if let Some(name) = source_name {
        payload["face_swap"] = serde_json::Value::String(name.to_string());
    }
    if let Some(opts) = options.filter(|m| !m.is_empty()) {
        payload["secondary_prompts"] = serde_json::Value::Object(opts.clone());
    }
    payload
}

pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = offload_jobs::get_job::<ImgUtilsJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if !matches!(job.status.as_str(), "failed" | "canceled") {
        return Err(AppError::BadRequest(format!(
            "only failed or canceled jobs can be retried (status={})",
            job.status
        )));
    }
    let input_image_id = job
        .input_image_id
        .ok_or_else(|| AppError::BadRequest("retry requires the original input image".into()))?;
    start_job(
        state,
        user_id,
        StartJobParams {
            capability: job.capability.clone(),
            workflow: Some(job.workflow.clone()),
            input_image_id,
            source_image_id: job.source_image_id,
            options: parse_options(job.options_json.as_deref()),
        },
    )
    .await
}

pub fn parse_options(
    json: Option<&str>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    json.and_then(|s| serde_json::from_str(s).ok())
}

pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelOutcome, AppError> {
    offload_job::cancel_job(&ImgUtilsReconciler, state, user_id, job_id).await
}

/// Delete a job and the image it produced. The *input* image is a user upload
/// shared with the rest of the app, so it is deliberately left alone.
pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    let job = offload_jobs::get_job::<ImgUtilsJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if let Some(image_id) = job.output_image_id {
        if let Err(e) = image_jobs::remove_user_image(state, user_id, image_id).await {
            tracing::warn!("img_utils: failed to remove output image {image_id}: {e}");
        }
    }
    offload_jobs::delete_job::<ImgUtilsJobEntity>(&state.db, job_id, user_id).await
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<img_utils::ImgUtilsJob, AppError> {
    offload_job::poll_job(&ImgUtilsReconciler, state, user_id, job_id).await
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<img_utils::ImgUtilsJob>, AppError> {
    offload_jobs::list_jobs::<ImgUtilsJobEntity>(&state.db, user_id, limit).await
}

/// Background worker pass: advances in-flight img-utils jobs.
pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    offload_job::reconcile_pass(&ImgUtilsReconciler, state, batch_size).await
}
