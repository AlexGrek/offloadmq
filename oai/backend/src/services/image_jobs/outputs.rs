//! Fetching finished outputs from OffloadMQ and persisting them: image/video
//! processing, storage writes, `image_files` rows, bucket release and quota upkeep.

use super::*;

// Each download holds one pool connection for its advisory lock and uses the
// pool for normal writes. Bound these reservations so concurrent completions
// cannot occupy the entire (default ten-connection) pool, especially for videos.
static OUTPUT_DOWNLOAD_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

/// Persist an image produced by an OffloadMQ task that has no
/// `image_generation_jobs` row — the `img-utils` transforms own their own job
/// table but reuse `image_files` (and therefore the existing
/// `/api/images/files/{id}` serving, thumbnails and quota accounting).
///
/// Describes one output image to fetch and persist with [`store_offload_output_image`].
pub struct OffloadOutputImage<'a> {
    /// Provenance label stored on the file row; also the fallback filename stem.
    pub source: &'a str,
    /// OffloadMQ bucket the output lives in (used when the image isn't inline).
    pub output_bucket: &'a str,
    /// One entry of the task output's `images` array: either `{file_uid, filename}`
    /// (bucket) or `{data_base64, content_type}` (inline).
    pub image: &'a Value,
    /// Written into the stored JPEG's EXIF `ImageDescription` — unless the source image
    /// already carries one of its own, which then wins.
    pub metadata_text: &'a str,
    /// Caps the stored resolution — pass [`image_processing::MAX_IMAGE_EDGE`] for tools
    /// whose output should match the standard stored-image cap, or
    /// [`image_processing::NO_MAX_EDGE`] for a tool (e.g. img-utils upscale) whose whole
    /// purpose is to exceed it.
    pub max_edge: u32,
    /// Stored bytes of the image the output was derived from; its EXIF is carried onto
    /// the output (see [`image_processing::process_generated_image`]).
    pub exif_source: Option<&'a [u8]>,
}

pub async fn store_offload_output_image(
    state: &AppState,
    user_id: i64,
    out: OffloadOutputImage<'_>,
) -> Result<image_generation::ImageFile, AppError> {
    let OffloadOutputImage { source, output_bucket, image, metadata_text, max_edge, exif_source } =
        out;
    storage::operator(state)?;
    let file_uid = image["file_uid"].as_str();
    let filename = image["filename"]
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{source}.jpg"));

    let client =
        offload_factory::image_client_from_settings(state, app_settings::get(&state.db).await?)?;
    let processed = process_output_image(
        &client,
        output_bucket,
        image,
        file_uid.unwrap_or_default(),
        metadata_text,
        max_edge,
        exif_source,
    )
    .await?;

    let image_id = state.next_id();
    let storage_path = image_paths::standalone_output_path(user_id, image_id);
    store_image(
        state,
        StoredImageSpec {
            image_id,
            user_id,
            job_id: None,
            direction: "output",
            source,
            storage_path: &storage_path,
            filename: &filename,
            offload_bucket_uid: Some(output_bucket),
            offload_file_uid: file_uid,
        },
        &processed,
    )
    .await
}

pub(super) async fn fetch_and_store_outputs(
    state: &AppState,
    user_id: i64,
    job: &image_generation::ImageGenerationJob,
    output: Option<Value>,
) -> Result<(), AppError> {
    let Ok(_slot) = OUTPUT_DOWNLOAD_SLOTS.try_acquire() else {
        // The next page/worker poll will retry without reserving a connection.
        return Ok(());
    };
    let Some(lock) = image_generation::try_lock_output_download(&state.db, job.id).await? else {
        // Another poll is already fetching this result. Leave it to finish;
        // waiting here would reserve another DB connection for a large video.
        return Ok(());
    };
    let result = fetch_and_store_outputs_locked(state, user_id, job, output).await;
    lock.rollback().await?;
    result
}

async fn fetch_and_store_outputs_locked(
    state: &AppState,
    user_id: i64,
    job: &image_generation::ImageGenerationJob,
    output: Option<Value>,
) -> Result<(), AppError> {
    // This check must happen after taking the lock, before any download.
    let existing = image_generation::list_job_files(&state.db, job.id).await?;
    if existing.iter().any(|f| f.direction == "output") {
        if job.status != "completed" {
            image_generation::update_job_status(&state.db, job.id, "completed", None).await?;
        }
        // Outputs were stored by an earlier pass; if it did not get as far as
        // freeing the buckets (a restart mid-finalize), do it now.
        release_job_buckets(state, job.id).await;
        return Ok(());
    }

    let offload = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("missing offload row".into()))?;
    let output_bucket = output_bucket_of(&offload)?;
    let client =
        offload_factory::image_client_from_settings(state, app_settings::get(&state.db).await?)?;

    let thumbnail = if is_video_workflow(&job.workflow) {
        let video = collect_output_video(output.as_ref(), offload.last_poll_output.as_deref());
        let Some(video) = video else {
            record_event(
                state,
                job.id,
                "download.outputs",
                "pending",
                Some("no video in poll payload; keep job submitted for retry"),
            )
            .await?;
            return Ok(());
        };
        store_output_video(state, &client, user_id, job, &output_bucket, &video).await?
    } else {
        let images = collect_output_images(output.as_ref(), offload.last_poll_output.as_deref());
        let image_count = images.len();
        let Some(image) = images.into_iter().last() else {
            record_event(
                state,
                job.id,
                "download.outputs",
                "pending",
                Some("no output images in poll payload; keep job submitted for retry"),
            )
            .await?;
            return Ok(());
        };
        if image_count > MAX_OUTPUT_FILES_PER_JOB {
            record_event(
                state,
                job.id,
                "download.outputs",
                "ok",
                Some(&format!(
                    "offload returned {image_count} images; storing last only"
                )),
            )
            .await?;
        }
        store_output_image(state, &client, user_id, job, &output_bucket, 0, &image).await?
    };

    image_generation::update_job_status(&state.db, job.id, "completed", None).await?;
    record_event(state, job.id, "job.finalize", "ok", Some("completed")).await?;
    // Latest result becomes the saved prompt's preview (best-effort, never fails the job).
    let template = pipeline_params_for_job(job)
        .prompt_template
        .unwrap_or_else(|| job.prompt.clone());
    prompt_previews::attach_preview(state, user_id, PROMPT_BUCKET, &template, thumbnail).await;
    // The outputs are in our own storage now, so the task's buckets are dead
    // weight on the server.
    release_job_buckets(state, job.id).await;
    Ok(())
}

/// Every bucket named in a stored submit body: the output bucket the agent
/// writes into, plus the input bucket staged for it (`file_bucket`).
pub(super) fn buckets_in_submit_payload(raw: &str) -> Vec<String> {
    let Ok(payload) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut buckets: Vec<String> = payload["output_bucket"]
        .as_str()
        .map(|s| vec![s.to_string()])
        .unwrap_or_default();
    if let Some(inputs) = payload["file_bucket"].as_array() {
        buckets.extend(inputs.iter().filter_map(|v| v.as_str()).map(ToOwned::to_owned));
    }
    buckets
}

/// Release the OffloadMQ buckets of a job that just reached a terminal state.
///
/// Input buckets are staged with `rm_after_task`, but that only fires when an
/// agent resolves the task — a job canceled while queued, or one whose task
/// vanished, would leave them behind. Output buckets carry no such flag at all,
/// since they must outlive the task long enough for us to download from them.
/// So both are dropped here, once nothing will read them again.
///
/// Best-effort: the job is already final and its files are stored, so a failure
/// only means the bucket waits for the server's TTL sweep, as it used to.
pub(super) async fn release_job_buckets(state: &AppState, job_id: i64) {
    let offload = match image_generation::get_offload_task_by_job(&state.db, job_id).await {
        Ok(Some(t)) => t,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!("imggen: cannot read offload row of job {job_id} to free buckets: {e}");
            return;
        }
    };
    state.watch.untrack(&offload.offload_cap, &offload.offload_task_id).await;
    let buckets = buckets_in_submit_payload(&offload.submit_payload);
    if buckets.is_empty() {
        return;
    }
    let client = match offload_factory::image_client(state).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("imggen: no client to free buckets of job {job_id}: {e}");
            return;
        }
    };
    for bucket in buckets {
        if let Err(e) = client.delete_bucket(&bucket).await {
            tracing::warn!("imggen: failed to free bucket {bucket} of job {job_id}: {e}");
        }
    }
}

pub(super) fn output_bucket_of(offload: &image_generation::ImageOffloadTask) -> Result<String, AppError> {
    let submit_payload: Value = serde_json::from_str(&offload.submit_payload)
        .map_err(|e| AppError::Internal(format!("invalid submit payload in db: {e}")))?;
    submit_payload["output_bucket"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::Internal("missing output_bucket".into()))
}

/// Pulls the `images` array from a poll payload, falling back to the cached
/// last-poll output when the live payload has none.
pub(super) fn collect_output_images(output: Option<&Value>, cached: Option<&str>) -> Vec<Value> {
    let images = images_array(output);
    if !images.is_empty() {
        return images;
    }
    cached
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .map(|v| images_array(Some(&v)))
        .unwrap_or_default()
}

pub(super) fn images_array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(|o| o.get("images"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// When duplicate output rows exist (race/legacy), expose one result. Keep the
/// video rather than a preview image, then prefer the latest timestamp/id.
pub(super) fn limit_job_output_files(
    files: Vec<image_generation::ImageFile>,
) -> Vec<image_generation::ImageFile> {
    let last_output = files
        .iter()
        .filter(|f| f.direction == "output")
        .max_by_key(|f| (f.content_type.starts_with("video/"), f.created_at, f.id))
        .cloned();
    let mut kept: Vec<_> = files.into_iter().filter(|f| f.direction != "output").collect();
    if let Some(out) = last_output {
        kept.push(out);
    }
    kept.sort_by_key(|f| f.created_at);
    kept
}

/// Extracts the `video` object from a poll payload, falling back to the cached last-poll output.
pub(super) fn collect_output_video(output: Option<&Value>, cached: Option<&str>) -> Option<Value> {
    if let Some(v) = output.and_then(|o| o.get("video")) {
        if v.is_object() {
            return Some(v.clone());
        }
    }
    let cached_value = cached.and_then(|c| serde_json::from_str::<Value>(c).ok())?;
    let v = cached_value.get("video")?;
    if v.is_object() { Some(v.clone()) } else { None }
}

/// Downloads a raw video file from the offload bucket and persists it to storage.
pub(super) async fn store_output_video(
    state: &AppState,
    client: &OffloadImageClient,
    user_id: i64,
    job: &image_generation::ImageGenerationJob,
    output_bucket: &str,
    video: &Value,
) -> Result<Vec<u8>, AppError> {
    let file_uid = video["file_uid"]
        .as_str()
        .ok_or_else(|| AppError::ExternalService("video output missing file_uid".into()))?;
    let filename = video["filename"]
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "output.mp4".to_string());
    let content_type = video["content_type"]
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "video/mp4".to_string());

    let (bytes, _) = download_with_retries(client, output_bucket, file_uid, 3).await?;
    let sha256 = image_processing::sha256_hex(&bytes);
    let stored_bytes = bytes.len() as i64;

    let file_id = state.next_id();
    let storage_path = image_paths::video_output_path(user_id, job.id, file_id, &filename);
    let thumbnail_storage_path = image_paths::thumbnail_path(user_id, file_id);
    let (thumbnail_bytes, bytes) = image_processing::thumbnail_from_video_async(bytes).await?;

    let op = storage::operator(state)?;
    storage::write(op, &storage_path, bytes).await?;
    storage::write(op, &thumbnail_storage_path, thumbnail_bytes.clone()).await?;

    image_generation::create_image_file(
        &state.db,
        image_generation::NewImageFileInput {
            id: file_id,
            user_id,
            job_id: Some(job.id),
            direction: "output",
            source: "offload_download",
            storage_path: &storage_path,
            thumbnail_storage_path: &thumbnail_storage_path,
            thumbnail_stored_bytes: thumbnail_bytes.len() as i64,
            filename: &filename,
            content_type: &content_type,
            original_bytes: None,
            stored_bytes,
            original_width: None,
            original_height: None,
            stored_width: 0,
            stored_height: 0,
            exif_orientation: None,
            rescaled: false,
            reencoded: false,
            sha256: &sha256,
            offload_bucket_uid: Some(output_bucket),
            offload_file_uid: Some(file_uid),
        },
    )
    .await?;
    if let Err(e) = record_image_generation_parameters(state, user_id, job, &filename).await {
        tracing::warn!(
            "failed to record generation parameters for video {file_id}: {e}"
        );
    }
    recalc_user_storage(state, user_id).await?;
    record_event(
        state,
        job.id,
        "download.video.store",
        "ok",
        Some(&format!("file_id={file_id} file_uid={file_uid}")),
    )
    .await?;
    Ok(thumbnail_bytes)
}

pub(super) async fn store_output_image(
    state: &AppState,
    client: &OffloadImageClient,
    user_id: i64,
    job: &image_generation::ImageGenerationJob,
    output_bucket: &str,
    idx: usize,
    image: &Value,
) -> Result<Vec<u8>, AppError> {
    let file_uid = image["file_uid"]
        .as_str()
        .ok_or_else(|| AppError::ExternalService("output image missing file_uid".into()))?;
    let filename = image["filename"]
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("output_{}.jpg", idx + 1));
    let processed = process_output_image(
        client,
        output_bucket,
        image,
        file_uid,
        job.prompt.trim(),
        image_processing::MAX_GENERATED_EDGE,
        None,
    )
    .await?;

    let image_id = state.next_id();
    let storage_path = image_paths::main_image_path(
        user_id,
        image_paths::MainImage::Output { job_id: job.id },
        image_id,
    );
    let stored = store_image(
        state,
        StoredImageSpec {
            image_id,
            user_id,
            job_id: Some(job.id),
            direction: "output",
            source: "offload_download",
            storage_path: &storage_path,
            filename: &filename,
            offload_bucket_uid: Some(output_bucket),
            offload_file_uid: Some(file_uid),
        },
        &processed,
    )
    .await?;
    // Keyed by the *stored* name, which is what the Files page looks properties up by.
    if let Err(e) = record_image_generation_parameters(state, user_id, job, &stored.filename).await {
        tracing::warn!(
            "failed to record generation parameters for image {image_id}: {e}"
        );
    }
    record_event(
        state,
        job.id,
        "download.image.store",
        "ok",
        Some(&format!("image_id={} file_uid={}", image_id, file_uid)),
    )
    .await?;
    Ok(processed.thumbnail_bytes)
}

pub(super) async fn record_image_generation_parameters(
    state: &AppState,
    user_id: i64,
    job: &image_generation::ImageGenerationJob,
    filename: &str,
) -> Result<(), AppError> {
    let pipeline = pipeline_params_for_job(job);
    let pipeline_value = serde_json::to_value(&pipeline)
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let parameters = serde_json::json!({
        "source": "image",
        "job_id": job.id.to_string(),
        "display_name": job.display_name,
        "prompt": job.prompt,
        "negative_prompt": job.negative_prompt,
        "capability": job.capability,
        "workflow": job.workflow,
        "width": job.width,
        "height": job.height,
        "seed": job.seed,
        "input_image_id": job.input_image_id.map(|i| i.to_string()),
        "pipeline_params": pipeline_value,
        "created_at": job.created_at.to_rfc3339(),
    });
    generation_parameters::upsert(
        &state.db,
        generation_parameters::UpsertInput {
            id: state.next_id(),
            user_id,
            filename,
            source: "image",
            parameters,
        },
    )
    .await
}

/// Decodes an inline base64 image when present, otherwise downloads it from the
/// offload bucket. Normalized to JPEG with the job prompt in EXIF.
pub(super) async fn process_output_image(
    client: &OffloadImageClient,
    output_bucket: &str,
    image: &Value,
    file_uid: &str,
    prompt: &str,
    max_edge: u32,
    exif_source: Option<&[u8]>,
) -> Result<ProcessedImage, AppError> {
    if let Some(data_base64) = image["data_base64"].as_str() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|e| AppError::ExternalService(format!("bad base64 image: {e}")))?;
        image_processing::process_generated_image_async(
            bytes,
            image["content_type"].as_str().map(ToOwned::to_owned),
            prompt.to_string(),
            max_edge,
            exif_source.map(<[u8]>::to_vec),
        )
        .await
    } else {
        let (bytes, content_type) = download_with_retries(client, output_bucket, file_uid, 3).await?;
        image_processing::process_generated_image_async(
            bytes,
            Some(content_type),
            prompt.to_string(),
            max_edge,
            exif_source.map(<[u8]>::to_vec),
        )
        .await
    }
}

/// Writes the processed pixels to storage and records the DB row.
pub(super) async fn store_image(
    state: &AppState,
    spec: StoredImageSpec<'_>,
    processed: &ProcessedImage,
) -> Result<image_generation::ImageFile, AppError> {
    let user_id = spec.user_id;
    let op = storage::operator(state)?;
    // The bytes are JPEG whatever the source was, so the name must say so — otherwise a
    // "cat.png" download is re-suffixed by the browser into "cat.png.jpg".
    let filename = if processed.content_type == "image/jpeg" {
        image_processing::jpeg_filename(spec.filename)
    } else {
        spec.filename.to_string()
    };
    let thumbnail_storage_path = image_paths::thumbnail_path(user_id, spec.image_id);
    storage::write(op, spec.storage_path, processed.bytes.clone()).await?;
    storage::write(
        op,
        &thumbnail_storage_path,
        processed.thumbnail_bytes.clone(),
    )
    .await?;
    let file = image_generation::create_image_file(
        &state.db,
        image_generation::NewImageFileInput {
            id: spec.image_id,
            user_id: spec.user_id,
            job_id: spec.job_id,
            direction: spec.direction,
            source: spec.source,
            storage_path: spec.storage_path,
            thumbnail_storage_path: &thumbnail_storage_path,
            thumbnail_stored_bytes: processed.thumbnail_bytes.len() as i64,
            filename: &filename,
            content_type: &processed.content_type,
            original_bytes: processed.original_bytes,
            stored_bytes: processed.bytes.len() as i64,
            original_width: processed.original_width,
            original_height: processed.original_height,
            stored_width: processed.width,
            stored_height: processed.height,
            exif_orientation: processed.exif_orientation,
            rescaled: processed.rescaled,
            reencoded: processed.reencoded,
            sha256: &processed.sha256,
            offload_bucket_uid: spec.offload_bucket_uid,
            offload_file_uid: spec.offload_file_uid,
        },
    )
    .await?;
    // Refresh the user's cached storage usage on every upload / offload download.
    recalc_user_storage(state, user_id).await?;
    Ok(file)
}

/// Recomputes a user's total stored bytes and writes it to the cached
/// `users.used_storage_bytes` column.
pub(super) async fn recalc_user_storage(state: &AppState, user_id: i64) -> Result<(), AppError> {
    let total = image_generation::sum_user_stored_bytes(&state.db, user_id).await?;
    users::update_used_storage(&state.db, user_id, total).await
}

/// Reconcile retries forever otherwise on a job whose output can never be
/// downloaded (e.g. the OffloadMQ output bucket was already reaped) — each
/// attempt was writing a `download.reconcile` event on every worker tick with
/// no backoff, so a single stuck job could accumulate hundreds of thousands of
/// rows over weeks. Give up after this many failures and mark the job failed.
pub(super) const MAX_RECONCILE_ATTEMPTS: u64 = 10;

pub(super) async fn reconcile_job_outputs_if_missing(
    state: &AppState,
    job: &image_generation::ImageGenerationJob,
    user_id: i64,
) -> Result<(), AppError> {
    let files = image_generation::list_job_files(&state.db, job.id).await?;
    if files.iter().any(|f| f.direction == "output") {
        return Ok(());
    }

    let prior_failures = image_generation::count_reconcile_failures(&state.db, job.id).await?;
    if prior_failures >= MAX_RECONCILE_ATTEMPTS {
        let msg = format!("output reconciliation gave up after {MAX_RECONCILE_ATTEMPTS} attempts");
        image_generation::update_job_status(&state.db, job.id, "failed", Some(&msg)).await?;
        release_job_buckets(state, job.id).await;
        return record_event(state, job.id, "download.reconcile", "error", Some(&msg)).await;
    }

    match fetch_and_store_outputs(state, user_id, job, None).await {
        Ok(()) => record_event(state, job.id, "download.reconcile", "ok", Some("reconcile success")).await,
        Err(e) => {
            record_event(state, job.id, "download.reconcile", "error", Some(&format!("reconcile failed: {e}")))
                .await
        }
    }
}

pub(super) async fn download_with_retries(
    client: &OffloadImageClient,
    output_bucket: &str,
    file_uid: &str,
    attempts: usize,
) -> Result<(Vec<u8>, String), AppError> {
    let mut last_err: Option<AppError> = None;
    for attempt in 0..attempts {
        match client.download_bucket_file(output_bucket, file_uid).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < attempts {
                    let backoff_ms = 250 * (attempt as u64 + 1);
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::ExternalService("download failed".into())))
}
