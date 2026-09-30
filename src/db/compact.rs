//! Offline compaction of a sled database directory.
//!
//! sled never shrinks its files (only trailing free segments are truncated), so
//! deleting rows merely lets it *reuse* space. The only way to give disk back is
//! to rebuild: export every tree into a fresh directory, verify, and swap.
//!
//! This must run before the database is opened by the server — sled holds an
//! exclusive lock on the directory.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use log::info;

use super::open_sled_with_cache;

/// Free space required on the volume, as a multiple of the database size.
const MIN_FREE_FACTOR: u64 = 2;

#[derive(Debug, Clone)]
pub struct CompactReport {
    pub path: PathBuf,
    pub bytes_before: u64,
    pub bytes_after: u64,
    /// Where the original directory was moved. Kept — delete it by hand once
    /// the compacted database has been verified.
    pub backup: PathBuf,
}

/// Total size in bytes of all files under `path`.
fn dir_size(path: &Path) -> std::io::Result<u64> {
    let mut total = 0;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        total += if meta.is_dir() {
            dir_size(&entry.path())?
        } else {
            meta.len()
        };
    }
    Ok(total)
}

fn sibling(path: &Path, suffix: &str) -> Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("{} has no file name", path.display()))?;
    let mut name = name.to_os_string();
    name.push(suffix);
    Ok(path.with_file_name(name))
}

/// Rebuild the sled database at `path` into a fresh directory and swap it in.
///
/// The original is moved to `<path>.bak-<unix-ts>` and never deleted. On any
/// failure (including a panic inside sled's `import`) the temporary copy is
/// removed and the original is left untouched.
pub fn compact_sled_dir(path: &Path, cache_mb: u64) -> Result<CompactReport> {
    compact_sled_dir_with(path, cache_mb, |_| {})
}

/// As [`compact_sled_dir`], with a hook run on the new database after import
/// and before verification (lets tests force a checksum mismatch).
fn compact_sled_dir_with(
    path: &Path,
    cache_mb: u64,
    after_import: impl FnOnce(&sled::Db),
) -> Result<CompactReport> {
    if !path.is_dir() {
        bail!("{} is not a directory", path.display());
    }
    let bytes_before = dir_size(path).context("measuring database size")?;

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let free = fs2::available_space(parent).context("checking free disk space")?;
    if free < bytes_before.saturating_mul(MIN_FREE_FACTOR) {
        bail!(
            "refusing to compact {}: {} bytes free, need at least {}x its {} bytes",
            path.display(),
            free,
            MIN_FREE_FACTOR,
            bytes_before
        );
    }

    let tmp = sibling(path, ".compact-tmp")?;
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp).context("removing leftover compaction dir")?;
    }

    // `Db::import` panics on internal errors; treat that like any other failure.
    let copied = catch_unwind(AssertUnwindSafe(|| {
        copy_and_verify(path, &tmp, cache_mb, after_import)
    }));
    match copied {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&tmp);
            bail!("sled panicked while compacting {}", path.display());
        }
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = sibling(path, &format!(".bak-{ts}"))?;
    if backup.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        bail!("backup path {} already exists", backup.display());
    }
    std::fs::rename(path, &backup).context("moving original aside")?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        // Put the original back so the server still finds its database.
        let _ = std::fs::rename(&backup, path);
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(anyhow::Error::new(e).context("moving compacted database into place"));
    }

    let bytes_after = dir_size(path).context("measuring compacted size")?;
    info!(
        "Compacted {}: {} -> {} bytes (backup: {})",
        path.display(),
        bytes_before,
        bytes_after,
        backup.display()
    );
    Ok(CompactReport {
        path: path.to_path_buf(),
        bytes_before,
        bytes_after,
        backup,
    })
}

/// Copy every tree of `src` into a new database at `dst` and check the two hold
/// identical data. Both handles are dropped (releasing their locks) on return.
fn copy_and_verify(
    src: &Path,
    dst: &Path,
    cache_mb: u64,
    after_import: impl FnOnce(&sled::Db),
) -> Result<()> {
    let old = open_sled_with_cache(src, cache_mb).context("opening original database")?;
    let new = open_sled_with_cache(dst, cache_mb).context("creating compacted database")?;

    let expected = old.checksum().context("checksumming original")?;
    new.import(old.export());
    new.flush().context("flushing compacted database")?;
    after_import(&new);
    let actual = new.checksum().context("checksumming compacted copy")?;
    if expected != actual {
        bail!("checksum mismatch after compaction ({expected:#x} != {actual:#x})");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDirGuard(PathBuf);

    impl TempDirGuard {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "offloadmq-compact-test-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn db(&self) -> PathBuf {
            self.0.join("db")
        }

        fn entries(&self) -> Vec<String> {
            let mut v: Vec<String> = std::fs::read_dir(&self.0)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            v.sort();
            v
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Two trees, 2000 rows with ~1 KiB values each; then all but every 100th
    /// row deleted, leaving a file full of dead space.
    fn populate_then_thin(path: &Path) {
        let db = open_sled_with_cache(path, 4).unwrap();
        let a = db.open_tree("a").unwrap();
        let b = db.open_tree("b").unwrap();
        let blob = vec![7u8; 1024];
        for i in 0..2000u32 {
            a.insert(i.to_be_bytes(), blob.clone()).unwrap();
            b.insert(format!("k{i}"), blob.clone()).unwrap();
        }
        db.flush().unwrap();
        for i in 0..2000u32 {
            if i % 100 != 0 {
                a.remove(i.to_be_bytes()).unwrap();
                b.remove(format!("k{i}")).unwrap();
            }
        }
        db.flush().unwrap();
    }

    fn dump(path: &Path) -> Vec<(String, Vec<u8>, Vec<u8>)> {
        let db = open_sled_with_cache(path, 4).unwrap();
        let mut rows = Vec::new();
        for name in ["a", "b"] {
            for item in db.open_tree(name).unwrap().iter() {
                let (k, v) = item.unwrap();
                rows.push((name.to_string(), k.to_vec(), v.to_vec()));
            }
        }
        rows
    }

    #[test]
    fn compaction_preserves_data_shrinks_files_and_keeps_backup() {
        let guard = TempDirGuard::new();
        let db = guard.db();
        populate_then_thin(&db);
        let expected = dump(&db);
        assert_eq!(expected.len(), 40);

        let report = compact_sled_dir(&db, 4).unwrap();

        assert!(
            report.bytes_after < report.bytes_before,
            "{} !< {}",
            report.bytes_after,
            report.bytes_before
        );
        assert!(report.backup.is_dir());
        assert!(
            report
                .backup
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("db.bak-")
        );
        assert_eq!(dump(&db), expected);
        // No temp dir left behind; only the db and its backup.
        assert_eq!(guard.entries().len(), 2, "{:?}", guard.entries());
    }

    #[test]
    fn leftover_tmp_dir_is_wiped() {
        let guard = TempDirGuard::new();
        let db = guard.db();
        populate_then_thin(&db);
        let tmp = guard.0.join("db.compact-tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("junk"), b"stale").unwrap();

        compact_sled_dir(&db, 4).unwrap();
        assert!(!tmp.exists());
    }

    #[test]
    fn verification_failure_leaves_original_in_place() {
        let guard = TempDirGuard::new();
        let db = guard.db();
        populate_then_thin(&db);
        let expected = dump(&db);

        let err = compact_sled_dir_with(&db, 4, |new| {
            new.open_tree("a").unwrap().insert("intruder", "x").unwrap();
        })
        .unwrap_err();

        assert!(err.to_string().contains("checksum mismatch"), "{err:#}");
        assert_eq!(dump(&db), expected);
        assert_eq!(guard.entries(), vec!["db".to_string()]);
    }

    #[test]
    fn locked_database_fails_without_touching_it() {
        let guard = TempDirGuard::new();
        let db = guard.db();
        populate_then_thin(&db);
        // A running server holds sled's exclusive directory lock.
        let _held = open_sled_with_cache(&db, 4).unwrap();

        let before = guard.entries();
        assert!(compact_sled_dir(&db, 4).is_err());
        assert_eq!(guard.entries(), before);
    }

    #[test]
    fn unreadable_config_fails_without_touching_it() {
        let guard = TempDirGuard::new();
        let db = guard.db();
        populate_then_thin(&db);
        std::fs::write(db.join("conf"), vec![0xABu8; 64]).unwrap();

        let before = guard.entries();
        assert!(compact_sled_dir(&db, 4).is_err());
        assert_eq!(guard.entries(), before);
        assert!(db.is_dir());
    }

    #[test]
    fn missing_directory_is_an_error() {
        let guard = TempDirGuard::new();
        assert!(compact_sled_dir(&guard.db(), 4).is_err());
        assert!(guard.entries().is_empty());
    }
}
