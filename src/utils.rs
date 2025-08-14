use ulid::Ulid;

use crate::error::AppError;

/// Generates a new time-based, lexicographically sortable unique identifier (UID).
///
/// This function creates a ULID, which is composed of:
/// 1. A 48-bit timestamp (millisecond precision).
/// 2. 80 bits of cryptographically secure randomness.
///
/// The resulting string representation is monotonic and can be sorted alphabetically,
/// which will also sort the items by their creation time. This is ideal for database
/// keys, pagination, and distributed systems.
///
/// # Returns
/// A `String` containing the new UID.
pub fn time_sortable_uid() -> String {
    // Ulid::new() automatically uses the current time and a secure random number generator.
    let ulid = Ulid::new();
    ulid.to_string()
}

/// URL encode a string
pub fn url_encode(input: &str) -> String {
    let mut encoded = String::new();

    for byte in input.bytes() {
        match byte {
            // Unreserved characters (safe)
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            // Everything else gets percent-encoded
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }

    encoded
}

/// URL decode a string
pub fn url_decode(input: &str) -> Result<String, AppError> {
    let mut decoded = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '%' => {
                // Get the next two characters for hex decoding
                let hex1 = chars.next().ok_or(AppError::BadRequest(format!(
                    "Invalid percent encoding: missing first hex digit"
                )))?;
                let hex2 = chars.next().ok_or(AppError::BadRequest(format!(
                    "Invalid percent encoding: missing second hex digit"
                )))?;

                let hex_str = format!("{}{}", hex1, hex2);
                let byte = u8::from_str_radix(&hex_str, 16)
                    .map_err(|_| format!("Invalid hex sequence: {}", hex_str))
                    .map_err(|e| AppError::BadRequest(format!("Parse int error: {}", e)))?;

                decoded.push(byte);
            }
            '+' => {
                // In application/x-www-form-urlencoded, + represents space
                decoded.push(b' ');
            }
            _ if ch.is_ascii() => {
                decoded.push(ch as u8);
            }
            _ => {
                // Handle UTF-8 characters
                let mut utf8_bytes = [0; 4];
                let utf8_str = ch.encode_utf8(&mut utf8_bytes);
                decoded.extend_from_slice(utf8_str.as_bytes());
            }
        }
    }

    String::from_utf8(decoded)
        .map_err(|e| AppError::BadRequest(format!("Invalid UTF-8 sequence: {}", e)))
}
