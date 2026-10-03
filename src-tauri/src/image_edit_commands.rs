use serde::Serialize;
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageReplacementTarget {
    pub(crate) selection_id: String,
    pub(crate) document_id: u64,
    pub(crate) revision: u64,
    pub(crate) page: u16,
    pub(crate) display_width: f32,
    pub(crate) display_height: f32,
    pub(crate) pixel_width: u32,
    pub(crate) pixel_height: u32,
    pub(crate) accepted_formats: [&'static str; 2],
    pub(crate) mode: &'static str,
}

struct ActiveTarget { target: ImageReplacementTarget, in_flight: bool }

#[derive(Default)]
pub(crate) struct ImageReplacementSelections { next: AtomicU64, active: Mutex<Option<ActiveTarget>> }

pub(crate) struct ImageReplacementAttempt<'a> { selections: &'a ImageReplacementSelections, selection_id: String, settled: bool }

impl ImageReplacementSelections {
    pub(crate) fn register(&self, document_id: u64, revision: u64, page: u16, info: crate::image_edit::ImageEditTargetInfo) -> Result<ImageReplacementTarget, String> {
        let mut active = self.active.lock().map_err(|_| "Image replacement state is unavailable.")?;
        if active.is_some() { return Err("Finish or cancel the current image replacement first.".into()); }
        let target = ImageReplacementTarget {
            selection_id: format!("image-replacement-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1),
            document_id, revision, page, display_width: info.page_width, display_height: info.page_height,
            pixel_width: info.pixel_width, pixel_height: info.pixel_height,
            accepted_formats: ["png", "jpeg"], mode: "newCopy",
        };
        *active = Some(ActiveTarget { target: target.clone(), in_flight: false });
        Ok(target)
    }

    pub(crate) fn begin<'a>(&'a self, selection_id: &str, document_id: u64, revision: u64) -> Result<(ImageReplacementTarget, ImageReplacementAttempt<'a>), String> {
        let mut active = self.active.lock().map_err(|_| "Image replacement state is unavailable.")?;
        let entry = active.as_mut().filter(|entry| entry.target.selection_id == selection_id).ok_or("The image replacement selection is unavailable.")?;
        if entry.target.document_id != document_id || entry.target.revision != revision { return Err("The image replacement selection does not match the document revision.".into()); }
        if entry.in_flight { return Err("This image replacement is already running.".into()); }
        entry.in_flight = true;
        Ok((entry.target.clone(), ImageReplacementAttempt { selections: self, selection_id: selection_id.into(), settled: false }))
    }

    pub(crate) fn cancel(&self, selection_id: &str) -> Result<(), String> {
        let mut active = self.active.lock().map_err(|_| "Image replacement state is unavailable.")?;
        if active.as_ref().is_some_and(|entry| entry.target.selection_id == selection_id) {
            if active.as_ref().is_some_and(|entry| entry.in_flight) { return Err("The image replacement is currently running.".into()); }
            *active = None;
        }
        Ok(())
    }

    fn finish(&self, selection_id: &str, success: bool) -> Result<(), String> {
        let mut active = self.active.lock().map_err(|_| "Image replacement state is unavailable.")?;
        let entry = active.as_mut().filter(|entry| entry.target.selection_id == selection_id).ok_or("The image replacement selection is unavailable.")?;
        if success { *active = None; } else { entry.in_flight = false; }
        Ok(())
    }
}

impl ImageReplacementAttempt<'_> {
    pub(crate) fn commit_success(mut self) -> Result<(), String> { self.selections.finish(&self.selection_id, true)?; self.settled = true; Ok(()) }
}

impl Drop for ImageReplacementAttempt<'_> {
    fn drop(&mut self) { if !self.settled { let _ = self.selections.finish(&self.selection_id, false); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn info() -> crate::image_edit::ImageEditTargetInfo { crate::image_edit::ImageEditTargetInfo { page_width: 200.0, page_height: 100.0, pixel_width: 20, pixel_height: 10 } }
    #[test]
    fn target_is_revision_bound_retryable_and_success_settles() {
        let selections = ImageReplacementSelections::default();
        let target = selections.register(4, 7, 2, info()).unwrap();
        assert!(selections.begin(&target.selection_id, 4, 8).err().unwrap().contains("revision"));
        let (_, attempt) = selections.begin(&target.selection_id, 4, 7).unwrap();
        assert!(selections.begin(&target.selection_id, 4, 7).err().unwrap().contains("already running"));
        drop(attempt);
        let (_, attempt) = selections.begin(&target.selection_id, 4, 7).unwrap();
        attempt.commit_success().unwrap();
        assert!(selections.begin(&target.selection_id, 4, 7).err().unwrap().contains("unavailable"));
        selections.cancel(&target.selection_id).unwrap();
    }
}
