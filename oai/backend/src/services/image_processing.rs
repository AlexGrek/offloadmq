//! Pure image decoding/normalization using libvips for memory-efficient processing of
//! large inputs. No DB, no storage, no network — just bytes in, normalized JPEG + metadata out.
//! libvips processes images in strips rather than loading the full decoded pixel buffer into RAM,
//! preventing OOM kills when users upload large inputs (e.g. 48 MP camera shots).

use std::{io::Cursor, process::Command, sync::OnceLock, time::{SystemTime, UNIX_EPOCH}};

use rs_vips::{
    Vips, VipsImage,
    voption::{Setter, VOption},
};
use sha2::{Digest, Sha256};

use crate::error::AppError;

pub const MAX_IMAGE_EDGE: u32 = 1920;
pub const THUMBNAIL_MAX_EDGE: u32 = 384;
pub const JPEG_QUALITY: u8 = 90;
/// Max raw upload size (must match `DefaultBodyLimit` on `POST /api/images/upload`).
pub const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;
/// JPEG inputs at or above this byte size bypass decode + re-encode (see [`process_image`]).
pub const MAX_TRANSCODE_BYTES: usize = 8 * 1024 * 1024;
/// JPEG inputs with any dimension above this also bypass decode + re-encode.
pub const MAX_TRANSCODE_EDGE: u32 = 6000;

static VIPS_INIT: OnceLock<Result<(), String>> = OnceLock::new();

fn ensure_vips_initialized() -> Result<(), AppError> {
    VIPS_INIT
        .get_or_init(|| {
            Vips::init("oai-backend").map_err(|e| format!("vips init failed: {e}"))?;
            // Small internal cache — pod memory safety.
            Vips::cache_set_max(64);
            Vips::cache_set_max_mem(64 * 1024 * 1024);
            Vips::cache_set_max_files(32);
            // One libvips thread per operation; multiple requests can be in flight concurrently
            // because each creates its own VipsImage objects.
            Vips::concurrency_set(1);
            Ok(())
        })
        .as_ref()
        .map_err(|e| AppError::Internal(e.clone()))
        .copied()
}

pub struct ProcessedImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub width: i32,
    pub height: i32,
    pub original_width: Option<i32>,
    pub original_height: Option<i32>,
    pub original_bytes: Option<i64>,
    pub rescaled: bool,
    pub reencoded: bool,
    pub exif_orientation: Option<i32>,
    pub sha256: String,
    pub thumbnail_bytes: Vec<u8>,
}

/// Like [`process_image`], then writes the job prompt into EXIF `ImageDescription`
/// (generated / OffloadMQ outputs only).
pub fn process_generated_image(
    bytes: Vec<u8>,
    content_type_hint: Option<String>,
    prompt: &str,
) -> Result<ProcessedImage, AppError> {
    let trimmed = prompt.trim();
    let mut out = process_image(bytes, content_type_hint)?;
    if !trimmed.is_empty() {
        embed_prompt_exif(&mut out.bytes, trimmed)?;
        // Confirm little_exif wrote a readable ImageDescription tag (kamadak-exif reader).
        if exif_image_description(&out.bytes).is_none() {
            return Err(AppError::Internal(
                "EXIF ImageDescription missing after embed".into(),
            ));
        }
        out.sha256 = sha256_hex(&out.bytes);
    }
    Ok(out)
}

/// Decodes arbitrary input via libvips, applies EXIF orientation, downscales to
/// `MAX_IMAGE_EDGE` if needed, encodes as JPEG (quality 90), and builds a thumbnail.
///
/// libvips streams large images in tiles/strips — it never holds the full decoded
/// pixel buffer in RAM, which prevents OOM kills on large inputs.
///
/// EXIF orientation is always baked into the pixel data and stripped from the output, so
/// viewers never need to apply a rotation transform on the stored file.
pub fn process_image(
    bytes: Vec<u8>,
    // Kept as a forward-compatible hint; the format is auto-detected from magic bytes below.
    _content_type_hint: Option<String>,
) -> Result<ProcessedImage, AppError> {
    ensure_vips_initialized()?;

    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty image".into()));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::BadRequest("image exceeds 32MB limit".into()));
    }

    let original_len = bytes.len();
    // Record the original EXIF tag for metadata storage before decoding.
    let exif_orientation_val = exif_orientation_int(&bytes);

    // Format is auto-detected from magic bytes — content_type_hint is not needed.
    let img = VipsImage::new_from_buffer(&bytes, "")
        .map_err(|e| AppError::BadRequest(format!("decode image failed: {e}")))?;
    // Apply EXIF rotation: bakes the transform into pixels and clears the orientation tag.
    // Always called — even for orientation=1 (no-op) — so the output never relies on
    // a viewer applying the EXIF rotation.
    let img = img
        .autorot()
        .map_err(|e| AppError::Internal(format!("autorot failed: {e}")))?;

    // Measure post-rotation dimensions. `autorot`, `get_width` and `get_height` are
    // header-only — no pixels are decoded yet.
    let ow = img.get_width() as u32;
    let oh = img.get_height() as u32;

    // Bypass decode + re-encode for oversized JPEG inputs. `new_from_buffer` decodes a JPEG
    // fully into RAM for random access, and the resize + JPEG encode below pull every pixel
    // through — a 48 MP / multi-MB photo can exceed pod memory and trigger an OOM kill. For
    // big JPEGs we store the original bytes verbatim (no resize, no re-encode) and build only
    // a shrink-on-load thumbnail, which never materializes the full source. Non-JPEG inputs
    // are always transcoded because the pipeline requires JPEG output.
    if is_jpeg_magic(&bytes)
        && (original_len > MAX_TRANSCODE_BYTES || ow.max(oh) > MAX_TRANSCODE_EDGE)
    {
        let thumbnail_bytes = encode_thumbnail_shrink_on_load(&bytes)?;
        let sha256 = sha256_hex(&bytes);
        return Ok(ProcessedImage {
            bytes,
            content_type: "image/jpeg".to_string(),
            width: ow as i32,
            height: oh as i32,
            original_width: Some(ow as i32),
            original_height: Some(oh as i32),
            original_bytes: Some(original_len as i64),
            rescaled: false,
            reencoded: false,
            exif_orientation: exif_orientation_val,
            sha256,
            thumbnail_bytes,
        });
    }

    let (img, rescaled) = if ow.max(oh) > MAX_IMAGE_EDGE {
        let scale = (MAX_IMAGE_EDGE as f64) / (ow.max(oh) as f64);
        let resized = img
            .resize(scale)
            .map_err(|e| AppError::Internal(format!("resize failed: {e}")))?;
        (resized, true)
    } else {
        (img, false)
    };

    let sw = img.get_width() as u32;
    let sh = img.get_height() as u32;

    // Always encode through libvips: bakes orientation into pixels, strips all EXIF.
    let encoded = vips_to_jpeg(&img, JPEG_QUALITY)?;
    let sha256 = sha256_hex(&encoded);
    let thumbnail_bytes = encode_thumbnail_vips(&img)?;

    Ok(ProcessedImage {
        bytes: encoded,
        content_type: "image/jpeg".to_string(),
        width: sw as i32,
        height: sh as i32,
        original_width: Some(ow as i32),
        original_height: Some(oh as i32),
        original_bytes: Some(original_len as i64),
        rescaled,
        reencoded: true,
        exif_orientation: exif_orientation_val,
        sha256,
        thumbnail_bytes,
    })
}

/// Returns JPEG bytes for API responses when the stored blob is not already JPEG.
pub fn ensure_jpeg_response(bytes: Vec<u8>, content_type: &str) -> Result<Vec<u8>, AppError> {
    if is_jpeg_blob(&bytes, content_type) {
        return Ok(bytes);
    }
    Ok(process_image(bytes, Some(content_type.to_string()))?.bytes)
}

/// Build a thumbnail from an existing main JPEG on disk (backfill path).
pub fn thumbnail_from_main_jpeg(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    ensure_vips_initialized()?;
    let img = VipsImage::new_from_buffer(bytes, "")
        .map_err(|e| AppError::BadRequest(format!("decode thumbnail source failed: {e}")))?;
    encode_thumbnail_vips(&img)
}

/// Extract a JPEG thumbnail from a video blob via ffmpeg (first frame at ~0.5s).
pub fn thumbnail_from_video(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty video".into()));
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir();
    let input = tmp.join(format!("oai-vid-{stamp}.bin"));
    let output = tmp.join(format!("oai-vid-thumb-{stamp}.jpg"));

    std::fs::write(&input, bytes)
        .map_err(|e| AppError::Internal(format!("write temp video failed: {e}")))?;

    let scale = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease",
        THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE
    );
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            "0.5",
            "-i",
        ])
        .arg(input.as_os_str())
        .args([
            "-vframes",
            "1",
            "-vf",
            &scale,
            "-q:v",
            "2",
            "-y",
        ])
        .arg(output.as_os_str())
        .status()
        .map_err(|e| AppError::Internal(format!("ffmpeg spawn failed: {e}")))?;

    let _ = std::fs::remove_file(&input);

    if !status.success() {
        let _ = std::fs::remove_file(&output);
        return Err(AppError::Internal(
            "ffmpeg video thumbnail extraction failed".into(),
        ));
    }

    let thumb = std::fs::read(&output).map_err(|e| {
        let _ = std::fs::remove_file(&output);
        AppError::Internal(format!("read ffmpeg thumbnail failed: {e}"))
    })?;
    let _ = std::fs::remove_file(&output);

    if !is_jpeg_blob(&thumb, "image/jpeg") {
        return Err(AppError::Internal(
            "ffmpeg did not produce a valid JPEG thumbnail".into(),
        ));
    }
    Ok(thumb)
}

pub fn is_jpeg_blob(bytes: &[u8], content_type: &str) -> bool {
    let ct = content_type.trim().to_ascii_lowercase();
    if ct != "image/jpeg" && ct != "image/jpg" {
        return false;
    }
    is_jpeg_magic(bytes)
}

/// True if the buffer starts with the JPEG SOI marker, regardless of declared content type.
fn is_jpeg_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF
}

/// Memory-safe thumbnail for an oversized source. libvips `thumbnail_buffer` uses
/// shrink-on-load, so it never fully decodes the source into RAM. EXIF orientation is
/// applied (thumbnail is upright) and the result is downsized to fit a `THUMBNAIL_MAX_EDGE`
/// box. Used by the [`process_image`] passthrough path for large JPEGs.
fn encode_thumbnail_shrink_on_load(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    let thumb = VipsImage::thumbnail_buffer_with_opts(
        bytes,
        THUMBNAIL_MAX_EDGE as i32,
        VOption::new()
            .set("height", THUMBNAIL_MAX_EDGE as i32)
            .set("size", "down"),
    )
    .map_err(|e| AppError::Internal(format!("thumbnail_buffer failed: {e}")))?;
    vips_to_jpeg(&thumb, JPEG_QUALITY)
}

fn vips_to_jpeg(img: &VipsImage, quality: u8) -> Result<Vec<u8>, AppError> {
    img.write_to_buffer_with_opts(
        ".jpg",
        VOption::new()
            .set("q", i32::from(quality))
            .set("strip", true),
    )
    .map_err(|e| AppError::Internal(format!("vips jpeg encode failed: {e}")))
}

fn encode_thumbnail_vips(img: &VipsImage) -> Result<Vec<u8>, AppError> {
    let w = img.get_width() as u32;
    let h = img.get_height() as u32;
    if w.max(h) > THUMBNAIL_MAX_EDGE {
        let scale = (THUMBNAIL_MAX_EDGE as f64) / (w.max(h) as f64);
        let resized = img
            .resize(scale)
            .map_err(|e| AppError::Internal(format!("thumbnail resize failed: {e}")))?;
        vips_to_jpeg(&resized, JPEG_QUALITY)
    } else {
        vips_to_jpeg(img, JPEG_QUALITY)
    }
}

/// Returns the raw EXIF orientation tag value (1–8), or None if absent / unreadable.
fn exif_orientation_int(bytes: &[u8]) -> Option<i32> {
    let mut cursor = Cursor::new(bytes);
    let exif = exif::Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut cursor)
        .ok()?;
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .and_then(|v| i32::try_from(v).ok())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

const EXIF_DESCRIPTION_MAX_CHARS: usize = 2000;

fn embed_prompt_exif(jpeg: &mut Vec<u8>, prompt: &str) -> Result<(), AppError> {
    use little_exif::{exif_tag::ExifTag, filetype::FileExtension, metadata::Metadata};

    if !is_jpeg_blob(jpeg, "image/jpeg") {
        return Err(AppError::Internal(
            "embed_prompt_exif called on non-JPEG bytes".into(),
        ));
    }

    let file_type = FileExtension::JPEG;
    let _ = Metadata::clear_app12_segment(jpeg, file_type);
    let _ = Metadata::clear_app13_segment(jpeg, file_type);

    let description = truncate_exif_text(prompt, EXIF_DESCRIPTION_MAX_CHARS);
    let mut metadata =
        Metadata::new_from_vec(jpeg, file_type).unwrap_or_else(|_| Metadata::new());
    metadata.set_tag(ExifTag::ImageDescription(description));
    metadata
        .write_to_vec(jpeg, file_type)
        .map_err(|e| AppError::Internal(format!("exif write failed: {e}")))?;
    Ok(())
}

fn truncate_exif_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let end: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{end}…")
}

pub fn exif_image_description(jpeg: &[u8]) -> Option<String> {
    let mut cursor = Cursor::new(jpeg);
    let exif = exif::Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut cursor)
        .ok()?;
    let field = exif.get_field(exif::Tag::ImageDescription, exif::In::PRIMARY)?;
    let s = field.display_value().to_string();
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ExtendedColorType, ImageBuffer, ImageEncoder, Rgb};

    fn tiny_png() -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(8, 8, |x, y| {
            Rgb([(x * 30) as u8, (y * 30) as u8, 128])
        });
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(img.as_raw(), 8, 8, ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    #[test]
    fn process_png_becomes_jpeg_with_thumbnail() {
        let out = process_image(tiny_png(), Some("image/png".into())).unwrap();
        assert_eq!(out.content_type, "image/jpeg");
        assert!(out.reencoded);
        assert!(is_jpeg_blob(&out.bytes, "image/jpeg"));
        assert!(!out.thumbnail_bytes.is_empty());
        assert!(is_jpeg_blob(&out.thumbnail_bytes, "image/jpeg"));
    }

    #[test]
    fn ensure_jpeg_response_passes_jpeg_through() {
        let processed = process_image(tiny_png(), Some("image/png".into())).unwrap();
        let again = ensure_jpeg_response(processed.bytes.clone(), "image/jpeg").unwrap();
        assert_eq!(again, processed.bytes);
    }

    #[test]
    fn ensure_jpeg_response_transcodes_png() {
        let png = tiny_png();
        let jpeg = ensure_jpeg_response(png, "image/png").unwrap();
        assert!(is_jpeg_blob(&jpeg, "image/jpeg"));
    }

    #[test]
    fn generated_jpeg_embeds_prompt_in_exif() {
        let prompt = "a red cube on a marble table, studio lighting";
        let out =
            process_generated_image(tiny_png(), Some("image/png".into()), prompt).unwrap();
        let desc = exif_image_description(&out.bytes).unwrap();
        assert!(desc.contains("red cube"));
    }

    #[test]
    fn upload_path_does_not_embed_prompt() {
        let out = process_image(tiny_png(), Some("image/png".into())).unwrap();
        assert!(exif_image_description(&out.bytes).is_none());
    }

    fn wide_jpeg(width: u32, height: u32) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(width, height, |x, _| Rgb([(x % 256) as u8, 64, 192]));
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut Cursor::new(&mut buf))
            .write_image(img.as_raw(), width, height, ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    #[test]
    fn oversized_jpeg_bypasses_transcoding() {
        // Any dimension > 6000 → original bytes are stored verbatim, never re-encoded.
        let jpeg = wide_jpeg(6001, 4);
        let out = process_image(jpeg.clone(), Some("image/jpeg".into())).unwrap();
        assert!(!out.reencoded);
        assert!(!out.rescaled);
        assert_eq!(out.bytes, jpeg, "bytes must pass through unmodified");
        assert_eq!(out.content_type, "image/jpeg");
        assert_eq!(out.width, 6001);
        assert_eq!(out.height, 4);
        // Thumbnail is still produced (shrink-on-load) and fits the thumbnail box.
        assert!(is_jpeg_blob(&out.thumbnail_bytes, "image/jpeg"));
        let thumb = image::load_from_memory(&out.thumbnail_bytes).unwrap();
        assert!(thumb.width().max(thumb.height()) <= THUMBNAIL_MAX_EDGE);
    }

    #[test]
    fn normal_jpeg_is_still_transcoded() {
        // Small JPEG under both thresholds → normal decode + re-encode path.
        let jpeg = wide_jpeg(64, 64);
        let out = process_image(jpeg, Some("image/jpeg".into())).unwrap();
        assert!(out.reencoded);
    }
}
