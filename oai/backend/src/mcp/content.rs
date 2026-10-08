//! Building `tools/call` results: text, inline image previews within Claude's result
//! size limit, and signed full-resolution links.

use base64::Engine;
use serde_json::{Value, json};

use crate::{
    error::{AppError, ResultExt},
    services::{image_jobs, image_processing},
};

use super::{ToolContext, files};

/// Base64 characters of inline image data allowed per tool result. Claude's hosted
/// apps cap a whole tool result at ~150,000 characters, and base64 image data counts
/// toward it — this leaves room for the text and structured parts.
pub const INLINE_IMAGE_BUDGET: usize = 110_000;
/// Fallback size when a stored thumbnail doesn't fit the per-image share of the budget.
const SMALL_PREVIEW_EDGE: u32 = 256;
const SMALL_PREVIEW_QUALITY: u8 = 70;

/// A `tools/call` result under construction.
pub struct ToolOutput {
    content: Vec<Value>,
    structured: Option<Value>,
    is_error: bool,
    image_budget: usize,
}

impl Default for ToolOutput {
    fn default() -> Self {
        Self {
            content: Vec::new(),
            structured: None,
            is_error: false,
            image_budget: INLINE_IMAGE_BUDGET,
        }
    }
}

impl ToolOutput {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(text: impl Into<String>) -> Self {
        let mut out = Self::new();
        out.push_text(text);
        out
    }

    pub fn error(message: impl Into<String>) -> Self {
        let mut out = Self::text(message);
        out.is_error = true;
        out
    }

    pub fn push_text(&mut self, text: impl Into<String>) {
        self.content
            .push(json!({ "type": "text", "text": text.into() }));
    }

    pub fn set_structured(&mut self, value: Value) {
        self.structured = Some(value);
    }

    pub fn remaining_image_budget(&self) -> usize {
        self.image_budget
    }

    /// Embeds a JPEG if it fits the remaining budget; returns whether it did.
    pub fn push_jpeg(&mut self, jpeg: &[u8]) -> bool {
        let encoded_len = jpeg.len().div_ceil(3) * 4;
        if encoded_len > self.image_budget {
            return false;
        }
        self.image_budget -= encoded_len;
        self.content.push(json!({
            "type": "image",
            "data": base64::engine::general_purpose::STANDARD.encode(jpeg),
            "mimeType": "image/jpeg",
        }));
        true
    }

    /// Appends another output's content after this one's; the remaining image budget
    /// is whatever `other` has left.
    pub fn append(&mut self, other: ToolOutput) {
        self.content.extend(other.content);
        self.image_budget = other.image_budget;
        self.is_error |= other.is_error;
    }

    pub fn into_value(self) -> Value {
        let mut result = json!({ "content": self.content, "isError": self.is_error });
        if let Some(s) = self.structured {
            result["structuredContent"] = s;
        }
        result
    }
}

impl From<AppError> for ToolOutput {
    /// Tool failures are reported to the model as an `isError` result (it can read
    /// and react to them), not as JSON-RPC protocol errors.
    fn from(e: AppError) -> Self {
        let message = match e {
            AppError::NotFound => {
                "Not found (unknown ID, or it belongs to another account).".to_string()
            }
            AppError::BadRequest(m) | AppError::ExternalService(m) => m,
            AppError::Unauthorized | AppError::Jwt(_) => "Not authorized.".to_string(),
            AppError::Forbidden => "Forbidden.".to_string(),
            other => {
                tracing::error!("mcp tool failed: {other:?}");
                "Internal server error.".to_string()
            }
        };
        ToolOutput::error(message)
    }
}

/// An image file the model can be shown, as listed in tool results.
pub struct ImageView {
    pub image_id: i64,
    pub width: i32,
    pub height: i32,
    pub content_type: String,
}

impl ImageView {
    pub fn from_file(f: &crate::db::image_generation::ImageFile) -> Self {
        Self {
            image_id: f.id,
            width: f.stored_width,
            height: f.stored_height,
            content_type: f.content_type.clone(),
        }
    }

    pub fn is_video(&self) -> bool {
        self.content_type.starts_with("video/")
    }
}

/// JSON summary of an image (id, size, signed link) for `structuredContent`.
pub fn image_json(ctx: &ToolContext, img: &ImageView) -> Value {
    json!({
        "image_id": img.image_id.to_string(),
        "width": img.width,
        "height": img.height,
        "content_type": img.content_type,
        "url": files::signed_file_url(ctx, img.image_id),
    })
}

/// Embeds previews of `images` (stored 384 px thumbnails, re-encoded smaller when
/// they don't fit), sharing the remaining budget evenly. Returns how many were
/// embedded; the rest are only listed as links by the caller.
pub async fn embed_previews(
    ctx: &ToolContext,
    out: &mut ToolOutput,
    images: &[ImageView],
) -> usize {
    let mut embedded = 0;
    for (i, img) in images.iter().enumerate() {
        let share = out.remaining_image_budget() / (images.len() - i);
        let Some(thumb) = image_jobs::image_thumbnail_bytes(&ctx.state, ctx.user_id, img.image_id)
            .await
            .log_warn("mcp thumbnail")
        else {
            continue;
        };
        let jpeg = if thumb.len().div_ceil(3) * 4 <= share {
            thumb
        } else {
            match image_processing::downscaled_jpeg_async(
                thumb,
                SMALL_PREVIEW_EDGE,
                SMALL_PREVIEW_QUALITY,
            )
            .await
            .log_warn("mcp small preview")
            {
                Some(small) => small,
                None => continue,
            }
        };
        if jpeg.len().div_ceil(3) * 4 <= share && out.push_jpeg(&jpeg) {
            embedded += 1;
        }
    }
    embedded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_embedding_respects_the_budget() {
        let mut out = ToolOutput::new();
        let big = vec![0u8; INLINE_IMAGE_BUDGET]; // base64 is 4/3 bigger: never fits
        assert!(!out.push_jpeg(&big));
        let small = vec![0u8; 30_000]; // 40,000 base64 chars
        assert!(out.push_jpeg(&small));
        assert!(out.push_jpeg(&small));
        assert!(!out.push_jpeg(&small), "third copy exceeds 110k");
        let v = out.into_value();
        assert_eq!(v["content"].as_array().unwrap().len(), 2);
        assert_eq!(v["isError"], false);
    }

    #[test]
    fn errors_become_is_error_results() {
        let v = ToolOutput::from(AppError::BadRequest("nope".into())).into_value();
        assert_eq!(v["isError"], true);
        assert_eq!(v["content"][0]["text"], "nope");
    }
}
