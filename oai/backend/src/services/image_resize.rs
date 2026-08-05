//! Payload rules for the built-in `image_resize` capability — the "Basic resize"
//! tool on the Image Tools page.
//!
//! Unlike the `img-utils.*` transforms this needs no ComfyUI: every agent
//! advertises `image_resize` because Pillow is one of its hard dependencies, so
//! the tool is online whenever *any* agent is. The trade-off is that all the
//! knobs live in the payload rather than in a workflow file, which is what this
//! module validates.
//!
//! Options are validated here rather than left to the agent so a typo comes back
//! as a 400 on submit instead of a job that queues, runs and fails minutes later.
//!
//! Wire contract: `docs/image-resize-api.md`.

use serde_json::{Map, Value};

use crate::{error::AppError, services::image_processing::MAX_IMAGE_EDGE};

/// Interpretations of the target box, mirroring the agent's `mode` field.
const MODES: [&str; 3] = ["fit", "exact", "cover"];
/// Output container formats the agent can encode.
const FORMATS: [&str; 5] = ["png", "jpeg", "webp", "bmp", "tiff"];
/// Upper bound on `scale`. Anything larger is pointless: OAI stores every image
/// downscaled to [`MAX_IMAGE_EDGE`], so the extra pixels would be thrown away.
const MAX_SCALE: f64 = 4.0;

/// A validated "Basic resize" request. Persisted as the job's `options_json`, so
/// retry replays exactly what the user asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct ResizeOptions {
    /// Resampling filter; `None` lets the agent apply its default (`lanczos`).
    pub method: Option<String>,
    pub mode: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub scale: Option<f64>,
    pub format: Option<String>,
    pub quality: Option<i64>,
    pub allow_upscale: Option<bool>,
}

impl ResizeOptions {
    /// Parse and validate the options a client sent with a resize job.
    ///
    /// `available_methods` are the filters the chosen capability advertised in
    /// its brackets; an empty list means the agent published none, in which case
    /// any method name is passed through untouched.
    pub fn parse(
        options: Option<&Map<String, Value>>,
        available_methods: &[String],
    ) -> Result<Self, AppError> {
        let empty = Map::new();
        let opts = options.unwrap_or(&empty);

        let method = opt_string(opts, "method")?;
        if let Some(m) = method.as_deref() {
            if !available_methods.is_empty() && !available_methods.iter().any(|a| a == m) {
                return Err(bad(format!(
                    "unsupported method `{m}` — this agent offers: {}",
                    available_methods.join(", ")
                )));
            }
        }

        let mode = opt_string(opts, "mode")?.unwrap_or_else(|| "fit".to_string());
        if !MODES.contains(&mode.as_str()) {
            return Err(bad(format!(
                "unsupported mode `{mode}` — expected one of: {}",
                MODES.join(", ")
            )));
        }

        let width = opt_dimension(opts, "width")?;
        let height = opt_dimension(opts, "height")?;
        let scale = opt_scale(opts)?;

        if scale.is_none() && width.is_none() && height.is_none() {
            return Err(bad(
                "nothing to resize to — set a scale, or a width and/or height".into(),
            ));
        }
        if scale.is_none() && mode != "fit" && (width.is_none() || height.is_none()) {
            return Err(bad(format!("mode `{mode}` needs both a width and a height")));
        }

        let format = opt_string(opts, "format")?.map(|f| f.to_ascii_lowercase());
        if let Some(f) = format.as_deref() {
            if !FORMATS.contains(&f) {
                return Err(bad(format!(
                    "unsupported format `{f}` — expected one of: {}",
                    FORMATS.join(", ")
                )));
            }
        }

        let quality = opt_i64(opts, "quality")?;
        if let Some(q) = quality {
            if !(1..=100).contains(&q) {
                return Err(bad(format!("quality must be between 1 and 100, got {q}")));
            }
        }

        let allow_upscale = match opts.get("allow_upscale") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => return Err(bad("allow_upscale must be true or false".into())),
        };

        Ok(Self { method, mode, width, height, scale, format, quality, allow_upscale })
    }

    /// Round-trip back into the job's stored option map (and the retry path).
    pub fn to_map(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("mode".into(), Value::String(self.mode.clone()));
        if let Some(m) = &self.method {
            map.insert("method".into(), Value::String(m.clone()));
        }
        if let Some(w) = self.width {
            map.insert("width".into(), Value::from(w));
        }
        if let Some(h) = self.height {
            map.insert("height".into(), Value::from(h));
        }
        if let Some(s) = self.scale {
            map.insert("scale".into(), Value::from(s));
        }
        if let Some(f) = &self.format {
            map.insert("format".into(), Value::String(f.clone()));
        }
        if let Some(q) = self.quality {
            map.insert("quality".into(), Value::from(q));
        }
        if let Some(a) = self.allow_upscale {
            map.insert("allow_upscale".into(), Value::Bool(a));
        }
        map
    }

    /// The OffloadMQ task payload. `image_resize` takes its parameters flat —
    /// there is no `workflow` field and no `secondary_prompts` envelope.
    pub fn to_task_payload(&self, input_name: &str) -> Value {
        let mut payload = self.to_map();
        payload.insert("input_image".into(), Value::String(input_name.to_string()));
        Value::Object(payload)
    }
}

fn bad(message: String) -> AppError {
    AppError::BadRequest(message)
}

fn opt_string(opts: &Map<String, Value>, key: &str) -> Result<Option<String>, AppError> {
    match opts.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim().to_string()).filter(|s| !s.is_empty())),
        Some(_) => Err(bad(format!("{key} must be a string"))),
    }
}

fn opt_i64(opts: &Map<String, Value>, key: &str) -> Result<Option<i64>, AppError> {
    match opts.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| bad(format!("{key} must be a whole number"))),
        Some(_) => Err(bad(format!("{key} must be a number"))),
    }
}

fn opt_dimension(opts: &Map<String, Value>, key: &str) -> Result<Option<i64>, AppError> {
    let Some(value) = opt_i64(opts, key)? else {
        return Ok(None);
    };
    let max = i64::from(MAX_IMAGE_EDGE);
    if value < 1 || value > max {
        // Not an agent limit — OAI itself downscales every stored image to
        // MAX_IMAGE_EDGE, so a larger request could never be delivered.
        return Err(bad(format!(
            "{key} must be between 1 and {max} pixels, got {value}"
        )));
    }
    Ok(Some(value))
}

fn opt_scale(opts: &Map<String, Value>) -> Result<Option<f64>, AppError> {
    match opts.get("scale") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => {
            let value = n
                .as_f64()
                .ok_or_else(|| bad("scale must be a number".into()))?;
            if !value.is_finite() || value <= 0.0 || value > MAX_SCALE {
                return Err(bad(format!(
                    "scale must be greater than 0 and at most {MAX_SCALE}, got {value}"
                )));
            }
            Ok(Some(value))
        }
        Some(_) => Err(bad("scale must be a number".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(json: Value) -> Map<String, Value> {
        json.as_object().expect("object").clone()
    }

    fn methods() -> Vec<String> {
        ["nearest", "lanczos"].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_to_fit() {
        let opts = ResizeOptions::parse(Some(&map(serde_json::json!({ "width": 800 }))), &[])
            .expect("valid");
        assert_eq!(opts.mode, "fit");
        assert_eq!(opts.width, Some(800));
        assert_eq!(opts.method, None);
    }

    #[test]
    fn rejects_empty_target() {
        assert!(ResizeOptions::parse(None, &[]).is_err());
        assert!(ResizeOptions::parse(Some(&map(serde_json::json!({ "mode": "fit" }))), &[]).is_err());
    }

    #[test]
    fn rejects_method_the_agent_does_not_offer() {
        let opts = map(serde_json::json!({ "width": 100, "method": "bicubic" }));
        assert!(ResizeOptions::parse(Some(&opts), &methods()).is_err());
        // With no advertised list there is nothing to check against.
        assert!(ResizeOptions::parse(Some(&opts), &[]).is_ok());
    }

    #[test]
    fn rejects_dimensions_beyond_the_stored_image_limit() {
        let too_big = i64::from(MAX_IMAGE_EDGE) + 1;
        let opts = map(serde_json::json!({ "width": too_big }));
        assert!(ResizeOptions::parse(Some(&opts), &[]).is_err());
    }

    #[test]
    fn exact_and_cover_need_both_dimensions() {
        for mode in ["exact", "cover"] {
            let one = map(serde_json::json!({ "mode": mode, "width": 100 }));
            assert!(ResizeOptions::parse(Some(&one), &[]).is_err(), "{mode}");
            let both = map(serde_json::json!({ "mode": mode, "width": 100, "height": 100 }));
            assert!(ResizeOptions::parse(Some(&both), &[]).is_ok(), "{mode}");
        }
    }

    #[test]
    fn scale_alone_is_enough_for_any_mode() {
        let opts = map(serde_json::json!({ "mode": "cover", "scale": 0.5 }));
        assert_eq!(
            ResizeOptions::parse(Some(&opts), &[]).expect("valid").scale,
            Some(0.5)
        );
    }

    #[test]
    fn rejects_out_of_range_values() {
        for bad in [
            serde_json::json!({ "width": 100, "quality": 0 }),
            serde_json::json!({ "width": 100, "quality": 101 }),
            serde_json::json!({ "scale": 0 }),
            serde_json::json!({ "scale": 99 }),
            serde_json::json!({ "width": 0 }),
            serde_json::json!({ "width": 100, "mode": "squash" }),
            serde_json::json!({ "width": 100, "format": "heif" }),
            serde_json::json!({ "width": 100, "allow_upscale": "yes" }),
        ] {
            assert!(
                ResizeOptions::parse(Some(&map(bad.clone())), &[]).is_err(),
                "expected {bad} to be rejected"
            );
        }
    }

    #[test]
    fn payload_is_flat_and_carries_the_input_name() {
        let opts = ResizeOptions::parse(
            Some(&map(serde_json::json!({
                "width": 512, "height": 512, "mode": "cover",
                "method": "lanczos", "format": "webp", "quality": 88
            }))),
            &methods(),
        )
        .expect("valid");
        let payload = opts.to_task_payload("input_7.jpg");
        assert_eq!(payload["input_image"], "input_7.jpg");
        assert_eq!(payload["mode"], "cover");
        assert_eq!(payload["method"], "lanczos");
        assert_eq!(payload["width"], 512);
        assert_eq!(payload["quality"], 88);
        // No ComfyUI envelope — the agent reads these fields directly.
        assert!(payload.get("workflow").is_none());
        assert!(payload.get("secondary_prompts").is_none());
    }

    #[test]
    fn round_trips_through_the_stored_map() {
        let json = serde_json::json!({ "width": 640, "scale": 0.5, "format": "png" });
        let opts = ResizeOptions::parse(Some(&map(json)), &[]).expect("valid");
        let again = ResizeOptions::parse(Some(&opts.to_map()), &[]).expect("valid");
        assert_eq!(opts, again);
    }
}
