//! Plumbing shared by everything that shells out to CLI tools (`vipsthumbnail`,
//! `vipsheader`, `ffmpeg`): a process-wide gate, RAII temp files/dirs, and the bridge
//! for running that blocking work off the async runtime.
//!
//! **Never call the functions that use these from an `async fn` directly.** They block
//! the calling thread for the child's whole lifetime — and while one child holds
//! [`SUBPROCESS_GATE`], every other caller parks on the mutex. On a Tokio worker thread
//! that means a handful of concurrent uploads can occupy *every* worker and stall the
//! whole server (health checks included). Run them through [`blocking`] instead, which
//! moves them onto the dedicated blocking pool where waiting is harmless.

use std::{
    path::PathBuf,
    process::{Command, Output},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use crate::error::AppError;

/// Serializes every subprocess spawned through [`run_gated`] so only one child process
/// is ever running at a time, bounding worst-case CPU/RAM on the pod regardless of
/// request concurrency.
static SUBPROCESS_GATE: Mutex<()> = Mutex::new(());

/// Spawns `cmd` and waits for it, holding [`SUBPROCESS_GATE`] for the child's lifetime.
/// Non-zero exit becomes an [`AppError::Internal`] carrying stderr.
///
/// Blocking — see the module docs; call via [`blocking`] from async code.
pub(crate) fn run_gated(mut cmd: Command) -> Result<Output, AppError> {
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

/// Runs blocking work (subprocesses, CPU-heavy decoding, bcrypt) on Tokio's blocking
/// pool and awaits the result, so it can't starve the async worker threads.
///
/// A panic inside `f` surfaces as [`AppError::Internal`] instead of unwinding into the
/// caller's task.
pub async fn blocking<T, F>(f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("blocking task failed: {e}")))?
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A unique path under the OS temp dir. Uniqueness comes from pid + counter; the
/// timestamp just makes leftovers easy to date after a crash.
fn unique_temp_path(suffix: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "oai-tmp-{}-{stamp}-{n}{suffix}",
        std::process::id()
    ))
}

/// A temp file on disk, removed on drop (including on early return and panic). CLI
/// image/video tools need real file paths rather than stdin/stdout streaming.
pub(crate) struct TempFile(pub(crate) PathBuf);

impl TempFile {
    /// Reserves a path; nothing is created until something writes to it (e.g. a tool's
    /// `-o` output). Dropping removes the file if it exists.
    pub(crate) fn new(suffix: &str) -> Self {
        Self(unique_temp_path(suffix))
    }

    pub(crate) fn write(bytes: &[u8], suffix: &str) -> Result<Self, AppError> {
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

/// A temp directory, removed recursively on drop.
pub(crate) struct TempDir(PathBuf);

impl TempDir {
    pub(crate) fn new() -> Result<Self, AppError> {
        let dir = unique_temp_path("");
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Internal(format!("create temp dir failed: {e}")))?;
        Ok(Self(dir))
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_file_is_removed_on_drop_and_paths_are_unique() {
        let a = TempFile::write(b"x", ".bin").unwrap();
        let b = TempFile::new(".bin");
        assert_ne!(a.0, b.0);
        let path = a.0.clone();
        assert!(path.exists());
        drop(a);
        assert!(!path.exists());
        drop(b); // never created: must not panic
    }

    #[test]
    fn temp_dir_is_removed_recursively_on_drop() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        std::fs::write(path.join("clip.mp4"), b"x").unwrap();
        assert!(path.exists());
        drop(dir);
        assert!(!path.exists());
    }

    #[test]
    fn run_gated_reports_stderr_on_failure_and_spawn_errors() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo boom >&2; exit 3"]);
        let err = run_gated(cmd).unwrap_err().to_string();
        assert!(err.contains("boom"), "{err}");

        let err = run_gated(Command::new("definitely-not-a-real-binary-xyz"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("spawn failed"), "{err}");
    }

    #[tokio::test]
    async fn blocking_returns_values_and_converts_panics() {
        assert_eq!(blocking(|| Ok(21 * 2)).await.unwrap(), 42);

        let err = blocking::<(), _>(|| panic!("kaboom")).await.unwrap_err();
        assert!(matches!(err, AppError::Internal(_)));
    }

    /// The regression this module exists for: with the gate held by a slow child,
    /// other async work must keep running. Uses a single worker thread — if the
    /// blocking call ran *on* it, the ticker below could never make progress.
    #[tokio::test(flavor = "current_thread")]
    async fn blocking_does_not_stall_the_async_runtime() {
        let slow = tokio::spawn(blocking(|| {
            let mut cmd = Command::new("sleep");
            cmd.arg("0.4");
            run_gated(cmd).map(|_| ())
        }));

        let mut ticks = 0;
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(300) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            ticks += 1;
        }
        slow.await.unwrap().unwrap();
        assert!(
            ticks >= 5,
            "runtime was starved: only {ticks} ticks in 300ms"
        );
    }
}
