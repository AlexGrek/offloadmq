//! Background Remover job orchestration (`onnx.bgremove.*`). A job stages one stored
//! image into an OffloadMQ input bucket, submits a task with an output bucket, and
//! stores the produced cutout back into `image_files` on completion. Wire contract:
//! `docs/bgremove-api.md`; OAI-side behaviour: `docs/oai-bg-remover.md`.
//!
//! The poll/cancel/reconcile state machine is the generic [`offload_job`] driver; this
//! module supplies the feature-specific pieces: capability listing, option validation,
//! the submit, and the completed-result handler. Output arrives as bucket files, so —
//! like music generation and image tools — it polls with the image client.
//!
//! Unlike every other image feature the result is usually a *transparent PNG/WebP*, which
//! the shared JPEG-normalizing store would flatten; see
//! [`image_jobs::store_offload_cutout_image`].

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{
    db::{
        bg_remover, entities::bg_remover_jobs::Entity as BgRemoverJobEntity, image_generation,
        offload_jobs,
    },
    error::AppError,
    offload::task_status::{self, NormalizedPoll, OffloadPoller},
    services::{
        image_jobs, image_processing, offload_factory,
        offload_job::{self, CancelOutcome, JobReconciler},
        storage,
    },
    state::AppState,
};

pub const CAPABILITY_PREFIX: &str = "onnx.bgremove.";

/// The model the page preselects: keeps held props and handles both anime and photos
/// (see the PoC in `docs/bgremove-api.md`).
pub const DEFAULT_MODEL: &str = "birefnet-general";

/// `image_files.source` of a stored cutout.
const OUTPUT_SOURCE: &str = "bg-remover";

const MAX_PADDING: u32 = 4096;

/// One background-removal model advertised by an online agent.
#[derive(Debug, Serialize)]
pub struct BgRemoverCapability {
    /// Base capability, e.g. `onnx.bgremove.birefnet-general`.
    pub base: String,
    /// Capability minus the prefix, e.g. `birefnet-general`.
    pub model: String,
    pub raw: String,
}

/// Models currently online, [`DEFAULT_MODEL`] first. A model is only advertised once its
/// file is on the agent's disk, so an empty list means "none installed" as much as
/// "no agent online".
pub async fn list_capabilities(state: &AppState) -> Result<Vec<BgRemoverCapability>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let found = client.list_capabilities_with_prefix(CAPABILITY_PREFIX).await?;
    Ok(sort_capabilities(
        found
            .into_iter()
            .filter(|c| c.base.len() > CAPABILITY_PREFIX.len())
            .map(|c| BgRemoverCapability {
                model: c.base[CAPABILITY_PREFIX.len()..].to_string(),
                base: c.base,
                raw: c.raw,
            })
            .collect(),
    ))
}

/// Below this mean alpha the model found (almost) no subject; above [`HIGH_FOREGROUND_RATIO`]
/// it kept (almost) everything.
const LOW_FOREGROUND_RATIO: f64 = 0.01;
const HIGH_FOREGROUND_RATIO: f64 = 0.95;

/// A hint when a finished result looks wrong, per the guidance in `docs/bgremove-api.md`
/// (same thresholds as `foregroundWarning` in the web UI). A cropped result is mostly subject
/// by construction, so "kept everything" does not apply to it.
pub fn foreground_warning(ratio: Option<f64>, cropped: bool) -> Option<&'static str> {
    let ratio = ratio?;
    if ratio < LOW_FOREGROUND_RATIO {
        Some("Almost nothing was kept — the model may not have found a subject. Try another model.")
    } else if ratio > HIGH_FOREGROUND_RATIO && !cropped {
        Some("Almost everything was kept — the background may not have been removed. Try another model.")
    } else {
        None
    }
}

/// Resolves a model name — `birefnet-general` or the full `onnx.bgremove.birefnet-general`,
/// case-insensitive — to an online capability; `None` picks the first (the default model when
/// it is online). Never falls back to a different model than the one asked for.
pub fn pick_capability<'a>(
    caps: &'a [BgRemoverCapability],
    name: Option<&str>,
) -> Result<&'a BgRemoverCapability, AppError> {
    let name = name.map(str::trim).filter(|n| !n.is_empty());
    let Some(first) = caps.first() else {
        return Err(AppError::BadRequest(
            "no background-removal model is online (install one on an agent: bgremove-birefnet-general)"
                .into(),
        ));
    };
    let Some(name) = name else {
        return Ok(first);
    };
    caps.iter()
        .find(|c| c.model.eq_ignore_ascii_case(name) || c.base.eq_ignore_ascii_case(name))
        .ok_or_else(|| {
            let online: Vec<&str> = caps.iter().map(|c| c.model.as_str()).collect();
            AppError::BadRequest(format!(
                "model `{name}` is not online; online models: {}",
                online.join(", ")
            ))
        })
}

/// De-duplicated (several agents advertise the same model) and ordered: default first,
/// the rest alphabetically.
fn sort_capabilities(mut caps: Vec<BgRemoverCapability>) -> Vec<BgRemoverCapability> {
    caps.sort_by(|a, b| {
        (a.model != DEFAULT_MODEL, &a.model).cmp(&(b.model != DEFAULT_MODEL, &b.model))
    });
    caps.dedup_by(|a, b| a.base == b.base);
    caps
}

/// What to produce, as the client sends it and as it is stored for retry. Every field is
/// optional on the wire; [`BgRemoverOptions::normalized`] fills defaults and validates, so
/// a typo is a 400 on submit instead of a job that queues and then fails on the agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BgRemoverOptions {
    /// `png`, `webp` (both can be transparent) or `jpeg` (always flattened).
    pub format: String,
    /// `transparent` or `#RRGGBB`.
    pub background: String,
    /// Trim the output to the subject's bounding box.
    pub crop: bool,
    /// Margin around the crop, in pixels. Only meaningful with `crop`.
    pub padding: u32,
    /// Fix the colour of semi-transparent edge pixels so the old background does not
    /// halo around hair. On unless the raw input colours are wanted.
    pub refine_foreground: bool,
    /// Turn the soft matte into hard 0/1 alpha at this cut-off (0..1, exclusive).
    pub alpha_threshold: Option<f64>,
    /// JPEG/WebP quality, 1–100.
    pub quality: Option<u8>,
}

impl Default for BgRemoverOptions {
    fn default() -> Self {
        Self {
            format: "png".into(),
            background: "transparent".into(),
            crop: false,
            padding: 0,
            refine_foreground: true,
            alpha_threshold: None,
            quality: None,
        }
    }
}

impl BgRemoverOptions {
    /// Validate and canonicalize, so what is stored is exactly what ran.
    pub fn normalized(mut self) -> Result<Self, AppError> {
        self.format = match self.format.trim().to_ascii_lowercase().as_str() {
            "png" | "" => "png".into(),
            "webp" => "webp".into(),
            "jpeg" | "jpg" => "jpeg".into(),
            other => {
                return Err(AppError::BadRequest(format!(
                    "format must be png, webp or jpeg, got `{other}`"
                )));
            }
        };

        let background = self.background.trim().to_ascii_lowercase();
        self.background = match background.as_str() {
            "" | "transparent" | "none" => "transparent".into(),
            hex => {
                let digits = hex.strip_prefix('#').unwrap_or(hex);
                if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(AppError::BadRequest(format!(
                        "background must be `transparent` or `#RRGGBB`, got `{}`",
                        self.background.trim()
                    )));
                }
                format!("#{}", digits.to_ascii_uppercase())
            }
        };
        // JPEG cannot hold transparency. The agent would default to white; say so
        // explicitly so the stored options match the result.
        if self.format == "jpeg" && self.background == "transparent" {
            self.background = "#FFFFFF".into();
        }

        if self.padding > MAX_PADDING {
            return Err(AppError::BadRequest(format!(
                "padding must be between 0 and {MAX_PADDING}"
            )));
        }
        if !self.crop {
            self.padding = 0;
        }

        if let Some(t) = self.alpha_threshold
            && !(t.is_finite() && t > 0.0 && t < 1.0)
        {
            return Err(AppError::BadRequest(
                "alpha_threshold must be between 0 and 1 (exclusive)".into(),
            ));
        }

        match self.quality {
            Some(q) if !(1..=100).contains(&q) => {
                return Err(AppError::BadRequest(
                    "quality must be between 1 and 100".into(),
                ));
            }
            // PNG is lossless — nothing to tune.
            Some(_) if self.format == "png" => self.quality = None,
            _ => {}
        }
        Ok(self)
    }

    /// The OffloadMQ task payload (`docs/bgremove-api.md`). `output_bucket` travels in
    /// the task envelope, not here.
    pub fn to_task_payload(&self, input_name: &str) -> serde_json::Value {
        let mut payload = serde_json::json!({
            "input_image": input_name,
            "format": self.format,
            "background": self.background,
            "crop": self.crop,
            "padding": self.padding,
            "refine_foreground": self.refine_foreground,
        });
        if let Some(t) = self.alpha_threshold {
            payload["alpha_threshold"] = t.into();
        }
        if let Some(q) = self.quality {
            payload["quality"] = q.into();
        }
        payload
    }

    /// Parse options stored by [`start_job`]; unreadable JSON falls back to the defaults.
    pub fn from_stored(json: Option<&str>) -> Self {
        json.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
    }
}

pub struct StartJobParams {
    pub capability: String,
    pub input_image_id: i64,
    pub options: BgRemoverOptions,
}

/// Drives the generic poll/cancel/reconcile lifecycle for background-remover jobs.
struct BgRemoverReconciler;

#[async_trait]
impl JobReconciler for BgRemoverReconciler {
    type Entity = BgRemoverJobEntity;

    fn label(&self) -> &'static str {
        "bg_remover"
    }

    fn failure_fallback(&self) -> &'static str {
        "background removal task failed"
    }

    async fn poller(&self, state: &AppState) -> Result<Box<dyn OffloadPoller>, AppError> {
        Ok(Box::new(offload_factory::image_client(state).await?))
    }

    /// Keep the progress-bar inputs current: when execution began on an agent, and how
    /// long this capability usually takes.
    async fn on_poll(
        &self,
        state: &AppState,
        job: &bg_remover::BgRemoverJob,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError> {
        bg_remover::record_progress(
            &state.db,
            job.id,
            task_status::is_executing(&poll.status),
            poll.typical_runtime_seconds,
        )
        .await
    }

    async fn on_completed(
        &self,
        state: &AppState,
        job: &bg_remover::BgRemoverJob,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError> {
        // Already finalized by a concurrent poll — nothing to download twice.
        if job.output_image_id.is_some() {
            return Ok(());
        }
        let fail = |reason: &'static str| async move {
            offload_jobs::update_status::<BgRemoverJobEntity>(
                &state.db,
                job.id,
                "failed",
                None,
                Some(reason),
            )
            .await
        };

        let Some(output) = poll.output.as_ref() else {
            return fail("background removal returned no output").await;
        };
        let Some(image) = output
            .get("images")
            .and_then(|v| v.as_array())
            .and_then(|a| a.last())
        else {
            return fail("background removal returned no output images").await;
        };
        // No reference to fetch means retrying can never succeed — fail now rather than
        // let the background worker re-poll this job forever.
        if image.get("file_uid").and_then(|v| v.as_str()).is_none()
            && image.get("data_base64").and_then(|v| v.as_str()).is_none()
        {
            return fail("background removal output has neither file_uid nor data_base64").await;
        }
        let Some(bucket) = job
            .output_bucket_uid
            .as_deref()
            .or_else(|| output.get("output_bucket").and_then(|v| v.as_str()))
        else {
            return fail("background removal output has no bucket to download from").await;
        };

        // Name the result after the picture it came from (`hero.jpg` → `hero_cutout.png`).
        let stem = match job.input_image_id {
            Some(id) => image_generation::get_image_file(&state.db, id, job.user_id)
                .await?
                .map(|f| cutout_stem(&f.filename)),
            None => None,
        };
        let file = image_jobs::store_offload_cutout_image(
            state,
            job.user_id,
            OUTPUT_SOURCE,
            bucket,
            image,
            stem.as_deref(),
        )
        .await?;
        // The output bucket is released by the generic driver once this returns — see
        // `offload_job::release_bucket`.
        bg_remover::set_output_image(
            &state.db,
            job.id,
            file.id,
            image.get("foreground_ratio").and_then(|v| v.as_f64()),
        )
        .await
    }
}

/// `hero.jpg` → `hero_cutout`. Only a trailing *image* extension is dropped, so
/// `v2.final` keeps its dot; an empty stem falls back to a plain `cutout`.
fn cutout_stem(input_filename: &str) -> String {
    let name = input_filename.trim();
    let stem = match name.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty()
                && matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "heic"
                        | "heif" | "avif" | "jxl"
                ) =>
        {
            stem
        }
        _ => name,
    };
    if stem.is_empty() {
        "cutout".to_string()
    } else {
        format!("{stem}_cutout")
    }
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    params: StartJobParams,
) -> Result<i64, AppError> {
    storage::operator(state)?;

    let capability = crate::offload::base_capability(&params.capability).to_string();
    if capability.len() <= CAPABILITY_PREFIX.len() || !capability.starts_with(CAPABILITY_PREFIX) {
        return Err(AppError::BadRequest(format!(
            "capability must start with `{CAPABILITY_PREFIX}`"
        )));
    }
    let options = params.options.normalized()?;

    let input = image_generation::get_image_file(&state.db, params.input_image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;

    let options_json = serde_json::to_string(&options)
        .map_err(|e| AppError::Internal(format!("serialize options: {e}")))?;
    let job_id = state.next_id();
    bg_remover::create_job(
        &state.db,
        bg_remover::NewJobInput {
            id: job_id,
            user_id,
            capability: &capability,
            input_image_id: Some(input.id),
            options_json: Some(&options_json),
        },
    )
    .await?;

    let client = offload_factory::image_client(state).await?;
    let in_bucket = client.create_bucket(true).await?;
    let out_bucket = client.create_bucket(false).await?;

    let op = storage::operator(state)?;
    let bytes = storage::read(op, &input.storage_path).await?;
    // Normalized (EXIF orientation applied, longest edge capped) JPEG: bounds what the
    // agent has to decode, however large the stored original is.
    let processed =
        image_processing::process_image_async(bytes, Some(input.content_type.clone())).await?;
    let input_name = format!("input_{}.jpg", input.id);
    client
        .upload_bucket_file(
            &in_bucket.bucket_uid,
            processed.bytes,
            &input_name,
            &processed.content_type,
        )
        .await?;

    let (task_id, _) = client
        .submit_img_task(
            &capability,
            options.to_task_payload(&input_name),
            Some(&in_bucket.bucket_uid),
            &out_bucket.bucket_uid,
            None,
        )
        .await?;

    offload_jobs::set_offload_task::<BgRemoverJobEntity>(
        &state.db,
        job_id,
        &task_id.cap,
        &task_id.id,
        Some(&out_bucket.bucket_uid),
    )
    .await?;
    state.watch.track(&task_id.cap, &task_id.id).await;

    Ok(job_id)
}

pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = offload_jobs::get_job::<BgRemoverJobEntity>(&state.db, job_id, user_id)
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
            input_image_id,
            options: BgRemoverOptions::from_stored(job.options_json.as_deref()),
        },
    )
    .await
}

pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelOutcome, AppError> {
    offload_job::cancel_job(&BgRemoverReconciler, state, user_id, job_id).await
}

/// Delete a job and the cutout it produced. The *input* image is a user upload shared
/// with the rest of the app, so it is deliberately left alone.
pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    let job = offload_jobs::get_job::<BgRemoverJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if let Some(image_id) = job.output_image_id
        && let Err(e) = image_jobs::remove_user_image(state, user_id, image_id).await
    {
        tracing::warn!("bg_remover: failed to remove output image {image_id}: {e}");
    }
    offload_jobs::delete_job::<BgRemoverJobEntity>(&state.db, job_id, user_id).await
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<bg_remover::BgRemoverJob, AppError> {
    offload_job::poll_job(&BgRemoverReconciler, state, user_id, job_id).await
}

pub async fn get_user_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<bg_remover::BgRemoverJob, AppError> {
    offload_jobs::get_job::<BgRemoverJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<bg_remover::BgRemoverJob>, AppError> {
    offload_jobs::list_jobs::<BgRemoverJobEntity>(&state.db, user_id, limit).await
}

/// Background worker pass: advances in-flight background-remover jobs.
pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    offload_job::reconcile_pass(&BgRemoverReconciler, state, batch_size).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> BgRemoverOptions {
        BgRemoverOptions::default()
    }

    #[test]
    fn defaults_are_a_transparent_png() {
        let o = opts().normalized().unwrap();
        assert_eq!((o.format.as_str(), o.background.as_str()), ("png", "transparent"));
        assert!(o.refine_foreground && !o.crop);
    }

    #[test]
    fn partial_json_fills_defaults() {
        let o: BgRemoverOptions = serde_json::from_str(r##"{"crop":true,"padding":16}"##).unwrap();
        let o = o.normalized().unwrap();
        assert_eq!((o.format.as_str(), o.crop, o.padding), ("png", true, 16));
        assert!(o.refine_foreground);
    }

    #[test]
    fn jpeg_is_never_transparent() {
        let o = BgRemoverOptions { format: "JPG".into(), ..opts() }.normalized().unwrap();
        assert_eq!((o.format.as_str(), o.background.as_str()), ("jpeg", "#FFFFFF"));
    }

    #[test]
    fn background_colours_are_canonicalized() {
        for (input, want) in [("2b2b35", "#2B2B35"), ("#2b2B35", "#2B2B35"), (" None ", "transparent")] {
            let o = BgRemoverOptions { background: input.into(), ..opts() }.normalized().unwrap();
            assert_eq!(o.background, want, "{input}");
        }
        for bad in ["red", "#12345", "#12345g", "#1234567"] {
            assert!(
                BgRemoverOptions { background: bad.into(), ..opts() }.normalized().is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn padding_only_applies_with_crop() {
        let o = BgRemoverOptions { padding: 40, ..opts() }.normalized().unwrap();
        assert_eq!(o.padding, 0);
        let o = BgRemoverOptions { crop: true, padding: 40, ..opts() }.normalized().unwrap();
        assert_eq!(o.padding, 40);
        assert!(BgRemoverOptions { crop: true, padding: 4097, ..opts() }.normalized().is_err());
    }

    #[test]
    fn rejects_bad_numbers_and_formats() {
        assert!(BgRemoverOptions { format: "gif".into(), ..opts() }.normalized().is_err());
        for t in [0.0, 1.0, -0.1, f64::NAN, f64::INFINITY] {
            assert!(
                BgRemoverOptions { alpha_threshold: Some(t), ..opts() }.normalized().is_err(),
                "{t}"
            );
        }
        assert!(BgRemoverOptions { alpha_threshold: Some(0.5), ..opts() }.normalized().is_ok());
        for q in [0u8, 101] {
            assert!(
                BgRemoverOptions { format: "webp".into(), quality: Some(q), ..opts() }
                    .normalized()
                    .is_err(),
                "{q}"
            );
        }
    }

    #[test]
    fn quality_is_dropped_for_png() {
        let png = BgRemoverOptions { quality: Some(80), ..opts() }.normalized().unwrap();
        assert_eq!(png.quality, None);
        let webp = BgRemoverOptions { format: "webp".into(), quality: Some(80), ..opts() }
            .normalized()
            .unwrap();
        assert_eq!(webp.quality, Some(80));
    }

    #[test]
    fn task_payload_matches_the_agent_contract() {
        let payload = BgRemoverOptions {
            format: "jpeg".into(),
            background: "#2b2b35".into(),
            crop: true,
            padding: 16,
            alpha_threshold: Some(0.5),
            quality: Some(92),
            ..opts()
        }
        .normalized()
        .unwrap()
        .to_task_payload("input_7.jpg");
        assert_eq!(
            payload,
            serde_json::json!({
                "input_image": "input_7.jpg",
                "format": "jpeg",
                "background": "#2B2B35",
                "crop": true,
                "padding": 16,
                "refine_foreground": true,
                "alpha_threshold": 0.5,
                "quality": 92,
            })
        );
        let minimal = opts().normalized().unwrap().to_task_payload("a.jpg");
        assert!(minimal.get("alpha_threshold").is_none() && minimal.get("quality").is_none());
    }

    #[test]
    fn stored_options_round_trip_and_survive_garbage() {
        let o = BgRemoverOptions { crop: true, padding: 8, ..opts() }.normalized().unwrap();
        let json = serde_json::to_string(&o).unwrap();
        assert_eq!(BgRemoverOptions::from_stored(Some(&json)), o);
        assert_eq!(BgRemoverOptions::from_stored(Some("not json")), opts());
        assert_eq!(BgRemoverOptions::from_stored(None), opts());
    }

    #[test]
    fn foreground_warnings_match_the_web_ui() {
        assert!(foreground_warning(None, false).is_none());
        assert!(foreground_warning(Some(0.3), false).is_none());
        assert!(foreground_warning(Some(0.001), false).unwrap().contains("nothing"));
        assert!(foreground_warning(Some(0.99), false).unwrap().contains("everything"));
        // A crop is mostly subject by construction.
        assert!(foreground_warning(Some(0.99), true).is_none());
        assert!(foreground_warning(Some(0.001), true).is_some());
    }

    #[test]
    fn model_names_resolve_without_falling_back() {
        let cap = |m: &str| BgRemoverCapability {
            base: format!("{CAPABILITY_PREFIX}{m}"),
            model: m.into(),
            raw: format!("{CAPABILITY_PREFIX}{m}"),
        };
        let caps = vec![cap("birefnet-general"), cap("birefnet-lite")];
        assert_eq!(pick_capability(&caps, None).unwrap().model, "birefnet-general");
        assert_eq!(pick_capability(&caps, Some("  ")).unwrap().model, "birefnet-general");
        assert_eq!(pick_capability(&caps, Some("Birefnet-Lite")).unwrap().model, "birefnet-lite");
        assert_eq!(
            pick_capability(&caps, Some("onnx.bgremove.birefnet-lite")).unwrap().model,
            "birefnet-lite"
        );
        let err = pick_capability(&caps, Some("birefnet-portrait")).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(m) if m.contains("online models: birefnet-general, birefnet-lite")));
        assert!(pick_capability(&[], None).is_err());
    }

    #[test]
    fn cutout_names_follow_the_input() {
        assert_eq!(cutout_stem("hero.jpg"), "hero_cutout");
        assert_eq!(cutout_stem("Hero.PNG"), "Hero_cutout");
        assert_eq!(cutout_stem("v2.final"), "v2.final_cutout");
        assert_eq!(cutout_stem("noext"), "noext_cutout");
        assert_eq!(cutout_stem(""), "cutout");
        assert_eq!(cutout_stem(".png"), ".png_cutout");
    }

    #[test]
    fn capabilities_list_default_model_first_without_duplicates() {
        let cap = |m: &str| BgRemoverCapability {
            base: format!("{CAPABILITY_PREFIX}{m}"),
            model: m.into(),
            raw: format!("{CAPABILITY_PREFIX}{m}"),
        };
        let sorted = sort_capabilities(vec![
            cap("birefnet-lite"),
            cap("birefnet-portrait"),
            cap("birefnet-general"),
            cap("birefnet-lite"),
        ]);
        let models: Vec<_> = sorted.iter().map(|c| c.model.as_str()).collect();
        assert_eq!(models, ["birefnet-general", "birefnet-lite", "birefnet-portrait"]);
    }
}
