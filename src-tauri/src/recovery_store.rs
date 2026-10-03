use crate::recovery_journal::{decode_recovery, encode_recovery, RecoveryRecord, SourceIdentity};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tempfile::Builder;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use windows::{
    core::PCWSTR,
    Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
};

pub(crate) const MAX_RECORD_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RETAINED_TEMPS: usize = 4;
pub(crate) const MAX_PERSISTENT_RECORDS: usize = 512;
pub(crate) const MAX_PERSISTENT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 4096;
const WRITER_LOCK_NAME: &str = ".smacrec-writer.lock";
const REPARSE_POINT: u32 = 0x400;
const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
static WRITER: OnceLock<Mutex<()>> = OnceLock::new();
#[cfg(test)]
static FAIL_AFTER_PUBLISH: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
pub(crate) fn fail_next_verification_after_publish() { FAIL_AFTER_PUBLISH.store(true, Ordering::Release); }

fn writer() -> &'static Mutex<()> {
    WRITER.get_or_init(|| Mutex::new(()))
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn record_name(source: SourceIdentity) -> String {
    let mut name = String::with_capacity(68);
    for byte in source.sha256 {
        name.push_str(&format!("{byte:02x}"));
    }
    name.push_str(".smacrec");
    name
}

pub(crate) fn is_record_name(name: &str) -> bool {
    name.len() == 72
        && name.ends_with(".smacrec")
        && name[..64].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn admit_persistent(root: &Path, destination: &Path, candidate_bytes: u64) -> Result<(), String> {
    let mut entries = 0usize;
    let mut records = 0usize;
    let mut bytes = 0u64;
    let mut replaced_bytes = None;
    for entry in fs::read_dir(root).map_err(|_| "Recovery directory is unavailable.")? {
        entries = entries.checked_add(1).ok_or("Recovery directory entry limit was reached.")?;
        if entries > MAX_DIRECTORY_ENTRIES { return Err("Recovery directory entry limit was reached.".into()); }
        let entry = entry.map_err(|_| "Recovery directory is unavailable.")?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if !is_record_name(&name) { continue; }
        let path = entry.path();
        ensure_plain_file(&path)?;
        let file = OpenOptions::new().read(true).custom_flags(OPEN_REPARSE_POINT).open(&path).map_err(|_| "Recovery record could not be opened.")?;
        let metadata = file.metadata().map_err(|_| "Recovery record is unsafe.")?;
        if !metadata.is_file() || metadata.file_attributes() & REPARSE_POINT != 0 || metadata.len() > MAX_RECORD_BYTES { return Err("Recovery record is unsafe.".into()); }
        records = records.checked_add(1).ok_or("Recovery storage limit was reached.")?;
        bytes = bytes.checked_add(metadata.len()).ok_or("Recovery storage limit was reached.")?;
        if path == destination { replaced_bytes = Some(metadata.len()); }
    }
    if records > MAX_PERSISTENT_RECORDS || bytes > MAX_PERSISTENT_BYTES { return Err("Recovery storage limit was reached.".into()); }
    let projected_records = records.checked_add(usize::from(replaced_bytes.is_none())).ok_or("Recovery storage limit was reached.")?;
    let projected_bytes = bytes.checked_sub(replaced_bytes.unwrap_or(0)).and_then(|value| value.checked_add(candidate_bytes)).ok_or("Recovery storage limit was reached.")?;
    if projected_records > MAX_PERSISTENT_RECORDS || projected_bytes > MAX_PERSISTENT_BYTES { return Err("Recovery storage limit was reached.".into()); }
    Ok(())
}

fn ensure_plain_directory(root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("Recovery directory is unsafe.".into());
    }
    let mut current = Some(root);
    while let Some(path) = current {
        let metadata =
            fs::symlink_metadata(path).map_err(|_| "Recovery directory is unavailable.")?;
        if !metadata.is_dir() || metadata.file_attributes() & REPARSE_POINT != 0 {
            return Err("Recovery directory is unsafe.".into());
        }
        current = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty());
    }
    Ok(())
}
fn ensure_plain_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Recovery record is unavailable.")?;
    if !metadata.is_file()
        || metadata.file_attributes() & REPARSE_POINT != 0
        || metadata.len() > MAX_RECORD_BYTES
    {
        return Err("Recovery record is unsafe.".into());
    }
    Ok(())
}
fn acquire_writer_lock(root: &Path) -> Result<File, String> {
    let path = root.join(WRITER_LOCK_NAME);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_attributes() & REPARSE_POINT != 0 => return Err("Recovery writer lock is unsafe.".into()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Recovery writer lock is unavailable.".into()),
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .share_mode(0)
        .custom_flags(OPEN_REPARSE_POINT)
        .open(&path)
        .map_err(|_| "Recovery storage is busy in another process.")?;
    let metadata = file.metadata().map_err(|_| "Recovery writer lock is unsafe.")?;
    if !metadata.is_file() || metadata.file_attributes() & REPARSE_POINT != 0 {
        return Err("Recovery writer lock is unsafe.".into());
    }
    Ok(file)
}
fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    ensure_plain_file(path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| "Recovery record could not be opened.")?;
    let metadata = file.metadata().map_err(|_| "Recovery record is unsafe.")?;
    if !metadata.is_file()
        || metadata.file_attributes() & REPARSE_POINT != 0
        || metadata.len() > MAX_RECORD_BYTES
    {
        return Err("Recovery record is unsafe.".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Recovery record could not be read.")?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("Recovery record is too large.".into());
    }
    Ok(bytes)
}
fn create_temp(root: &Path) -> Result<(PathBuf, File), String> {
    let mut retained = 0usize;
    for entry in fs::read_dir(root).map_err(|_| "Recovery directory is unavailable.")? {
        let entry = entry.map_err(|_| "Recovery directory is unavailable.")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(".smacrec-") && name.ends_with(".tmp") {
            retained = retained.saturating_add(1);
        }
    }
    if retained >= MAX_RETAINED_TEMPS {
        return Err("Recovery temporary record limit was reached.".into());
    }
    let temporary = Builder::new()
        .prefix(".smacrec-")
        .suffix(".tmp")
        .tempfile_in(root)
        .map_err(|_| "Recovery temporary record could not be created.")?;
    let (file, path) = temporary
        .keep()
        .map_err(|_| "Recovery temporary record could not be retained.")?;
    Ok((path, file))
}
fn publish(source: &Path, destination: &Path, replace: bool) -> Result<(), String> {
    let source = wide(source);
    let destination = wide(destination);
    let flags = if replace {
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
    } else {
        MOVEFILE_WRITE_THROUGH
    };
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr()), flags) }
        .map_err(|_| "Recovery record could not be published.".into())
}

pub(crate) struct RecoveryWriteError { pub message: String, pub published: bool }

pub(crate) fn write_recovery_detailed(root: &Path, record: &RecoveryRecord) -> Result<PathBuf, RecoveryWriteError> {
    let mut published = false;
    write_recovery_inner(root, record, &mut published).map_err(|message| RecoveryWriteError { message, published })
}

pub fn write_recovery(root: &Path, record: &RecoveryRecord) -> Result<PathBuf, String> {
    write_recovery_detailed(root, record).map_err(|error| error.message)
}

fn write_recovery_inner(root: &Path, record: &RecoveryRecord, published: &mut bool) -> Result<PathBuf, String> {
    let _guard = writer()
        .lock()
        .map_err(|_| "Recovery writer is unavailable.")?;
    ensure_plain_directory(root)?;
    let _process_guard = acquire_writer_lock(root)?;
    ensure_plain_directory(root)?;
    let encoded = encode_recovery(record)?;
    if encoded.len() as u64 > MAX_RECORD_BYTES {
        return Err("Recovery record is too large.".into());
    }
    let destination = root.join(record_name(record.source));
    let replacing = match fs::symlink_metadata(&destination) {
        Ok(_) => {
            ensure_plain_file(&destination)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("Recovery record is unavailable.".into()),
    };
    if replacing {
        let current = decode_recovery(&read_bounded(&destination)?, record.source, None, 0)?;
        if record.generation <= current.generation || (record.active && current.active && record.revision < current.revision) {
            return Err("Recovery record is stale.".into());
        }
    }
    admit_persistent(root, &destination, encoded.len() as u64)?;
    let (temp_path, mut temp) = create_temp(root)?;
    temp.write_all(&encoded)
        .map_err(|_| "Recovery record could not be written.")?;
    temp.flush()
        .map_err(|_| "Recovery record could not be flushed.")?;
    temp.sync_all()
        .map_err(|_| "Recovery record could not be synchronized.")?;
    drop(temp);
    let verified = decode_recovery(
        &read_bounded(&temp_path)?,
        record.source,
        None,
        record.revision,
    )?;
    if &verified != record {
        return Err("Recovery record verification failed.".into());
    }
    publish(&temp_path, &destination, replacing)?;
    *published = true;
    #[cfg(test)]
    if FAIL_AFTER_PUBLISH.swap(false, Ordering::AcqRel) { return Err("Injected recovery verification failure.".into()); }
    let verified = decode_recovery(&read_bounded(&destination)?, record.source, None, record.revision)?;
    if &verified != record { return Err("Recovery record verification failed.".into()); }
    Ok(destination)
}

pub fn read_recovery(
    root: &Path,
    source: SourceIdentity,
    prior_generation: Option<u64>,
    minimum_revision: u64,
) -> Result<Option<RecoveryRecord>, String> {
    ensure_plain_directory(root)?;
    let path = root.join(record_name(source));
    match fs::symlink_metadata(&path) {
        Ok(_) => ensure_plain_file(&path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Recovery record is unavailable.".into()),
    }
    let bytes = read_bounded(&path)?;
    decode_recovery(&bytes, source, prior_generation, minimum_revision).map(Some)
}

#[cfg(test)]
#[path = "recovery_store_process_tests.rs"]
mod process_tests;
