use ulid::Ulid;

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