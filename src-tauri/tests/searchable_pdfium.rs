#[path = "../src/searchable_ocr.rs"]
mod searchable_ocr;
#[path = "../src/searchable_pdf.rs"]
mod searchable_pdf;

use pdfium_render::prelude::{PdfBitmapFormat, PdfColor, PdfRenderConfig, Pdfium};
use searchable_ocr::{map_words_to_display, parse_tesseract_tsv};
use searchable_pdf::{write_searchable_pdf, SearchableRasterPage, SearchableWord};
use serde_json::Value;
use std::path::PathBuf;

#[test]
fn deterministic_fixtures_reopen_with_exact_pixels_and_pdfium_text() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture_root = root.join("tests/fixtures/searchable-ocr");
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(fixture_root.join("oracle.json")).unwrap(),
    )
    .unwrap();
    let pdfium = Pdfium::bind_to_library(root.join("resources/pdfium/bin/pdfium.dll"))
        .map(Pdfium::new)
        .unwrap();

    for fixture in oracle["fixtures"].as_array().unwrap() {
        let name = fixture["name"].as_str().unwrap();
        let width = fixture["width"].as_u64().unwrap() as u32;
        let height = fixture["height"].as_u64().unwrap() as u32;
        let dpi = fixture["dpi"].as_u64().unwrap() as f64;
        let rgb = image::load_from_memory(
            &std::fs::read(fixture_root.join(format!("{name}.png"))).unwrap(),
        )
        .unwrap()
        .to_rgb8()
        .into_raw();
        let parsed = parse_tesseract_tsv(
            fixture["tsv"].as_str().unwrap().as_bytes(),
            width,
            height,
        )
        .unwrap();
        let page_width = f64::from(width) * 72.0 / dpi;
        let page_height = f64::from(height) * 72.0 / dpi;
        let words = map_words_to_display(&parsed, page_width, page_height)
            .unwrap()
            .into_iter()
            .map(|word| SearchableWord {
                x: word.x,
                y: word.y,
                width: word.width,
                height: word.height,
                text: word.text,
            })
            .collect();
        let expected = SearchableRasterPage {
            page_width: page_width as f32,
            page_height: page_height as f32,
            image_width: width,
            image_height: height,
            rgb,
            words,
        };
        let bytes = write_searchable_pdf(&[expected.clone()]).unwrap();
        let document = pdfium.load_pdf_from_byte_vec(bytes, None).unwrap();
        let page = document.pages().get(0).unwrap();
        let bitmap = page
            .render_with_config(
                &PdfRenderConfig::new()
                    .set_fixed_size(width as i32, height as i32)
                    .set_format(PdfBitmapFormat::BGRA)
                    .set_reverse_byte_order(false)
                    .clear_before_rendering(true)
                    .set_clear_color(PdfColor::WHITE),
            )
            .unwrap();
        let bgra = bitmap.as_raw_bytes();
        assert!(bgra.chunks_exact(4).all(|pixel| pixel[3] == 255), "{name}");
        let reopened_rgb = bgra
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0]])
            .collect::<Vec<_>>();
        assert_eq!(reopened_rgb, expected.rgb, "{name} pixels");
        let text = page.text().unwrap();
        let visible = page.boundaries().bounding().unwrap().bounds;
        let expected_text = parsed.extracted_text.replace('\n', "\r\n");
        assert_eq!(text.inside_rect(visible), expected_text, "{name} text");
    }
}
