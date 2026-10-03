use serde::Serialize;
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::windows::{fs::MetadataExt, io::AsRawHandle},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
};
use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle}};

const REPARSE_POINT: u32 = 0x400;
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagePdfSource { source_id: String, name: String }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagePdfSelection { selection_id: String, sources: Vec<ImagePdfSource> }

struct ReservedSource {
    id: String,
    name: String,
    file: File,
    identity: (u32, u64),
    length: u64,
    modified: u64,
}

struct ReservedSelection { id: String, sources: Vec<ReservedSource>, in_flight: bool }

#[derive(Default)]
pub(crate) struct ImagePdfSelections {
    next: AtomicU64,
    active: Mutex<Option<ReservedSelection>>,
}

pub(crate) struct ImagePdfAttempt<'a> {
    selections: &'a ImagePdfSelections,
    selection_id: String,
    settled: bool,
}

impl ImagePdfAttempt<'_> {
    pub(crate) fn commit_success(mut self) -> Result<(), String> {
        self.selections.finish_attempt(&self.selection_id, true)?;
        self.settled = true;
        Ok(())
    }
}

impl Drop for ImagePdfAttempt<'_> {
    fn drop(&mut self) {
        if !self.settled { let _ = self.selections.finish_attempt(&self.selection_id, false); }
    }
}

impl ImagePdfSelections {
    #[cfg(test)]
    fn reserve(&self, paths: Vec<PathBuf>) -> Result<ImagePdfSelection, String> {
        self.reserve_replacing(paths, None)
    }

    pub(crate) fn reserve_replacing(&self, paths: Vec<PathBuf>, replace_selection_id: Option<&str>) -> Result<ImagePdfSelection, String> {
        if paths.is_empty() || paths.len() > crate::image_pdf::MAX_MULTI_SOURCES { return Err("Choose 1 to 32 PNG or JPEG images.".into()); }
        let mut sources = Vec::with_capacity(paths.len());
        let mut identities = HashSet::new();
        let mut aggregate = 0_u64;
        for (index, path) in paths.into_iter().enumerate() {
            reject_reparse_path(&path)?;
            let file = File::open(&path).map_err(|error| format!("Could not reserve a source image: {error}"))?;
            let metadata = file.metadata().map_err(|error| format!("Could not inspect a source image: {error}"))?;
            if !metadata.is_file() || metadata.file_attributes() & REPARSE_POINT != 0 { return Err("Source images must be regular non-reparse files.".into()); }
            let identity = file_identity(&file)?;
            if !identities.insert(identity) { return Err("The same source image cannot be selected more than once, including aliases.".into()); }
            let length = metadata.file_size();
            if length == 0 || length > MAX_SOURCE_BYTES { return Err("A source image is empty or exceeds the 64 MiB input limit.".into()); }
            aggregate = aggregate.checked_add(length).ok_or("The aggregate source image size overflows.")?;
            if aggregate > crate::image_pdf::MAX_MULTI_SOURCE_BYTES { return Err("The selected images exceed the 256 MiB aggregate input limit.".into()); }
            sources.push(ReservedSource {
                id: format!("source-{}", index + 1),
                name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                file, identity, length,
                modified: metadata.last_write_time(),
            });
        }
        let selection_id = format!("images-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let public_sources = sources.iter().map(|source| ImagePdfSource {
            source_id: source.id.clone(), name: source.name.clone(),
        }).collect();
        let mut active = self.active.lock().map_err(|_| "Image selection state is unavailable.")?;
        match (active.as_ref(), replace_selection_id) {
            (Some(selection), Some(id)) if selection.id == id && !selection.in_flight => {}
            (Some(_), Some(_)) => return Err("The image selection being replaced is unavailable or busy.".into()),
            (Some(_), None) => return Err("Finish or cancel the current image selection first.".into()),
            (None, Some(_)) => return Err("The image selection being replaced is unavailable.".into()),
            (None, None) => {}
        }
        *active = Some(ReservedSelection { id: selection_id.clone(), sources, in_flight: false });
        Ok(ImagePdfSelection { selection_id, sources: public_sources })
    }

    pub(crate) fn begin_attempt<'a>(&'a self, selection_id: &str, source_ids: &[String]) -> Result<(Vec<Vec<u8>>, ImagePdfAttempt<'a>), String> {
        let mut active = self.active.lock().map_err(|_| "Image selection state is unavailable.")?;
        let selection = active.as_mut().filter(|selection| selection.id == selection_id).ok_or("The image selection is unavailable or already settled.")?;
        if selection.in_flight { return Err("This image selection is already being converted.".into()); }
        if source_ids.is_empty() || source_ids.len() > selection.sources.len() { return Err("Choose at least one reserved source image.".into()); }
        selection.in_flight = true;
        let mut requested = HashSet::new();
        let mut output = Vec::with_capacity(source_ids.len());
        let result = (|| {
            for source_id in source_ids {
                if !requested.insert(source_id.as_str()) { return Err("Each source image may appear only once.".into()); }
                let source = selection.sources.iter().find(|source| source.id == *source_id).ok_or("The image selection no longer matches the reserved sources.")?;
                output.push(read_stable(source)?);
            }
            Ok(output)
        })();
        if result.is_err() { selection.in_flight = false; }
        result.map(|output| (output, ImagePdfAttempt { selections: self, selection_id: selection_id.into(), settled: false }))
    }

    pub(crate) fn finish_attempt(&self, selection_id: &str, published: bool) -> Result<(), String> {
        let mut active = self.active.lock().map_err(|_| "Image selection state is unavailable.")?;
        let selection = active.as_mut().filter(|selection| selection.id == selection_id).ok_or("The image selection is unavailable or already settled.")?;
        if published {
            *active = None;
        } else {
            selection.in_flight = false;
        }
        Ok(())
    }

    pub(crate) fn cancel(&self, selection_id: &str) -> Result<(), String> {
        let mut active = self.active.lock().map_err(|_| "Image selection state is unavailable.")?;
        if active.as_ref().is_some_and(|selection| selection.id == selection_id) {
            if active.as_ref().is_some_and(|selection| selection.in_flight) { return Err("The image selection is currently being converted.".into()); }
            *active = None;
        }
        Ok(())
    }
}

pub(crate) fn validate_output_path(path: &Path) -> Result<(), String> {
    if path.symlink_metadata().is_ok() { return Err("That file already exists. Choose a new filename; Create PDF never overwrites an existing file.".into()); }
    if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("pdf")) { return Err("The output filename must end in .pdf.".into()); }
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).ok_or("Choose an output folder.")?;
    reject_reparse_path(parent)
}

fn reject_reparse_path(path: &Path) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        let metadata = candidate.symlink_metadata().map_err(|error| format!("Could not inspect a source image path: {error}"))?;
        if metadata.file_attributes() & REPARSE_POINT != 0 { return Err("Source image paths may not contain reparse points.".into()); }
        current = candidate.parent().filter(|parent| !parent.as_os_str().is_empty());
    }
    Ok(())
}

fn read_stable(source: &ReservedSource) -> Result<Vec<u8>, String> {
    let before = source.file.metadata().map_err(|error| format!("Could not recheck a source image: {error}"))?;
    let identity = file_identity(&source.file)?;
    if identity != source.identity || before.file_size() != source.length || before.last_write_time() != source.modified { return Err("A selected source image changed after it was chosen.".into()); }
    let read_once = || -> Result<Vec<u8>, String> {
        let mut file = source.file.try_clone().map_err(|error| format!("Could not clone a source image handle: {error}"))?;
        file.seek(SeekFrom::Start(0)).map_err(|error| format!("Could not seek a source image: {error}"))?;
        let mut bytes = Vec::with_capacity(source.length as usize);
        file.take(MAX_SOURCE_BYTES + 1).read_to_end(&mut bytes).map_err(|error| format!("Could not read a source image: {error}"))?;
        Ok(bytes)
    };
    let first = read_once()?;
    let second = read_once()?;
    let after = source.file.metadata().map_err(|error| format!("Could not recheck a source image: {error}"))?;
    if first != second || first.len() as u64 != source.length || after.file_size() != source.length || after.last_write_time() != source.modified { return Err("A selected source image changed while it was being read.".into()); }
    Ok(first)
}

pub(crate) fn read_verified_source(path: &Path) -> Result<Vec<u8>, String> {
    reject_reparse_path(path)?;
    let file = File::open(path).map_err(|error| format!("Could not reserve the replacement image: {error}"))?;
    let metadata = file.metadata().map_err(|error| format!("Could not inspect the replacement image: {error}"))?;
    if !metadata.is_file() || metadata.file_attributes() & REPARSE_POINT != 0 { return Err("The replacement image must be a regular non-reparse file.".into()); }
    let source = ReservedSource {
        id: "replacement".into(), name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        identity: file_identity(&file)?, length: metadata.file_size(), modified: metadata.last_write_time(), file,
    };
    if source.length == 0 || source.length > MAX_SOURCE_BYTES { return Err("The replacement image is empty or exceeds the 64 MiB input limit.".into()); }
    read_stable(&source)
}

fn file_identity(file: &File) -> Result<(u32, u64), String> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information) }
        .map_err(|error| format!("Could not read source image file identity: {error}"))?;
    let index = (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    if index == 0 { return Err("Source image file identity is unavailable.".into()); }
    Ok((information.dwVolumeSerialNumber, index))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservations_preserve_submitted_order_and_reject_aliases() {
        let folder = tempfile::tempdir().unwrap();
        let first = folder.path().join("first.png");
        let second = folder.path().join("second.jpg");
        std::fs::write(&first, b"first").unwrap();
        std::fs::write(&second, b"second").unwrap();
        let selections = ImagePdfSelections::default();
        assert!(selections.reserve(vec![first.clone(), first]).unwrap_err().contains("same source"));
        let selection = selections.reserve(vec![first_path(folder.path()), second]).unwrap();
        let reversed = vec![selection.sources[1].source_id.clone(), selection.sources[0].source_id.clone()];
        let (bytes, attempt) = selections.begin_attempt(&selection.selection_id, &reversed).unwrap();
        assert_eq!(bytes, vec![b"second".to_vec(), b"first".to_vec()]);
        attempt.commit_success().unwrap();
    }

    #[test]
    fn changed_reserved_sources_are_rejected_and_settled() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.png");
        std::fs::write(&path, b"before").unwrap();
        let selections = ImagePdfSelections::default();
        let selection = selections.reserve(vec![path.clone()]).unwrap();
        std::fs::write(path, b"changed-after-selection").unwrap();
        assert!(selections.begin_attempt(&selection.selection_id, &[selection.sources[0].source_id.clone()]).err().unwrap().contains("changed"));
        assert!(selections.begin_attempt(&selection.selection_id, &[selection.sources[0].source_id.clone()]).err().unwrap().contains("changed"));
    }

    #[test]
    fn cancelled_or_failed_attempt_can_retry_but_success_settles() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.png");
        std::fs::write(path.clone(), b"stable").unwrap();
        let selections = ImagePdfSelections::default();
        let selection = selections.reserve(vec![path]).unwrap();
        let ids = vec![selection.sources[0].source_id.clone()];
        let (bytes, attempt) = selections.begin_attempt(&selection.selection_id, &ids).unwrap();
        assert_eq!(bytes, vec![b"stable".to_vec()]);
        assert!(selections.begin_attempt(&selection.selection_id, &ids).err().unwrap().contains("already being converted"));
        assert!(selections.cancel(&selection.selection_id).unwrap_err().contains("currently being converted"));
        drop(attempt);
        let (bytes, attempt) = selections.begin_attempt(&selection.selection_id, &ids).unwrap();
        assert_eq!(bytes, vec![b"stable".to_vec()]);
        attempt.commit_success().unwrap();
        assert!(selections.begin_attempt(&selection.selection_id, &ids).err().unwrap().contains("unavailable"));
        selections.cancel(&selection.selection_id).unwrap();
    }

    #[test]
    fn dropped_or_unwound_attempt_releases_in_flight_state() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.png");
        std::fs::write(path.clone(), b"stable").unwrap();
        let selections = ImagePdfSelections::default();
        let selection = selections.reserve(vec![path]).unwrap();
        let ids = vec![selection.sources[0].source_id.clone()];
        let (_, dropped) = selections.begin_attempt(&selection.selection_id, &ids).unwrap();
        drop(dropped);
        let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let (_, _lease) = selections.begin_attempt(&selection.selection_id, &ids).unwrap();
            panic!("simulated task panic");
        }));
        assert!(unwind.is_err());
        let (_, final_attempt) = selections.begin_attempt(&selection.selection_id, &ids).unwrap();
        drop(final_attempt);
        selections.cancel(&selection.selection_id).unwrap();
    }

    #[test]
    fn replacement_selection_swaps_only_after_new_sources_validate() {
        let folder = tempfile::tempdir().unwrap();
        let first = folder.path().join("first.png");
        let second = folder.path().join("second.png");
        std::fs::write(&first, b"first").unwrap();
        std::fs::write(&second, b"second").unwrap();
        let selections = ImagePdfSelections::default();
        let original = selections.reserve(vec![first.clone()]).unwrap();
        assert!(selections.reserve_replacing(vec![first.clone(), first], Some(&original.selection_id)).is_err());
        let ids = vec![original.sources[0].source_id.clone()];
        let (bytes, retained) = selections.begin_attempt(&original.selection_id, &ids).unwrap();
        assert_eq!(bytes, vec![b"first".to_vec()]);
        drop(retained);
        let replacement = selections.reserve_replacing(vec![second], Some(&original.selection_id)).unwrap();
        assert!(selections.begin_attempt(&original.selection_id, &ids).err().unwrap().contains("unavailable"));
        let replacement_ids = vec![replacement.sources[0].source_id.clone()];
        let (bytes, attempt) = selections.begin_attempt(&replacement.selection_id, &replacement_ids).unwrap();
        assert_eq!(bytes, vec![b"second".to_vec()]);
        drop(attempt);
    }

    fn first_path(folder: &Path) -> PathBuf { folder.join("first.png") }
}
