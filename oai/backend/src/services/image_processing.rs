//! Pure image decoding/normalization. No DB, no storage, no network — just
//! bytes in, normalized JPEG + metadata out. Kept side-effect free so it is
//! trivially testable and reusable by both upload and download paths.

use std::io::Cursor;

use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, metadata::Orientation, DynamicImage,
    ExtendedColorType, GenericImageView, ImageEncoder, ImageFormat, ImageReader,
};
use sha2::{Digest, Sha256};

use crate::error::AppError;

pub const MAX_IMAGE_EDGE: u32 = 1920;
pub const THUMBNAIL_MAX_EDGE: u32 = 384;
pub const JPEG_QUALITY: u8 = 90;
/// Max raw upload size (must match `DefaultBodyLimit` on `POST /api/images/upload`).
pub const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;

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
    pub thumbnail_width: i32,
    pub thumbnail_height: i32,
}

/// Decodes arbitrary input, applies EXIF orientation, downscales to
/// `MAX_IMAGE_EDGE`, encodes as JPEG (quality 90) when needed, and builds a thumbnail.
pub fn process_image(
    bytes: Vec<u8>,
    content_type_hint: Option<String>,
) -> Result<ProcessedImage, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty image".into()));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::BadRequest("image exceeds 32MB limit".into()));
    }

    let input_format = detect_format(&bytes, content_type_hint.as_deref());
    let orientation = orientation_from_exif(&bytes);
    let mut img = decode_with_hint(&bytes, content_type_hint.as_deref())?;
    img.apply_orientation(orientation.unwrap_or(Orientation::NoTransforms));
    let (ow, oh) = img.dimensions();
    let mut rescaled = false;
    if ow.max(oh) > MAX_IMAGE_EDGE {
        let scale = MAX_IMAGE_EDGE as f64 / (ow.max(oh) as f64);
        let nw = ((ow as f64) * scale).round().max(1.0) as u32;
        let nh = ((oh as f64) * scale).round().max(1.0) as u32;
        img = DynamicImage::from(image::imageops::resize(&img, nw, nh, FilterType::Triangle));
        rescaled = true;
    }
    let (sw, sh) = img.dimensions();
    let orientation_applied = orientation
        .filter(|o| *o != Orientation::NoTransforms)
        .is_some();
    let (encoded, reencoded) = encode_main_image(
        &img,
        &bytes,
        input_format,
        rescaled,
        orientation_applied,
    )?;
    let sha256 = sha256_hex(&encoded);

    let (thumbnail_bytes, thumbnail_width, thumbnail_height) = encode_thumbnail(&img)?;

    Ok(ProcessedImage {
        bytes: encoded,
        content_type: "image/jpeg".to_string(),
        width: sw as i32,
        height: sh as i32,
        original_width: Some(ow as i32),
        original_height: Some(oh as i32),
        original_bytes: Some(bytes.len() as i64),
        rescaled,
        reencoded,
        exif_orientation: orientation_to_exif_int(orientation),
        sha256,
        thumbnail_bytes,
        thumbnail_width,
        thumbnail_height,
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
pub fn thumbnail_from_main_jpeg(bytes: &[u8]) -> Result<(Vec<u8>, i32, i32), AppError> {
    let img = decode_with_hint(bytes, Some("image/jpeg"))?;
    encode_thumbnail(&img)
}

pub fn is_jpeg_blob(bytes: &[u8], content_type: &str) -> bool {
    let ct = content_type.trim().to_ascii_lowercase();
    if ct != "image/jpeg" && ct != "image/jpg" {
        return false;
    }
    bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF
}

fn detect_format(bytes: &[u8], content_type_hint: Option<&str>) -> Option<ImageFormat> {
    let from_hint = match content_type_hint.unwrap_or_default() {
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/png" => Some(ImageFormat::Png),
        "image/webp" => Some(ImageFormat::WebP),
        _ => None,
    };
    from_hint.or_else(|| image::guess_format(bytes).ok())
}

fn encode_main_image(
    img: &DynamicImage,
    original_bytes: &[u8],
    input_format: Option<ImageFormat>,
    rescaled: bool,
    orientation_applied: bool,
) -> Result<(Vec<u8>, bool), AppError> {
    let can_passthrough = input_format == Some(ImageFormat::Jpeg)
        && !rescaled
        && !orientation_applied
        && is_jpeg_blob(original_bytes, "image/jpeg");
    if can_passthrough {
        return Ok((original_bytes.to_vec(), false));
    }
    Ok((encode_jpeg(img, JPEG_QUALITY)?, true))
}

fn encode_thumbnail(img: &DynamicImage) -> Result<(Vec<u8>, i32, i32), AppError> {
    let (w, h) = img.dimensions();
    let thumb = if w.max(h) > THUMBNAIL_MAX_EDGE {
        let scale = THUMBNAIL_MAX_EDGE as f64 / (w.max(h) as f64);
        let nw = ((w as f64) * scale).round().max(1.0) as u32;
        let nh = ((h as f64) * scale).round().max(1.0) as u32;
        DynamicImage::from(image::imageops::resize(img, nw, nh, FilterType::Triangle))
    } else {
        img.clone()
    };
    let (tw, th) = thumb.dimensions();
    let bytes = encode_jpeg(&thumb, JPEG_QUALITY)?;
    Ok((bytes, tw as i32, th as i32))
}

fn decode_with_hint(
    bytes: &[u8],
    content_type_hint: Option<&str>,
) -> Result<DynamicImage, AppError> {
    let format = match content_type_hint.unwrap_or_default() {
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/png" => Some(ImageFormat::Png),
        "image/webp" => Some(ImageFormat::WebP),
        _ => None,
    };
    let mut reader = if let Some(fmt) = format {
        ImageReader::with_format(Cursor::new(bytes), fmt)
    } else {
        ImageReader::new(Cursor::new(bytes))
    };
    reader = reader
        .with_guessed_format()
        .map_err(|e| AppError::BadRequest(format!("unsupported image: {e}")))?;
    reader
        .decode()
        .map_err(|e| AppError::BadRequest(format!("decode image failed: {e}")))
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, AppError> {
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut out, quality);
    encoder
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .map_err(|e| AppError::Internal(format!("jpeg encode failed: {e}")))?;
    Ok(out)
}

fn orientation_from_exif(bytes: &[u8]) -> Option<Orientation> {
    let mut cursor = Cursor::new(bytes);
    let exif = exif::Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut cursor)
        .ok()?;
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .and_then(|v| u8::try_from(v).ok())
        .and_then(Orientation::from_exif)
}

fn orientation_to_exif_int(orientation: Option<Orientation>) -> Option<i32> {
    orientation.map(|o| match o {
        Orientation::NoTransforms => 1,
        Orientation::Rotate90 => 6,
        Orientation::Rotate180 => 3,
        Orientation::Rotate270 => 8,
        Orientation::FlipHorizontal => 2,
        Orientation::FlipVertical => 4,
        Orientation::Rotate90FlipH => 5,
        Orientation::Rotate270FlipH => 7,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

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
        assert!(out.thumbnail_width > 0);
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
}
