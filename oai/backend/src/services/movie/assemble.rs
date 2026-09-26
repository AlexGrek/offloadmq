//! Final phase: concatenating the rendered scene clips into the finished movie.

use super::*;

pub(super) async fn reconcile_assemble(state: &AppState, job: &mut movie::MovieJob) -> Result<(), AppError> {
    let scenes = parse_scenes(job)?;
    let op = storage::operator(state)?;
    let mut clips = Vec::with_capacity(scenes.len());
    for scene in &scenes {
        let Some(file_id) = scene.video_file_id else {
            job.status = "failed".into();
            job.error = Some(format!("scene {} is missing its rendered clip", scene.index + 1));
            return movie::update_job_state(&state.db, job).await;
        };
        let file = image_generation::get_image_file(&state.db, file_id, job.user_id)
            .await?
            .ok_or(AppError::NotFound)?;
        clips.push(storage::read(op, &file.storage_path).await?);
    }

    let movie_bytes = movie_ffmpeg::concat_videos(clips).await?;
    let (thumbnail_bytes, movie_bytes) =
        image_processing::thumbnail_from_video_async(movie_bytes).await?;

    let file_id = state.next_id();
    let storage_path = image_paths::movie_output_path(job.user_id, job.id, file_id);
    let thumbnail_storage_path = image_paths::thumbnail_path(job.user_id, file_id);
    storage::write(op, &storage_path, movie_bytes.clone()).await?;
    storage::write(op, &thumbnail_storage_path, thumbnail_bytes.clone()).await?;

    let sha256 = image_processing::sha256_hex(&movie_bytes);
    image_generation::create_image_file(
        &state.db,
        image_generation::NewImageFileInput {
            id: file_id,
            user_id: job.user_id,
            job_id: None,
            direction: "output",
            source: "movie",
            storage_path: &storage_path,
            thumbnail_storage_path: &thumbnail_storage_path,
            thumbnail_stored_bytes: thumbnail_bytes.len() as i64,
            filename: "movie.mp4",
            content_type: "video/mp4",
            original_bytes: None,
            stored_bytes: movie_bytes.len() as i64,
            original_width: None,
            original_height: None,
            stored_width: 0,
            stored_height: 0,
            exif_orientation: None,
            rescaled: false,
            reencoded: false,
            sha256: &sha256,
            offload_bucket_uid: None,
            offload_file_uid: None,
        },
    )
    .await?;
    recalc_user_storage(state, job.user_id).await?;

    job.movie_file_id = Some(file_id);
    job.status = "completed".into();
    job.phase = "done".into();
    movie::update_job_state(&state.db, job).await
}
