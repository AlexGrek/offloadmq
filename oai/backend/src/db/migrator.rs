use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20240101_000001_create_users::Migration),
            Box::new(m20260522_000002_add_admin_and_quotas_fields::Migration),
            Box::new(m20260522_000003_create_app_settings::Migration),
            Box::new(m20260522_000004_create_chats::Migration),
            Box::new(m20260522_000005_create_image_generation_tables::Migration),
            Box::new(m20260522_000006_create_image_worker_logs::Migration),
            Box::new(m20260522_000007_add_user_used_storage::Migration),
            Box::new(m20260522_000008_chat_system_prompts::Migration),
            Box::new(m20260522_000009_create_llm_capabilities::Migration),
            Box::new(m20260522_000010_image_job_pipeline_params::Migration),
            Box::new(m20260522_000011_image_job_display_name::Migration),
            Box::new(m20260522_000012_chat_last_model::Migration),
            Box::new(m20260522_000013_chat_message_offload_fields::Migration),
            Box::new(m20260522_000014_image_file_thumbnails::Migration),
            Box::new(m20260522_000015_create_imggen_capabilities::Migration),
            Box::new(m20260522_000016_create_image_analysis_jobs::Migration),
            Box::new(m20260522_000017_create_tts_jobs::Migration),
            Box::new(m20260522_000018_create_generation_parameters::Migration),
            Box::new(m20260524_000019_create_nude_detect_jobs::Migration),
            Box::new(m20260604_000020_image_analysis_data_preparation::Migration),
            Box::new(m20260604_000021_create_chat_attachments::Migration),
            Box::new(m20260604_000022_create_music_generation_jobs::Migration),
            Box::new(m20260604_000023_create_prompt_entries::Migration),
            Box::new(m20260613_000024_image_offload_task_started_at::Migration),
            Box::new(m20260615_000025_create_llm_compare_debate_jobs::Migration),
            Box::new(m20260615_000026_image_offload_typical_runtime::Migration),
            Box::new(m20260709_000027_image_offload_task_finished_at::Migration),
            Box::new(m20260722_000028_create_img_utils_jobs::Migration),
            Box::new(m20260730_000029_create_movie_jobs::Migration),
            Box::new(m20260731_000030_movie_split_video_capability::Migration),
            Box::new(m20260805_000031_img_utils_progress_timing::Migration),
            Box::new(m20260806_000032_image_analysis_external_resize::Migration),
            Box::new(m20260903_000033_create_prompt_placeholders::Migration),
            Box::new(m20260926_000034_prompt_entry_previews::Migration),
        ]
    }
}

mod m20240101_000001_create_users;
mod m20260522_000002_add_admin_and_quotas_fields;
mod m20260522_000003_create_app_settings;
mod m20260522_000004_create_chats;
mod m20260522_000005_create_image_generation_tables;
mod m20260522_000006_create_image_worker_logs;
mod m20260522_000007_add_user_used_storage;
mod m20260522_000008_chat_system_prompts;
mod m20260522_000009_create_llm_capabilities;
mod m20260522_000010_image_job_pipeline_params;
mod m20260522_000011_image_job_display_name;
mod m20260522_000012_chat_last_model;
mod m20260522_000013_chat_message_offload_fields;
mod m20260522_000014_image_file_thumbnails;
mod m20260522_000015_create_imggen_capabilities;
mod m20260522_000016_create_image_analysis_jobs;
mod m20260522_000017_create_tts_jobs;
mod m20260522_000018_create_generation_parameters;
mod m20260524_000019_create_nude_detect_jobs;
mod m20260604_000020_image_analysis_data_preparation;
mod m20260604_000021_create_chat_attachments;
mod m20260604_000022_create_music_generation_jobs;

/// Generic per-user prompt storage with named buckets (e.g. `llm-system`,
/// `describe-image-user`). Each entry is either a `recent` (auto-managed history,
/// last 10 unique per bucket) or a `starred` favorite (user-curated, editable).
/// Replaces the chat-only `user_system_prompts` table — existing rows are migrated
/// into the `llm-system` bucket before the old table is dropped.
mod m20260604_000023_create_prompt_entries;
mod m20260613_000024_image_offload_task_started_at;
mod m20260615_000025_create_llm_compare_debate_jobs;
mod m20260615_000026_image_offload_typical_runtime;
mod m20260709_000027_image_offload_task_finished_at;

/// `img-utils.*` jobs — one-shot ComfyUI image transforms (depth map, face swap,
/// …). Each job references one or two uploaded `image_files` rows as input and
/// stores the produced image as another `image_files` row.
mod m20260722_000028_create_img_utils_jobs;
mod m20260730_000029_create_movie_jobs;

/// Split the single `video_capability` into per-workflow capabilities: `txt2video`
/// and `img2video` are usually different agent-side models, so one column cannot
/// serve both. Existing rows ran with a single capability used for *both*
/// workflows, so it is copied into both columns to preserve their behavior.
mod m20260731_000030_movie_split_video_capability;

/// Progress-bar timing for img-utils jobs. `started_at` is stamped once, the
/// first time a poll shows the task actually executing on an agent (so the bar
/// measures run time, not queue wait); `typical_runtime_seconds` mirrors the
/// OffloadMQ runtime estimate. Same pair the image pipeline keeps on
/// `image_offload_tasks`, but img-utils has no offload-task table of its own.
mod m20260805_000031_img_utils_progress_timing;

/// Records whether a describe job shrank its input with an `image_resize`
/// pre-step on an agent rather than locally, so retry replays the same choice.
mod m20260806_000032_image_analysis_external_resize;

/// User-scoped, named, recursive prompt-placeholder templates, e.g. `{.cinematic}`
/// resolving to one of a few variant phrases. Resolved client-side (see frontend
/// `lib/promptPlaceholders.ts`); this table is pure storage. `variants_json` follows
/// the same plain-TEXT JSON-array convention as `imggen_capabilities.tags_json` —
/// no native jsonb/array column.
mod m20260903_000033_create_prompt_placeholders;

/// Image previews for saved prompts. `preview_updated_at` is non-null once an image
/// was generated from the entry's content; the blob itself lives in storage at a
/// content-derived path (`image_paths::prompt_preview_path`), so recent and starred
/// entries with identical text share it. The second index serves keyset paging of
/// favorites, which sort by `updated_at` (recents reuse the `last_used_at` index).
mod m20260926_000034_prompt_entry_previews;


#[cfg(test)]
mod movie_migration_idens {
    use super::m20260731_000030_movie_split_video_capability as m30;
    use sea_orm_migration::prelude::*;

    /// `DeriveIden` would render `Txt2VideoCapability` as `txt2_video_capability`,
    /// which does not match the entity field — hence the explicit `iden` attributes.
    #[test]
    fn migration_column_idens_match_entity_fields() {
        assert_eq!(m30::MovieJobs::Txt2VideoCapability.to_string(), "txt2video_capability");
        assert_eq!(m30::MovieJobs::Img2VideoCapability.to_string(), "img2video_capability");
        assert_eq!(m30::MovieJobs::VideoCapability.to_string(), "video_capability");
    }
}
