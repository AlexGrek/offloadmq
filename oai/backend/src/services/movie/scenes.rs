//! Per-scene phases: writing each scene's video prompt (vision LLM, optionally
//! seeded with the previous scene's last frame) and rendering it as a video job.

use super::*;

/// The frame to seed the scene's vision prompt (and, if long-shot, its
/// `img2video` input): the user-supplied first frame for scene 0, or the
/// previous scene's last frame in long-shot mode. `None` otherwise.
pub(super) fn scene_frame_source(job: &movie::MovieJob, scenes: &[SceneRecord], idx: usize) -> Option<i64> {
    if idx == 0 {
        return job.initial_image_id;
    }
    if job.long_shot {
        return scenes.get(idx - 1).and_then(|s| s.last_frame_image_id);
    }
    None
}

pub(super) fn build_scene_prompt_request(outline: &[String], scenes: &[SceneRecord], idx: usize) -> String {
    let full_outline = outline
        .iter()
        .enumerate()
        .map(|(i, o)| format!("{}. {}", i + 1, o))
        .collect::<Vec<_>>()
        .join("\n");
    let this_line = outline.get(idx).cloned().unwrap_or_default();
    let prev_prompt = scenes.get(idx.wrapping_sub(1)).and_then(|s| s.prompt.clone()).filter(|_| idx > 0);

    let mut parts = vec![
        format!("Full film outline ({} scenes):\n{}", outline.len(), full_outline),
        format!("You are writing the video-generation prompt for scene {} of {}.", idx + 1, outline.len()),
        format!("This scene's outline entry: {}", this_line),
    ];
    if let Some(prev) = prev_prompt.filter(|p| !p.is_empty()) {
        parts.push(format!("Previous scene's video prompt (for continuity): {prev}"));
    }
    parts.push("Respond with the video generation prompt only, no other text.".into());
    parts.join("\n\n")
}

pub(super) async fn reconcile_scene_prompt(state: &AppState, job: &mut movie::MovieJob) -> Result<(), AppError> {
    let mut scenes = parse_scenes(job)?;
    let idx = job.current_scene as usize;
    if idx >= scenes.len() {
        job.phase = "assemble".into();
        return movie::update_job_state(&state.db, job).await;
    }

    if job.offload_cap.is_none() && job.offload_task_id.is_none() {
        let outline = parse_job_outline(job)?;
        let user_text = build_scene_prompt_request(&outline, &scenes, idx);
        let frame_id = scene_frame_source(job, &scenes, idx);

        let task_id = if let Some(frame_id) = frame_id {
            let input = image_generation::get_image_file(&state.db, frame_id, job.user_id)
                .await?
                .ok_or(AppError::NotFound)?;
            let op = storage::operator(state)?;
            let bytes = storage::read(op, &input.storage_path).await?;
            let processed = image_processing::process_image_async(bytes, Some(input.content_type.clone())).await?;
            let img_client = offload_factory::image_client(state).await?;
            let bucket = img_client.create_bucket(true).await?;
            img_client
                .upload_bucket_file(&bucket.bucket_uid, processed.bytes, &input.filename, &processed.content_type)
                .await?;
            let chat_client = offload_factory::chat_client(state).await?;
            let messages = vec![
                serde_json::json!({ "role": "system", "content": job.scene_system }),
                serde_json::json!({ "role": "user", "content": user_text }),
            ];
            chat_client
                .submit_vision_task(&job.scene_model, messages, &bucket.bucket_uid, None)
                .await?
        } else {
            let chat_client = offload_factory::chat_client(state).await?;
            let messages = vec![
                ChatMessage { role: "system".into(), content: job.scene_system.clone() },
                ChatMessage { role: "user".into(), content: user_text },
            ];
            chat_client.submit_chat(&job.scene_model, messages, None, None, None, None).await?
        };

        state.watch.track(&task_id.cap, &task_id.id).await;
        job.offload_cap = Some(task_id.cap);
        job.offload_task_id = Some(task_id.id);
        job.active_log = None;
        job.stage = None;
        job.status = "running".into();
        scenes[idx].status = "prompting".into();
        scenes[idx].submitted_at = Some(chrono::Utc::now().fixed_offset());
        scenes[idx].started_at = None;
        scenes[idx].typical_runtime_seconds = None;
        scenes[idx].execution_seconds = None;
        job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
        return movie::update_job_state(&state.db, job).await;
    }

    let (Some(cap), Some(id)) = (job.offload_cap.clone(), job.offload_task_id.clone()) else {
        return Ok(());
    };
    let task_id = TaskId { cap, id };
    let client = offload_factory::chat_client(state).await?;
    let poll = match client.poll_task(&task_id).await {
        Ok(p) => p,
        Err(e) => {
            if let Some(reason) = task_status::offload_task_missing_message(&e) {
                job.status = "failed".into();
                job.error = Some(reason);
                job.offload_cap = None;
                job.offload_task_id = None;
                state.watch.untrack(&task_id.cap, &task_id.id).await;
                return movie::update_job_state(&state.db, job).await;
            }
            return Err(e);
        }
    };
    if let Some(log) = poll.log.filter(|l| !l.is_empty()) {
        job.active_log = Some(log);
    }
    if let Some(stage) = poll.stage {
        job.stage = Some(stage);
    }
    if scenes[idx].started_at.is_none() && matches!(poll.status.as_str(), "starting" | "running") {
        scenes[idx].started_at = Some(chrono::Utc::now().fixed_offset());
    }
    if let Some(typical) = poll.typical_runtime_seconds {
        scenes[idx].typical_runtime_seconds = Some(typical.as_secs_f64());
    }

    match poll.status.as_str() {
        "completed" => {
            let text = task_status::extract_llm_text(&poll.output);
            state.watch.untrack(&task_id.cap, &task_id.id).await;
            if text.trim().is_empty() {
                scenes[idx].status = "failed".into();
                scenes[idx].error = Some("scene director returned an empty prompt".into());
                job.status = "failed".into();
                job.error = Some(format!("scene {}: empty prompt from scene director", idx + 1));
                job.offload_cap = None;
                job.offload_task_id = None;
            } else {
                scenes[idx].prompt = Some(text.trim().to_string());
                scenes[idx].status = "rendering".into();
                job.phase = "video".into();
                job.offload_cap = None;
                job.offload_task_id = None;
                job.active_log = None;
                job.stage = None;
            }
        }
        "failed" => {
            let reason = task_status::extract_error_text(&poll.output, "scene director task failed");
            scenes[idx].status = "failed".into();
            scenes[idx].error = Some(reason.clone());
            job.status = "failed".into();
            job.error = Some(format!("scene {}: {reason}", idx + 1));
            job.offload_cap = None;
            job.offload_task_id = None;
            state.watch.untrack(&task_id.cap, &task_id.id).await;
        }
        "canceled" => {
            job.status = "canceled".into();
            job.offload_cap = None;
            job.offload_task_id = None;
            state.watch.untrack(&task_id.cap, &task_id.id).await;
        }
        _ => {
            // Still queued/assigned/starting upstream — keep the job movie-owned as
            // `running` so it stays visible to list_inflight_jobs; the raw detail is
            // already captured above via job.stage/job.active_log where applicable.
            job.status = "running".into();
        }
    }
    job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
    movie::update_job_state(&state.db, job).await
}

pub(super) async fn reconcile_video(state: &AppState, job: &mut movie::MovieJob) -> Result<(), AppError> {
    let mut scenes = parse_scenes(job)?;
    let idx = job.current_scene as usize;
    if idx >= scenes.len() {
        job.phase = "assemble".into();
        return movie::update_job_state(&state.db, job).await;
    }

    // No render started for this scene yet: submit it, then come back on the next pass.
    let Some(imggen_job_id) = scenes[idx].imggen_job_id else {
        let prompt = scenes[idx].prompt.clone().unwrap_or_default();
        if prompt.trim().is_empty() {
            job.status = "failed".into();
            job.error = Some(format!("scene {} has no prompt to render", idx + 1));
            return movie::update_job_state(&state.db, job).await;
        }
        let frame_id = scene_frame_source(job, &scenes, idx);
        let workflow = if frame_id.is_some() { "img2video" } else { "txt2video" };
        let capability = if workflow == "img2video" {
            job.img2video_capability.clone().ok_or_else(|| {
                AppError::Internal("scene requires img2video_capability but none is set".into())
            })?
        } else {
            job.txt2video_capability.clone()
        };

        let imggen_job_id = image_jobs::start_job(
            state,
            job.user_id,
            image_jobs::StartJobParams {
                capability,
                prompt,
                negative_prompt: None,
                override_negative: false,
                width: job.width,
                height: job.height,
                seed: None,
                workflow: Some(workflow.to_string()),
                input_image_id: frame_id.map(|id| id.to_string()),
                data_preparation: None,
                rescale: None,
                video_length: Some(job.scene_length),
                // Scene inputs are frames this pipeline just generated — already
                // small, so there is nothing for an agent to shrink.
                external_resize: false,
                prompt_template: None,
            },
        )
        .await?;

        scenes[idx].workflow = workflow.to_string();
        scenes[idx].input_image_id = frame_id;
        scenes[idx].imggen_job_id = Some(imggen_job_id);
        // Timings belong to the imggen job now — drop the scene-director's
        // prompting-phase values so the progress bar doesn't show stale numbers.
        scenes[idx].submitted_at = None;
        scenes[idx].started_at = None;
        scenes[idx].typical_runtime_seconds = None;
        scenes[idx].execution_seconds = None;
        job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
        return movie::update_job_state(&state.db, job).await;
    };

    let polled = image_jobs::poll_job(state, job.user_id, imggen_job_id).await?;
    scenes[idx].submitted_at = polled.submitted_at;
    scenes[idx].started_at = polled.started_at;
    scenes[idx].typical_runtime_seconds = polled.typical_runtime_seconds;

    match polled.status.as_str() {
        "completed" => {
            let Some(video_file) = polled.output_files.iter().find(|f| f.content_type.starts_with("video/")) else {
                // Output not persisted yet (race with the imggen worker's own
                // download step) — retry on the next reconcile pass.
                job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
                return movie::update_job_state(&state.db, job).await;
            };
            let video_file_id = video_file.id;
            let video_storage_path = video_file.storage_path.clone();
            scenes[idx].video_file_id = Some(video_file_id);
            scenes[idx].status = "completed".into();
            scenes[idx].execution_seconds = polled.execution_seconds;

            let is_last = idx + 1 >= scenes.len();
            if job.long_shot && !is_last {
                let op = storage::operator(state)?;
                let bytes = storage::read(op, &video_storage_path).await?;
                let frame_bytes = movie_ffmpeg::last_frame_jpeg(bytes).await?;
                let uploaded = image_jobs::upload_input_image(
                    state,
                    job.user_id,
                    format!("scene-{}-lastframe.jpg", idx + 1),
                    frame_bytes,
                    "image/jpeg".to_string(),
                )
                .await?;
                scenes[idx].last_frame_image_id = Some(uploaded.id);
            }

            if is_last {
                job.phase = "assemble".into();
            } else {
                job.current_scene += 1;
                job.phase = "scene_prompt".into();
            }
        }
        "failed" | "canceled" => {
            let reason = polled.error.clone().unwrap_or_else(|| "video generation failed".into());
            scenes[idx].status = "failed".into();
            scenes[idx].error = Some(reason.clone());
            job.status = "failed".into();
            job.error = Some(format!("scene {}: {reason}", idx + 1));
        }
        _ => {
            // Still in flight — timings above already captured this pass's
            // progress snapshot; nothing else to do until it's terminal.
        }
    }
    job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
    movie::update_job_state(&state.db, job).await
}
