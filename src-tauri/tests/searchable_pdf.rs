#[path = "../src/searchable_pdf.rs"]
mod searchable_pdf;

use lopdf::{content::Content, Document, Object};
use searchable_pdf::{verify_searchable_pdf, write_searchable_pdf, SearchableRasterPage, SearchableWord, MAX_SEARCHABLE_PIXELS};

fn page(words: Vec<SearchableWord>) -> SearchableRasterPage {
    SearchableRasterPage {
        page_width: 200.0,
        page_height: 100.0,
        image_width: 2,
        image_height: 1,
        rgb: vec![255, 0, 0, 0, 255, 0],
        words,
    }
}

fn word(text: &str) -> SearchableWord {
    SearchableWord { x: 20.0, y: 10.0, width: 60.0, height: 12.0, text: text.into() }
}

#[test]
fn writes_canonical_raster_with_invisible_ascii_text() {
    let expected = vec![page(vec![word("Hello")])];
    let bytes = write_searchable_pdf(&expected).unwrap();
    verify_searchable_pdf(&bytes, &expected).unwrap();
    let document = Document::load_mem(&bytes).unwrap();
    let page_id = *document.get_pages().values().next().unwrap();
    let content = document.get_page_content(page_id);
    let operations = Content::decode(&content).unwrap().operations;
    assert_eq!(operations.iter().filter(|op| op.operator == "Do").count(), 1);
    assert_eq!(operations.iter().filter(|op| op.operator == "Tr").count(), 1);
    assert_eq!(operations.iter().filter(|op| op.operator == "Tm").count(), 1);
    let shown = operations.iter().find(|op| op.operator == "Tj").unwrap();
    assert_eq!(shown.operands[0].as_str().unwrap(), b"Hello");
    let render_mode = operations.iter().find(|op| op.operator == "Tr").unwrap();
    assert_eq!(render_mode.operands, vec![Object::Integer(3)]);
}

#[test]
fn canonical_oracle_rejects_appended_or_mutated_bytes() {
    let expected = vec![page(vec![word("A")])];
    let bytes = write_searchable_pdf(&expected).unwrap();
    let mut appended = bytes.clone();
    appended.extend_from_slice(b"\nSECRET");
    assert!(verify_searchable_pdf(&appended, &expected).is_err());
    let mut mutated = bytes;
    let position = mutated.windows(3).position(|window| window == b"1.7").unwrap();
    mutated[position + 2] = b'6';
    assert!(verify_searchable_pdf(&mutated, &expected).is_err());
}

#[test]
fn refuses_unicode_controls_spaces_and_invalid_geometry() {
    for text in ["café", "two words", "bad\ntext"] {
        assert!(write_searchable_pdf(&[page(vec![word(text)])]).is_err());
    }
    for bad in [
        SearchableWord { x: -1.0, ..word("A") },
        SearchableWord { width: 0.0, ..word("A") },
        SearchableWord { x: 190.0, width: 20.0, ..word("A") },
        SearchableWord { y: f64::NAN, ..word("A") },
        SearchableWord { width: f64::MIN_POSITIVE, ..word("A") },
        SearchableWord { height: f64::MIN_POSITIVE, ..word("A") },
    ] {
        assert!(write_searchable_pdf(&[page(vec![bad])]).is_err());
    }
}

#[test]
fn validates_rgb_before_compression_and_aggregate_pixels() {
    let mut bad_rgb = page(vec![]);
    bad_rgb.rgb.pop();
    assert!(write_searchable_pdf(&[bad_rgb]).is_err());
    let too_many = SearchableRasterPage {
        page_width: 1.0,
        page_height: 1.0,
        image_width: (MAX_SEARCHABLE_PIXELS + 1) as u32,
        image_height: 1,
        rgb: vec![],
        words: vec![],
    };
    assert!(write_searchable_pdf(&[too_many]).is_err());
}

#[test]
fn oracle_binds_expected_words_and_pixels() {
    let expected = vec![page(vec![word("A")])];
    let bytes = write_searchable_pdf(&expected).unwrap();
    let changed_word = vec![page(vec![word("B")])];
    assert!(verify_searchable_pdf(&bytes, &changed_word).is_err());
    let mut changed_pixel = expected;
    changed_pixel[0].rgb[0] = 0;
    assert!(verify_searchable_pdf(&bytes, &changed_pixel).is_err());
}
