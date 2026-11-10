//! Starting image jobs: input upload, request validation, pipeline-param building,
//! submit payloads, and retry.

use super::*;

/// Input contract for starting a generation job (the service's command type).
#[derive(Deserialize)]
pub struct StartJobParams {
    pub capability: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    /// When true, send `secondary_prompts.negative`; when false, use the workflow default.
    #[serde(default)]
    pub override_negative: bool,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    pub workflow: Option<String>,
    pub input_image_id: Option<String>,
    /// OffloadMQ `dataPreparation` map (glob mask → action), applied to input bucket files.
    pub data_preparation: Option<HashMap<String, String>>,
    /// UI rescale controls snapshot (img2img); stored in pipeline params for "edit prompt".
    #[serde(default)]
    pub rescale: Option<RescaleParams>,
    /// Number of frames for video generation workflows.
    #[serde(default)]
    pub video_length: Option<i32>,
    /// Shrink the input image with an `image_resize` pre-step on an agent instead
    /// of locally. Only meaningful for the img2img / img2video workflows — a job
    /// with no input image ignores it. See [`external_resize`].
    #[serde(default)]
    pub external_resize: bool,
    /// Submit at OffloadMQ priority "high" (2) instead of regular, for every task
    /// this job runs (resize pre-step, generation, upscale). Legacy alias for
    /// `priority: "high"`, restricted to admins: `start_job` rejects it
    /// with 403 for anyone else, and `retry_job` downgrades it to regular.
    #[serde(default)]
    pub high_priority: bool,
    #[serde(default)]
    pub priority: crate::offload::image_tasks::ImageTaskPriority,
    /// The prompt as the user typed it, before placeholder expansion. Saved prompts
    /// store this raw text, so it is the key a finished job's thumbnail is attached
    /// to as the saved prompt's preview. Absent for API/CLI callers — the stored
    /// prompt is used then.
    #[serde(default)]
    pub prompt_template: Option<String>,
}

impl StartJobParams {
    pub fn queue_priority(&self) -> crate::offload::image_tasks::ImageTaskPriority {
        self.priority.with_legacy_high(self.high_priority)
    }
}

pub async fn upload_input_image(
    state: &AppState,
    user_id: i64,
    filename: String,
    bytes: Vec<u8>,
    content_type: String,
) -> Result<image_generation::ImageFile, AppError> {
    storage::operator(state)?;
    let processed = image_processing::process_upload_async(bytes, Some(content_type)).await?;

    let image_id = state.next_id();
    let storage_path = image_paths::main_image_path(user_id, image_paths::MainImage::Input, image_id);
    store_image(
        state,
        StoredImageSpec {
            image_id,
            user_id,
            job_id: None,
            direction: "input",
            source: "upload",
            storage_path: &storage_path,
            filename: &filename,
            offload_bucket_uid: None,
            offload_file_uid: None,
        },
        &processed,
    )
    .await
}

/// Re-submit a terminal job using its stored `pipeline_params` (retry or generate again).
pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = image_generation::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if !matches!(job.status.as_str(), "failed" | "canceled" | "completed") {
        return Err(AppError::BadRequest(format!(
            "only failed, canceled, or completed jobs can be resubmitted (status={})",
            job.status
        )));
    }
    let params = image_pipeline_params::parse_stored_pipeline_params(&job);
    let mut start = start_params_from_pipeline(&params);
    // Replaying a stored choice must not fail the retry: a user who has since
    // lost admin just gets a regular-priority job.
    if start.queue_priority() == crate::offload::image_tasks::ImageTaskPriority::High
        && !is_admin(state, user_id).await?
    {
        start.high_priority = false;
        start.priority = Default::default();
    }
    let new_id = start_job_with_upscale(state, user_id, start, params.upscale).await?;
    let (source_event, target_event) = if job.status == "completed" {
        ("job.regenerate", "job.regenerated_from")
    } else {
        ("job.retry", "job.retried_from")
    };
    record_event(
        state,
        job_id,
        source_event,
        "ok",
        Some(&format!("new_job_id={new_id}")),
    )
    .await?;
    record_event(
        state,
        new_id,
        target_event,
        "ok",
        Some(&format!("source_job_id={job_id}")),
    )
    .await?;
    Ok(new_id)
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    req: StartJobParams,
) -> Result<i64, AppError> {
    start_job_with_id(state, user_id, state.next_id(), req, false).await
}

/// The checks `start_job` makes before creating anything — for callers that keep
/// a request to submit later (the stash), so a broken request is rejected when it
/// is saved, not when it is finally started.
pub async fn validate_request(
    state: &AppState,
    user_id: i64,
    req: &StartJobParams,
) -> Result<(), AppError> {
    if req.queue_priority() == crate::offload::image_tasks::ImageTaskPriority::High
        && !is_admin(state, user_id).await?
    {
        return Err(AppError::Forbidden);
    }
    validate_start_job(req, &resolve_workflow(req))?;
    if let Some(id) = parse_input_image_id(req)? {
        get_owned_input_file(state, id, user_id).await?;
    }
    Ok(())
}

/// High priority jumps every regular task on the shared OffloadMQ queue — other
/// users' and other clients' — so only admins may ask for it.
async fn is_admin(state: &AppState, user_id: i64) -> Result<bool, AppError> {
    Ok(crate::db::users::find_by_id(&state.db, user_id)
        .await?
        .is_some_and(|u| u.is_admin == Some(true)))
}

/// Start a child job with an ID already reserved by a persistent orchestrator.
pub async fn start_job_with_id(
    state: &AppState,
    user_id: i64,
    job_id: i64,
    req: StartJobParams,
    preserve_input: bool,
) -> Result<i64, AppError> {
    start_job_internal(state, user_id, job_id, req, preserve_input, None).await
}

/// Generate and upscale under one durable job; the worker drives both stages.
pub async fn start_job_with_upscale(
    state: &AppState,
    user_id: i64,
    req: StartJobParams,
    upscale: Option<image_pipeline_params::UpscaleParams>,
) -> Result<i64, AppError> {
    start_job_internal(state, user_id, state.next_id(), req, false, upscale).await
}

async fn start_job_internal(
    state: &AppState,
    user_id: i64,
    job_id: i64,
    req: StartJobParams,
    preserve_input: bool,
    upscale: Option<image_pipeline_params::UpscaleParams>,
) -> Result<i64, AppError> {
    if req.queue_priority() == crate::offload::image_tasks::ImageTaskPriority::High
        && !is_admin(state, user_id).await?
    {
        return Err(AppError::Forbidden);
    }
    storage::operator(state)?;
    if let Some(upscale) = &upscale {
        upscale.validate()?;
        if !matches!(resolve_workflow(&req).as_str(), "txt2img" | "img2img") {
            return Err(AppError::BadRequest(
                "upscale supports txt2img and img2img only".into(),
            ));
        }
    }

    let input_image_id = parse_input_image_id(&req)?;
    let input = match input_image_id {
        Some(id) => Some(get_owned_input_file(state, id, user_id).await?),
        None => None,
    };
    let workflow = resolve_workflow(&req);
    validate_start_job(&req, &workflow)?;

    let mut req = req;
    req.prompt = image_job_names::expand_prompt_placeholders(req.prompt.trim());

    let display_name = image_job_names::generate_display_name();
    let mut pipeline_params = build_pipeline_params(&req, &workflow, input_image_id);
    pipeline_params.upscale = upscale;
    let pipeline_params_json = pipeline_params
        .to_json()
        .map_err(|e| AppError::Internal(format!("pipeline params json: {e}")))?;
    image_generation::create_job(
        &state.db,
        image_generation::NewJobInput {
            id: job_id,
            display_name: &display_name,
            user_id,
            prompt: req.prompt.trim(),
            negative_prompt: req.negative_prompt.as_deref(),
            capability: &req.capability,
            workflow: &workflow,
            width: req.width,
            height: req.height,
            seed: req.seed,
            input_image_id,
            pipeline_params_json: &pipeline_params_json,
        },
    )
    .await?;
    record_event(state, job_id, "job.created", "ok", None).await?;

    let client = offload_factory::image_client(state).await?;

    // External resize turns this into a two-task job: the pre-step runs first and
    // the real task is submitted from `promote_after_resize` once it completes.
    // Nothing else is created yet — the output bucket belongs to the real task.
    if pipeline_params.external_resize {
        // `build_pipeline_params` only sets `external_resize` when an input image id
        // exists, so this holds by construction — but surface a broken invariant as an
        // error instead of panicking a request handler.
        let input = input.as_ref().ok_or_else(|| {
            AppError::Internal("external_resize is set but the job has no input image".into())
        })?;
        let pre = external_resize::submit_at_priority(state, &client, input, req.queue_priority())
            .await?;
        image_generation::create_offload_task(
            &state.db,
            state.next_id(),
            job_id,
            &pre.task_id.cap,
            &pre.task_id.id,
            &pre.submit_payload.to_string(),
        )
        .await?;
        state.watch.track(&pre.task_id.cap, &pre.task_id.id).await;
        image_generation::update_job_status(&state.db, job_id, "submitted", None).await?;
        record_event(
            state,
            job_id,
            "offload.resize.submit",
            "ok",
            Some(&format!(
                "cap={} id={} out_bucket={}",
                pre.task_id.cap, pre.task_id.id, pre.output_bucket
            )),
        )
        .await?;
        if !preserve_input { link_fresh_input(state, user_id, job_id, input).await?; }
        return Ok(job_id);
    }

    let output_bucket = client.create_bucket(false).await?;
    record_event(
        state,
        job_id,
        "offload.output_bucket.create",
        "ok",
        Some(&format!("bucket={}", output_bucket.bucket_uid)),
    )
    .await?;

    let input_bucket_uid = match &input {
        Some(input) => Some(stage_input_image(state, &client, job_id, input).await?),
        None => None,
    };

    let payload = build_submit_payload(&req, &workflow, input.as_ref());
    let data_prep = data_preparation_map(&req.data_preparation);
    let (task_id, submit_payload) = client
        .submit_img_task_at_priority(
            &req.capability,
            payload,
            input_bucket_uid.as_deref(),
            &output_bucket.bucket_uid,
            data_prep.as_ref(),
            req.queue_priority(),
        )
        .await?;

    image_generation::create_offload_task(
        &state.db,
        state.next_id(),
        job_id,
        &task_id.cap,
        &task_id.id,
        &submit_payload.to_string(),
    )
    .await?;
    state.watch.track(&task_id.cap, &task_id.id).await;
    image_generation::update_job_status(&state.db, job_id, "submitted", None).await?;
    record_event(
        state,
        job_id,
        "offload.submit",
        "ok",
        Some(&format!("cap={} id={}", task_id.cap, task_id.id)),
    )
    .await?;

    if let Some(input) = &input {
        if !preserve_input { link_fresh_input(state, user_id, job_id, input).await?; }
    }

    Ok(job_id)
}

/// Only re-link freshly uploaded inputs (`direction == "input"`). Generated
/// outputs — whether an imggen job's own output or a standalone img-utils /
/// resize result — are `direction == "output"` and must never be re-linked:
/// doing so would leave a stray `output` row on this job, which the frontend
/// (and `fetch_and_store_outputs`'s "already has output" guard) would then
/// mistake for this job's real result.
///
/// `job_id == None` alone is not a safe test for "freshly uploaded": standalone
/// outputs (`store_offload_output_image`, used by img-utils) are also created
/// with `job_id: None` since they don't belong to `image_generation_jobs`.
pub(super) async fn link_fresh_input(
    state: &AppState,
    user_id: i64,
    job_id: i64,
    input: &image_generation::ImageFile,
) -> Result<(), AppError> {
    if input.direction == "input" {
        image_generation::set_image_file_job(&state.db, input.id, user_id, job_id).await?;
    }
    Ok(())
}

pub(super) fn validate_start_job(req: &StartJobParams, workflow: &str) -> Result<(), AppError> {
    if req.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt is required".into()));
    }
    if !req.capability.starts_with("imggen.") {
        return Err(AppError::BadRequest(
            "capability must start with imggen.".into(),
        ));
    }
    if matches!(workflow, "img2img" | "img2video") && req.input_image_id.is_none() {
        return Err(AppError::BadRequest(format!("{workflow} requires input_image_id")));
    }
    Ok(())
}

pub(super) fn is_video_workflow(workflow: &str) -> bool {
    matches!(workflow, "txt2video" | "img2video")
}

pub(super) fn parse_input_image_id(req: &StartJobParams) -> Result<Option<i64>, AppError> {
    req.input_image_id
        .as_deref()
        .map(|s| {
            s.parse::<i64>()
                .map_err(|_| AppError::BadRequest("invalid input_image_id".into()))
        })
        .transpose()
}

pub(super) fn start_params_from_pipeline(p: &ImagePipelineParams) -> StartJobParams {
    StartJobParams {
        capability: p.capability.clone(),
        prompt: p.prompt.clone(),
        negative_prompt: p.negative_prompt.clone(),
        override_negative: p.override_negative,
        width: p.width,
        height: p.height,
        seed: p.seed,
        workflow: Some(p.workflow.clone()),
        input_image_id: p.input_image_id.clone(),
        data_preparation: p.data_preparation.clone(),
        rescale: p.rescale.clone(),
        video_length: p.video_length,
        external_resize: p.external_resize,
        high_priority: p.high_priority,
        priority: p.priority,
        prompt_template: p.prompt_template.clone(),
    }
}

pub(super) fn build_pipeline_params(
    req: &StartJobParams,
    workflow: &str,
    input_image_id: Option<i64>,
) -> ImagePipelineParams {
    ImagePipelineParams {
        upscale: None,
        capability: req.capability.clone(),
        prompt: req.prompt.trim().to_string(),
        negative_prompt: req.negative_prompt.clone(),
        override_negative: req.override_negative,
        width: req.width,
        height: req.height,
        seed: req.seed,
        workflow: workflow.to_string(),
        input_image_id: input_image_id.map(|id| id.to_string()),
        data_preparation: req.data_preparation.clone(),
        rescale: req.rescale.clone(),
        video_length: req.video_length,
        external_resize: req.external_resize && input_image_id.is_some(),
        high_priority: req.queue_priority() == crate::offload::image_tasks::ImageTaskPriority::High,
        priority: req.priority,
        prompt_template: req
            .prompt_template
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(ToOwned::to_owned),
    }
}

pub fn pipeline_params_for_job(job: &image_generation::ImageGenerationJob) -> ImagePipelineParams {
    image_pipeline_params::parse_stored_pipeline_params(job)
}

pub fn display_name_for_job(job: &image_generation::ImageGenerationJob) -> String {
    image_job_names::effective_display_name(job)
}

pub(super) fn resolve_workflow(req: &StartJobParams) -> String {
    req.workflow.clone().unwrap_or_else(|| {
        if req.input_image_id.is_some() { "img2img".into() } else { "txt2img".into() }
    })
}

/// Uploads an owned input image into a fresh offload bucket; returns its uid.
pub(super) async fn stage_input_image(
    state: &AppState,
    client: &OffloadImageClient,
    job_id: i64,
    input: &image_generation::ImageFile,
) -> Result<String, AppError> {
    let bytes = storage::read(storage::operator(state)?, &input.storage_path).await?;
    let bucket = client.create_bucket(true).await?;
    let upload = client
        .upload_bucket_file(
            &bucket.bucket_uid,
            bytes,
            &input.filename,
            &input.content_type,
        )
        .await?;
    record_event(
        state,
        job_id,
        "offload.input.upload",
        "ok",
        Some(&format!("bucket={} file_uid={}", bucket.bucket_uid, upload.file_uid)),
    )
    .await?;
    Ok(bucket.bucket_uid)
}

pub(super) fn data_preparation_map(
    prep: &Option<HashMap<String, String>>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let map = prep.as_ref().filter(|m| !m.is_empty())?;
    Some(
        map.iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect(),
    )
}

pub(super) fn build_submit_payload(
    req: &StartJobParams,
    workflow: &str,
    input: Option<&image_generation::ImageFile>,
) -> Value {
    let mut payload = serde_json::json!({
        "workflow": workflow,
        "prompt": req.prompt.trim(),
        "resolution": { "width": req.width, "height": req.height },
    });
    // An explicit empty string clears the workflow default; null leaves it alone.
    if req.override_negative {
        if let Some(neg) = req.negative_prompt.as_deref() {
            payload["secondary_prompts"] = serde_json::json!({ "negative": neg });
        }
    }
    if let Some(seed) = req.seed {
        payload["seed"] = serde_json::json!(seed);
    }
    if let Some(input) = input {
        payload["input_image"] = serde_json::json!(input.filename);
    }
    if let Some(length) = req.video_length {
        payload["length"] = serde_json::json!(length);
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upscale_snapshot_survives_restart_and_retry_without_changing_base_size() {
        let req: StartJobParams = serde_json::from_value(serde_json::json!({
            "capability": "imggen.test", "prompt": "landscape", "width": 1024, "height": 768,
            "seed": 17
        })).unwrap();
        let mut pipeline = build_pipeline_params(&req, "txt2img", None);
        let legacy = pipeline.to_json().unwrap();
        assert!(ImagePipelineParams::from_json(&legacy).unwrap().upscale.is_none());
        pipeline.upscale = Some(image_pipeline_params::UpscaleParams {
            capability: "img-utils.seedvr2".into(), workflow: "upscale".into(), scale: 2.0,
        });
        let restored = ImagePipelineParams::from_json(&pipeline.to_json().unwrap()).unwrap();
        let retry = start_params_from_pipeline(&restored);
        assert_eq!((retry.width, retry.height), (1024, 768));
        assert_eq!(retry.seed, Some(17));
        assert_eq!(restored.upscale.unwrap().scale, 2.0);
    }

    #[test]
    fn explicit_empty_negative_clears_workflow_default() {
        let mut req: StartJobParams = serde_json::from_value(serde_json::json!({
            "capability": "imggen.test", "prompt": "landscape", "width": 1024, "height": 1024,
            "override_negative": true, "negative_prompt": ""
        }))
        .unwrap();
        assert_eq!(
            build_submit_payload(&req, "txt2img", None)["secondary_prompts"]["negative"],
            ""
        );
        req.override_negative = false;
        assert!(build_submit_payload(&req, "txt2img", None)
            .get("secondary_prompts")
            .is_none());
        req.override_negative = true;
        req.negative_prompt = None;
        assert!(build_submit_payload(&req, "txt2img", None)
            .get("secondary_prompts")
            .is_none());
        req.negative_prompt = Some("blurry".into());
        assert_eq!(
            build_submit_payload(&req, "txt2img", None)["secondary_prompts"]["negative"],
            "blurry"
        );
    }

    #[test]
    fn low_priority_survives_snapshot_and_retry() {
        let req: StartJobParams = serde_json::from_value(serde_json::json!({
            "capability": "imggen.test", "prompt": "dream", "width": 512,
            "height": 512, "priority": "low"
        }))
        .unwrap();
        let params = build_pipeline_params(&req, "txt2img", None);
        let stored = params.to_json().unwrap();
        let restored = ImagePipelineParams::from_json(&stored).unwrap();
        assert_eq!(
            start_params_from_pipeline(&restored).queue_priority(),
            crate::offload::image_tasks::ImageTaskPriority::Low
        );
    }

    #[test]
    fn high_priority_is_stored_and_replayed_on_retry() {
        let base = serde_json::json!({
            "capability": "imggen.test", "prompt": "landscape", "width": 512, "height": 512
        });
        // Omitted by API/CLI/MCP callers → regular, and not written to the snapshot.
        let req: StartJobParams = serde_json::from_value(base.clone()).unwrap();
        assert!(!req.high_priority);
        let regular = build_pipeline_params(&req, "txt2img", None).to_json().unwrap();
        assert!(!regular.contains("high_priority"));

        let mut high = base;
        high["high_priority"] = serde_json::json!(true);
        let req: StartJobParams = serde_json::from_value(high).unwrap();
        let stored = build_pipeline_params(&req, "txt2img", None).to_json().unwrap();
        let retry = start_params_from_pipeline(&ImagePipelineParams::from_json(&stored).unwrap());
        assert!(retry.high_priority);

        // A snapshot without the field (regular, or written before the option
        // existed) replays as regular.
        assert!(!start_params_from_pipeline(&ImagePipelineParams::from_json(&regular).unwrap())
            .high_priority);
    }
}
