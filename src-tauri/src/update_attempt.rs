use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const FILE_NAME: &str = "update-attempt-v1.json";
const TEMP_NAME: &str = ".update-attempt-v1.tmp";
const MAX_MARKER_BYTES: usize = 512;
const MAX_VERSION_BYTES: usize = 64;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Downloading,
    Installing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAttempt {
    pub schema_version: u8,
    pub from_version: String,
    pub target_version: String,
    pub phase: UpdatePhase,
}

impl UpdateAttempt {
    fn validate(&self) -> Result<(), String> {
        fn valid_version(value: &str) -> bool {
            !value.is_empty() && value.len() <= MAX_VERSION_BYTES && !value.contains('\0')
        }
        if self.schema_version != 1
            || !valid_version(&self.from_version)
            || !valid_version(&self.target_version)
            || self.from_version == self.target_version
        {
            return Err("The update recovery record is invalid.".into());
        }
        Ok(())
    }
}

fn marker_path(root: &Path) -> PathBuf {
    root.join(FILE_NAME)
}
fn temp_path(root: &Path) -> PathBuf {
    root.join(TEMP_NAME)
}

#[cfg(windows)]
fn publish(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };
    let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<_> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| format!("The update recovery record could not be published: {error}"))
}

#[cfg(not(windows))]
fn publish(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| {
            format!("The prior update recovery record could not be replaced: {error}")
        })?;
    }
    fs::rename(source, destination)
        .map_err(|error| format!("The update recovery record could not be published: {error}"))
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "The update recovery record could not be removed: {error}"
        )),
    }
}

pub fn write(root: &Path, attempt: &UpdateAttempt) -> Result<(), String> {
    attempt.validate()?;
    let bytes = serde_json::to_vec(attempt)
        .map_err(|error| format!("The update recovery record could not be encoded: {error}"))?;
    if bytes.len() > MAX_MARKER_BYTES {
        return Err("The update recovery record is too large.".into());
    }
    fs::create_dir_all(root)
        .map_err(|error| format!("The update recovery folder could not be created: {error}"))?;
    let temporary = temp_path(root);
    remove_if_present(&temporary)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("The update recovery record could not be created: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("The update recovery record could not be written: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("The update recovery record could not be flushed: {error}"))?;
        drop(file);
        let marker = marker_path(root);
        publish(&temporary, &marker)?;
        let persisted = fs::read(&marker).map_err(|error| {
            format!("The update recovery record could not be read back: {error}")
        })?;
        if persisted != bytes {
            return Err("The update recovery record did not persist exactly.".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = remove_if_present(&temporary);
    }
    result
}

pub fn read(root: &Path) -> Result<Option<UpdateAttempt>, String> {
    let path = marker_path(root);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "The update recovery record could not be inspected: {error}"
            ))
        }
    };
    if metadata.len() > MAX_MARKER_BYTES as u64 {
        remove_if_present(&path)?;
        return Ok(None);
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("The update recovery record could not be read: {error}"))?;
    let attempt = match serde_json::from_slice::<UpdateAttempt>(&bytes) {
        Ok(attempt) if attempt.validate().is_ok() => attempt,
        _ => {
            remove_if_present(&path)?;
            return Ok(None);
        }
    };
    Ok(Some(attempt))
}

pub fn clear(root: &Path) -> Result<(), String> {
    remove_if_present(&marker_path(root))?;
    remove_if_present(&temp_path(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(phase: UpdatePhase) -> UpdateAttempt {
        UpdateAttempt {
            schema_version: 1,
            from_version: "0.2.0".into(),
            target_version: "0.3.0".into(),
            phase,
        }
    }

    #[test]
    fn exact_atomic_round_trip_and_replacement() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), &attempt(UpdatePhase::Downloading)).unwrap();
        assert_eq!(
            read(root.path()).unwrap(),
            Some(attempt(UpdatePhase::Downloading))
        );
        write(root.path(), &attempt(UpdatePhase::Installing)).unwrap();
        assert_eq!(
            read(root.path()).unwrap(),
            Some(attempt(UpdatePhase::Installing))
        );
        assert!(!temp_path(root.path()).exists());
        clear(root.path()).unwrap();
        assert_eq!(read(root.path()).unwrap(), None);
    }

    #[test]
    fn invalid_attempts_never_create_a_marker() {
        let root = tempfile::tempdir().unwrap();
        for invalid in [
            UpdateAttempt {
                schema_version: 2,
                ..attempt(UpdatePhase::Downloading)
            },
            UpdateAttempt {
                from_version: String::new(),
                ..attempt(UpdatePhase::Downloading)
            },
            UpdateAttempt {
                target_version: "0.2.0".into(),
                ..attempt(UpdatePhase::Downloading)
            },
            UpdateAttempt {
                target_version: "x".repeat(65),
                ..attempt(UpdatePhase::Downloading)
            },
            UpdateAttempt {
                target_version: "0.3\0.0".into(),
                ..attempt(UpdatePhase::Downloading)
            },
        ] {
            assert!(write(root.path(), &invalid).is_err());
            assert!(!marker_path(root.path()).exists());
        }
    }

    #[test]
    fn malformed_and_oversized_records_are_removed() {
        let root = tempfile::tempdir().unwrap();
        fs::write(marker_path(root.path()), b"{").unwrap();
        assert_eq!(read(root.path()).unwrap(), None);
        assert!(!marker_path(root.path()).exists());
        fs::write(marker_path(root.path()), vec![b'x'; MAX_MARKER_BYTES + 1]).unwrap();
        assert_eq!(read(root.path()).unwrap(), None);
        assert!(!marker_path(root.path()).exists());
    }
}
