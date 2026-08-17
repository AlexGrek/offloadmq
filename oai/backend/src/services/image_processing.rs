//! Image decoding/normalization for large inputs. No DB, no storage, no network —
//! just bytes in, normalized JPEG + metadata out.
//!
//! Every resize/reencode is delegated to the `vipsthumbnail` / `vipsheader` CLI tools
//! (package `libvips-tools`), spawned as subprocesses rather than linked in-process.
//! libvips itself still streams large images in tiles/strips rather than loading the
//! full decoded pixel buffer into RAM, preventing OOM kills on large inputs (e.g. 48 MP
//! camera shots) — but doing that work in a child process means a crash or runaway
//! allocation there can't take the whole server down with it. All subprocess spawns in
//! this module (vips*, ffmpeg) are serialized through [`SUBPROCESS_GATE`] so at most one
//! runs at a time, bounding worst-case CPU/RAM on the pod regardless of request concurrency.

use std::{
    io::Cursor,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
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

/// Serializes every resize/reencode subprocess this module spawns (`vipsthumbnail`,
/// `vipsheader`, `ffmpeg`) so only one child process is ever running at a time.
static SUBPROCESS_GATE: Mutex<()> = Mutex::new(());

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

/// Decodes arbitrary input via `vipsthumbnail`, applies EXIF orientation, downscales to
/// `MAX_IMAGE_EDGE` if needed, encodes as JPEG (quality 90), and builds a thumbnail.
///
/// EXIF orientation is always baked into the pixel data and stripped from the output, so
/// viewers never need to apply a rotation transform on the stored file.
pub fn process_image(
    bytes: Vec<u8>,
    // Kept as a forward-compatible hint; the format is auto-detected from magic bytes below.
    _content_type_hint: Option<String>,
) -> Result<ProcessedImage, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty image".into()));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::BadRequest("image exceeds 32MB limit".into()));
    }

    let original_len = bytes.len();
    // Record the original EXIF tag for metadata storage before decoding.
    let exif_orientation_val = exif_orientation_int(&bytes);

    let input = TempFile::write(&bytes, ".bin")?;

    // Header-only read (no pixels decoded) for the raw, pre-rotation dimensions.
    let raw_w = vips_header_dim(&input.0, "width")?;
    let raw_h = vips_header_dim(&input.0, "height")?;
    // Orientations 5-8 carry a 90/270 degree rotation component, which swaps the axes
    // once baked into pixels. 1-4 are mirror/180-degree only and don't swap.
    let (ow, oh) = match exif_orientation_val {
        Some(5..=8) => (raw_h, raw_w),
        _ => (raw_w, raw_h),
    };

    // Bypass decode + re-encode for oversized JPEG inputs: resizing/encoding pulls every
    // pixel through the pipeline, and a 48 MP / multi-MB photo can exceed pod memory. For
    // big JPEGs we store the original bytes verbatim (no resize, no re-encode) and build
    // only a shrink-on-load thumbnail. Non-JPEG inputs are always transcoded because the
    // pipeline requires JPEG output.
    if is_jpeg_magic(&bytes)
        && (original_len > MAX_TRANSCODE_BYTES || ow.max(oh) > MAX_TRANSCODE_EDGE)
    {
        let (thumbnail_bytes, _, _) = vips_thumbnail(&input.0, THUMBNAIL_MAX_EDGE, JPEG_QUALITY)?;
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

    // `vipsthumbnail` decodes, auto-rotates, shrinks to fit the box (never upscales —
    // the trailing `>` in the size spec) and strips all metadata in one subprocess call.
    let (encoded, sw, sh) = vips_thumbnail(&input.0, MAX_IMAGE_EDGE, JPEG_QUALITY)?;
    let sha256 = sha256_hex(&encoded);
    let (thumbnail_bytes, _, _) = vips_thumbnail(&input.0, THUMBNAIL_MAX_EDGE, JPEG_QUALITY)?;

    Ok(ProcessedImage {
        bytes: encoded,
        content_type: "image/jpeg".to_string(),
        width: sw as i32,
        height: sh as i32,
        original_width: Some(ow as i32),
        original_height: Some(oh as i32),
        original_bytes: Some(original_len as i64),
        rescaled: ow.max(oh) > MAX_IMAGE_EDGE,
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
    let input = TempFile::write(bytes, ".jpg")?;
    let (thumbnail_bytes, _, _) = vips_thumbnail(&input.0, THUMBNAIL_MAX_EDGE, JPEG_QUALITY)?;
    Ok(thumbnail_bytes)
}

/// Extract a JPEG thumbnail from a video blob via ffmpeg (first frame at ~0.5s).
pub fn thumbnail_from_video(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty video".into()));
    }

    let input = TempFile::write(bytes, ".bin")?;
    let output = TempFile::new(".jpg");

    let scale = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease",
        THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE
    );
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i"])
        .arg(&input.0)
        .args(["-vframes", "1", "-vf", &scale, "-q:v", "2", "-y"])
        .arg(&output.0);
    run_gated(cmd)?;

    let thumb = std::fs::read(&output.0)
        .map_err(|e| AppError::Internal(format!("read ffmpeg thumbnail failed: {e}")))?;

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

/// Runs `vipsthumbnail` on `input`, shrinking it to fit inside a `max_edge x max_edge`
/// box (aspect preserved, never upscaled) and encoding as JPEG at `quality` with all
/// metadata stripped. Returns the encoded bytes plus the output's actual dimensions,
/// read back via a header-only `vipsheader` call (no full pixel decode).
fn vips_thumbnail(input: &Path, max_edge: u32, quality: u8) -> Result<(Vec<u8>, u32, u32), AppError> {
    let out = TempFile::new(".jpg");
    let size = format!("{max_edge}x{max_edge}>");
    let out_arg = format!("{}[Q={quality},strip]", out.0.display());

    let mut cmd = Command::new("vipsthumbnail");
    cmd.arg(input).args(["--size", &size, "-o", &out_arg]);
    run_gated(cmd)?;

    let bytes = std::fs::read(&out.0)
        .map_err(|e| AppError::Internal(format!("read vipsthumbnail output failed: {e}")))?;
    let w = vips_header_dim(&out.0, "width")?;
    let h = vips_header_dim(&out.0, "height")?;
    Ok((bytes, w, h))
}

/// Header-only dimension read (`vipsheader -f width|height`) — never decodes pixels.
fn vips_header_dim(path: &Path, field: &str) -> Result<u32, AppError> {
    let mut cmd = Command::new("vipsheader");
    cmd.args(["-f", field]).arg(path);
    let output = run_gated(cmd)?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u32>()
        .map_err(|e| AppError::Internal(format!("vipsheader parse failed: {e}")))
}

/// Spawns `cmd`, holding [`SUBPROCESS_GATE`] for the child's lifetime so only one
/// resize/reencode subprocess runs at a time.
fn run_gated(mut cmd: Command) -> Result<Output, AppError> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let _permit = SUBPROCESS_GATE.lock().unwrap_or_else(|e| e.into_inner());
    let output = cmd
        .output()
        .map_err(|e| AppError::Internal(format!("{program} spawn failed: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Internal(format!(
            "{program} failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output)
}

/// A temp file on disk, removed on drop. CLI image tools need real file paths rather
/// than stdin/stdout streaming.
struct TempFile(PathBuf);

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

impl TempFile {
    fn new(suffix: &str) -> Self {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "oai-img-{}-{stamp}-{n}{suffix}",
            std::process::id()
        ));
        Self(path)
    }

    fn write(bytes: &[u8], suffix: &str) -> Result<Self, AppError> {
        let file = Self::new(suffix);
        std::fs::write(&file.0, bytes)
            .map_err(|e| AppError::Internal(format!("write temp file failed: {e}")))?;
        Ok(file)
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
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
