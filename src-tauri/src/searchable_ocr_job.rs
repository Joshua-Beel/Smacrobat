use std::{sync::Arc, time::{Duration, Instant}};

use crate::{
    ocr::OcrPageRequest,
    ocr_process::{OcrCancellation, OcrOperation, OcrProcessError, OcrProcessRunner},
    searchable_ocr::{map_words_to_display, parse_tesseract_tsv},
    searchable_pdf::{write_searchable_pdf, SearchableRasterPage, SearchableWord},
    service::PdfService,
};

pub(crate) const MAX_DOCUMENT_PAGES: usize = 32;
pub(crate) const MAX_DOCUMENT_RUNTIME: Duration = Duration::from_secs(300);

pub(crate) struct PreparedSearchableOcr {
    pub(crate) bytes: Vec<u8>,
    pub(crate) pages: Vec<SearchableRasterPage>,
    pub(crate) expected_text: Vec<String>,
    pub(crate) deadline: Instant,
    pub(crate) cancellation: OcrCancellation,
}

pub(crate) struct SearchableOcrCoordinator {
    service: PdfService,
    runner: Arc<OcrProcessRunner>,
}

impl SearchableOcrCoordinator {
    pub(crate) fn new(service: PdfService, runner: OcrProcessRunner) -> Self {
        Self { service, runner: Arc::new(runner) }
    }

    async fn prepare(
        &self,
        document_id: u64,
        revision: u64,
        page_count: usize,
        cancellation: OcrCancellation,
    ) -> Result<(PreparedSearchableOcr, OcrOperation), OcrProcessError> {
        if page_count == 0 || page_count > MAX_DOCUMENT_PAGES {
            return Err(OcrProcessError::Document("Searchable OCR supports 1 to 32 current pages.".into()));
        }
        let started = Instant::now();
        let deadline = started + MAX_DOCUMENT_RUNTIME;
        let mut operation = OcrOperation::try_begin(&cancellation)?;
        macro_rules! finish_try {
            ($value:expr) => {
                match $value { Ok(value) => value, Err(error) => return operation.finish(Err(error)) }
            };
        }
        let mut pages = Vec::with_capacity(page_count);
        let mut expected_text = Vec::with_capacity(page_count);
        for index in 0..page_count {
            finish_try!(cancellation.ensure_runnable());
            let page = finish_try!(u16::try_from(index).map_err(|_| OcrProcessError::Document("Searchable OCR page is out of range.".into())));
            let request = OcrPageRequest { document_id, revision, page };
            let raster = finish_try!(self.service.ocr_raster(request, cancellation.clone(), operation.worker_hold()).await
                .map_err(OcrProcessError::Document));
            let remaining = finish_try!(MAX_DOCUMENT_RUNTIME.checked_sub(started.elapsed())
                .ok_or(OcrProcessError::TimedOut));
            let runner = self.runner.clone();
            let worker = tauri::async_runtime::spawn_blocking(move || {
                let result = runner.recognize_p6_tsv_admitted_with_timeout(&raster.p6, &operation, remaining);
                (operation, raster, result)
            }).await;
            let worker = match worker {
                Ok(worker) => worker,
                Err(error) => {
                    cancellation.cancel();
                    return Err(OcrProcessError::System(format!("OCR worker failed: {error}")));
                }
            };
            operation = worker.0;
            let raster = worker.1;
            let output = finish_try!(worker.2);
            finish_try!(cancellation.ensure_runnable());
            finish_try!(self.service.validate_ocr_result(request, operation.worker_hold()).await
                .map_err(OcrProcessError::Document));
            let parsed = finish_try!(parse_tesseract_tsv(output.text.as_bytes(), raster.width, raster.height)
                .map_err(OcrProcessError::InvalidInput));
            let displayed = finish_try!(map_words_to_display(&parsed, f64::from(raster.page_width), f64::from(raster.page_height))
                .map_err(OcrProcessError::InvalidInput));
            let rgb = finish_try!(p6_rgb(&raster.p6, raster.width, raster.height)
                .map_err(OcrProcessError::InvalidInput));
            // PDFium exposes PDF line breaks as CRLF on Windows. Keep this an
            // exact oracle by deriving that representation from the strict TSV
            // hierarchy instead of normalizing extracted output after the fact.
            expected_text.push(parsed.extracted_text.replace('\n', "\r\n"));
            pages.push(SearchableRasterPage {
                page_width: raster.page_width,
                page_height: raster.page_height,
                image_width: raster.width,
                image_height: raster.height,
                rgb,
                words: displayed.into_iter().map(|word| SearchableWord {
                    x: word.x, y: word.y, width: word.width, height: word.height, text: word.text,
                }).collect(),
            });
        }
        if started.elapsed() > MAX_DOCUMENT_RUNTIME { return operation.finish(Err(OcrProcessError::TimedOut)); }
        let bytes = finish_try!(write_searchable_pdf(&pages).map_err(OcrProcessError::InvalidInput));
        if Instant::now() >= deadline { return operation.finish(Err(OcrProcessError::TimedOut)); }
        finish_try!(cancellation.ensure_runnable());
        Ok((PreparedSearchableOcr { bytes, pages, expected_text, deadline, cancellation }, operation))
    }

    pub(crate) async fn create(
        &self,
        document_id: u64,
        revision: u64,
        page_count: usize,
        path: std::path::PathBuf,
        cancellation: OcrCancellation,
    ) -> Result<crate::service::SavedCopy, OcrProcessError> {
        let (prepared, operation) = self.prepare(document_id, revision, page_count, cancellation).await?;
        let result = self.service.publish_searchable_ocr(document_id, revision, path, prepared).await.map_err(OcrProcessError::Document);
        operation.finish_committed(result)
    }
}

fn p6_rgb(input: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let header = format!("P6\n{width} {height}\n255\n");
    let pixels = input.strip_prefix(header.as_bytes()).ok_or("OCR raster P6 header is inconsistent")?;
    let expected = usize::try_from(u64::from(width).checked_mul(u64::from(height)).and_then(|value| value.checked_mul(3)).ok_or("OCR raster length overflows")?)
        .map_err(|_| "OCR raster length overflows")?;
    if pixels.len() != expected { return Err("OCR raster P6 length is inconsistent".into()); }
    Ok(pixels.to_vec())
}
