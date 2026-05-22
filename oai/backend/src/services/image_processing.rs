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

const MAX_IMAGE_EDGE: u32 = 1920;
const JPEG_QUALITY: u8 = 88;
const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;

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
}

/// Decodes arbitrary input, applies EXIF orientation, downscales to
/// `MAX_IMAGE_EDGE`, and re-encodes as JPEG.
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
    let encoded = encode_jpeg(&img)?;
    let sha256 = sha256_hex(&encoded);

    Ok(ProcessedImage {
        bytes: encoded,
        content_type: "image/jpeg".to_string(),
        width: sw as i32,
        height: sh as i32,
        original_width: Some(ow as i32),
        original_height: Some(oh as i32),
        original_bytes: Some(bytes.len() as i64),
        rescaled,
        reencoded: true,
        exif_orientation: orientation_to_exif_int(orientation),
        sha256,
    })
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

fn encode_jpeg(img: &DynamicImage) -> Result<Vec<u8>, AppError> {
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
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
