//! Director phase: turning the idea into a scene outline (LLM call, parsing, the
//! approval gate).

use super::*;

/// Replace the outline + scene records. Caller decides the resulting phase/status.
pub(super) fn set_outline(job: &mut movie::MovieJob, outline: &[String]) -> Result<(), AppError> {
    job.outline_json = serde_json::to_string(outline).map_err(json_err)?;
    let scenes: Vec<SceneRecord> = outline
        .iter()
        .enumerate()
        .map(|(i, o)| SceneRecord {
            index: i as i32,
            outline: o.clone(),
            prompt: None,
            workflow: String::new(),
            input_image_id: None,
            imggen_job_id: None,
            video_file_id: None,
            last_frame_image_id: None,
            status: "pending".into(),
            error: None,
            submitted_at: None,
            started_at: None,
            typical_runtime_seconds: None,
            execution_seconds: None,
        })
        .collect();
    job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
    job.current_scene = 0;
    job.offload_cap = None;
    job.offload_task_id = None;
    job.active_log = None;
    job.stage = None;
    Ok(())
}

/// Land on `scene_prompt`/running when auto-approve is on, else park at the
/// approval gate.
pub(super) fn apply_outline_and_gate(job: &mut movie::MovieJob, outline: &[String]) -> Result<(), AppError> {
    set_outline(job, outline)?;
    if job.auto_approve {
        job.phase = "scene_prompt".into();
        job.status = "running".into();
    } else {
        job.status = "awaitingApproval".into();
    }
    Ok(())
}

pub(super) fn split_or_repeat_idea(idea: &str, n: usize) -> Vec<String> {
    let lines: Vec<String> = idea
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() == n {
        lines
    } else {
        vec![idea.trim().to_string(); n]
    }
}

pub(super) fn strip_list_marker(line: &str) -> String {
    let trimmed = line.trim();
    for prefix in ["- ", "* ", "\u{2022} "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest.trim().to_string();
        }
    }
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        if let Some(sep) = trimmed.as_bytes().get(digits) {
            if *sep == b'.' || *sep == b')' {
                return trimmed[digits + 1..].trim().to_string();
            }
        }
    }
    trimmed.to_string()
}

pub(super) fn parse_outline(text: &str, n: usize) -> Vec<String> {
    let mut lines: Vec<String> = text
        .lines()
        .map(strip_list_marker)
        .filter(|l| !l.is_empty())
        .collect();
    lines.truncate(n);
    while lines.len() < n {
        lines.push(format!("Scene {}", lines.len() + 1));
    }
    lines
}

pub(super) async fn reconcile_director(state: &AppState, job: &mut movie::MovieJob) -> Result<(), AppError> {
    if job.offload_cap.is_none() && job.offload_task_id.is_none() {
        if !job.expand_prompt {
            let outline = split_or_repeat_idea(&job.idea, job.scene_count as usize);
            job.raw_outline = None;
            apply_outline_and_gate(job, &outline)?;
            return movie::update_job_state(&state.db, job).await;
        }

        let client = offload_factory::chat_client(state).await?;
        let user_content = format!(
            "{}\n\nProduce exactly {} scenes as a numbered list, one line each. Do not include any other text.",
            job.idea.trim(),
            job.scene_count
        );
        let messages = vec![
            ChatMessage { role: "system".into(), content: job.director_system.clone() },
            ChatMessage { role: "user".into(), content: user_content },
        ];
        let task_id = client.submit_chat(&job.director_model, messages, None, None, None, None).await?;
        state.watch.track(&task_id.cap, &task_id.id).await;
        job.offload_cap = Some(task_id.cap);
        job.offload_task_id = Some(task_id.id);
        job.active_log = None;
        job.stage = None;
        job.status = "running".into();
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

    match poll.status.as_str() {
        "completed" => {
            let text = task_status::extract_llm_text(&poll.output);
            state.watch.untrack(&task_id.cap, &task_id.id).await;
            if text.trim().is_empty() {
                job.status = "failed".into();
                job.error = Some("director returned an empty outline".into());
                job.offload_cap = None;
                job.offload_task_id = None;
            } else {
                let outline = parse_outline(&text, job.scene_count as usize);
                job.raw_outline = Some(text);
                apply_outline_and_gate(job, &outline)?;
            }
        }
        "failed" => {
            job.status = "failed".into();
            job.error = Some(task_status::extract_error_text(&poll.output, "director task failed"));
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
    movie::update_job_state(&state.db, job).await
}
