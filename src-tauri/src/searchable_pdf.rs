use lopdf::{content::{Content, Operation}, dictionary, Dictionary, Document, Object, Stream};

pub const MAX_SEARCHABLE_PAGES: usize = 4_096;
pub const MAX_SEARCHABLE_PIXELS: u64 = 32 * 1024 * 1024;
pub const MAX_SEARCHABLE_WORDS: usize = 100_000;
pub const MAX_SEARCHABLE_TEXT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SEARCHABLE_OUTPUT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct SearchableWord {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SearchableRasterPage {
    pub page_width: f32,
    pub page_height: f32,
    pub image_width: u32,
    pub image_height: u32,
    pub rgb: Vec<u8>,
    pub words: Vec<SearchableWord>,
}

pub fn write_searchable_pdf(pages: &[SearchableRasterPage]) -> Result<Vec<u8>, String> {
    validate_pages(pages)?;
    let bytes = assemble(pages)?;
    if bytes.len() > MAX_SEARCHABLE_OUTPUT_BYTES {
        return Err("searchable PDF exceeds the output byte limit".to_string());
    }
    verify_searchable_pdf(&bytes, pages)?;
    Ok(bytes)
}

pub fn verify_searchable_pdf(
    bytes: &[u8],
    expected_pages: &[SearchableRasterPage],
) -> Result<(), String> {
    validate_pages(expected_pages)?;
    if bytes.len() > MAX_SEARCHABLE_OUTPUT_BYTES {
        return Err("searchable PDF exceeds the output byte limit".to_string());
    }
    Document::load_mem(bytes)
        .map_err(|error| format!("searchable PDF cannot be reopened: {error}"))?;
    let canonical = assemble(expected_pages)?;
    if canonical != bytes {
        return Err("candidate is not the exact trusted searchable-PDF output".to_string());
    }
    Ok(())
}

fn validate_pages(pages: &[SearchableRasterPage]) -> Result<(), String> {
    if pages.is_empty() || pages.len() > MAX_SEARCHABLE_PAGES {
        return Err("searchable PDF page count is outside the supported range".to_string());
    }
    let mut pixels = 0_u64;
    let mut words = 0_usize;
    let mut text_bytes = 0_usize;
    for (index, page) in pages.iter().enumerate() {
        let label = index + 1;
        if !page.page_width.is_finite()
            || !page.page_height.is_finite()
            || page.page_width <= 0.0
            || page.page_height <= 0.0
            || page.image_width == 0
            || page.image_height == 0
        {
            return Err(format!("searchable PDF page {label} has invalid dimensions"));
        }
        let page_pixels = u64::from(page.image_width)
            .checked_mul(u64::from(page.image_height))
            .ok_or_else(|| format!("searchable PDF page {label} pixel count overflows"))?;
        pixels = pixels
            .checked_add(page_pixels)
            .ok_or_else(|| "searchable PDF aggregate pixel count overflows".to_string())?;
        if pixels > MAX_SEARCHABLE_PIXELS {
            return Err("searchable PDF exceeds the aggregate pixel limit".to_string());
        }
        let rgb_len = page_pixels
            .checked_mul(3)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| format!("searchable PDF page {label} RGB length overflows"))?;
        if page.rgb.len() != rgb_len {
            return Err(format!("searchable PDF page {label} has an invalid RGB length"));
        }
        words = words
            .checked_add(page.words.len())
            .ok_or_else(|| "searchable PDF word count overflows".to_string())?;
        if words > MAX_SEARCHABLE_WORDS {
            return Err("searchable PDF exceeds the aggregate word limit".to_string());
        }
        for word in &page.words {
            validate_word(word, f64::from(page.page_width), f64::from(page.page_height), label)?;
            text_bytes = text_bytes
                .checked_add(word.text.len())
                .ok_or_else(|| "searchable PDF text length overflows".to_string())?;
            if text_bytes > MAX_SEARCHABLE_TEXT_BYTES {
                return Err("searchable PDF exceeds the aggregate text limit".to_string());
            }
        }
    }
    Ok(())
}

fn validate_word(word: &SearchableWord, page_width: f64, page_height: f64, page: usize) -> Result<(), String> {
    if !word.x.is_finite()
        || !word.y.is_finite()
        || !word.width.is_finite()
        || !word.height.is_finite()
        || word.x < 0.0
        || word.y < 0.0
        || word.width <= 0.0
        || word.height <= 0.0
        || word.x + word.width > page_width
        || word.y + word.height > page_height
    {
        return Err(format!("searchable PDF page {page} has invalid word geometry"));
    }
    if word.text.is_empty()
        || !word.text.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        || helvetica_width(&word.text).is_none()
    {
        return Err(format!("searchable PDF page {page} has unsupported word text"));
    }
    Ok(())
}

fn assemble(pages: &[SearchableRasterPage]) -> Result<Vec<u8>, String> {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let font_id = document.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    });
    let mut kids = Vec::with_capacity(pages.len());
    for page in pages {
        let mut image = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image",
                "Width" => i64::from(page.image_width), "Height" => i64::from(page.image_height),
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
            },
            page.rgb.clone(),
        );
        image.compress().map_err(|error| format!("searchable image compression failed: {error}"))?;
        let image_id = document.add_object(image);
        let mut operations = vec![
            Operation::new("q", vec![]),
            Operation::new("cm", vec![Object::Real(page.page_width), 0.into(), 0.into(), Object::Real(page.page_height), 0.into(), 0.into()]),
            Operation::new("Do", vec![Object::Name(b"Image".to_vec())]),
            Operation::new("Q", vec![]),
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 1.into()]),
            Operation::new("Tr", vec![3.into()]),
        ];
        for word in &page.words {
            let nominal_width = helvetica_width(&word.text).unwrap() / 1000.0;
            let vertical_scale = word.height / 0.925;
            let horizontal_scale = word.width / nominal_width;
            let baseline = f64::from(page.page_height) - word.y - word.height + 0.207 * vertical_scale;
            operations.push(Operation::new("Tm", vec![
                real(horizontal_scale)?, 0.into(), 0.into(), real(vertical_scale)?,
                real(word.x)?, real(baseline)?,
            ]));
            operations.push(Operation::new("Tj", vec![Object::string_literal(word.text.as_bytes())]));
        }
        operations.push(Operation::new("ET", vec![]));
        let content = Content { operations }.encode()
            .map_err(|error| format!("searchable page encoding failed: {error}"))?;
        let content_id = document.add_object(Stream::new(Dictionary::new(), content));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), Object::Real(page.page_width), Object::Real(page.page_height)],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Image" => image_id },
                "Font" => dictionary! { "F1" => font_id },
            },
            "Contents" => content_id,
        });
        kids.push(page_id.into());
    }
    document.objects.insert(pages_id, dictionary! {
        "Type" => "Pages", "Count" => kids.len() as i64, "Kids" => kids,
    }.into());
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes)
        .map_err(|error| format!("searchable PDF serialization failed: {error}"))?;
    Ok(bytes)
}

fn real(value: f64) -> Result<Object, String> {
    if !value.is_finite() || value < f64::from(f32::MIN) || value > f64::from(f32::MAX) {
        return Err("searchable text transform is outside the supported range".to_string());
    }
    let converted = value as f32;
    if !converted.is_finite() || (value != 0.0 && converted == 0.0) {
        return Err("searchable text transform cannot be represented exactly enough".to_string());
    }
    Ok(Object::Real(converted))
}

fn helvetica_width(text: &str) -> Option<f64> {
    text.bytes().try_fold(0_u32, |sum, byte| {
        let width = match byte {
            b'!' | b',' | b'.' | b':' | b';' | b'I' | b'[' | b'\\' | b']' | b'f' | b't' => 278,
            b'"' => 355, b'#' | b'$' | b'0'..=b'9' | b'_' | b'a' | b'b' | b'd' | b'e' | b'g' | b'h' | b'n' | b'o' | b'p' | b'q' | b'L' | b'?' => 556,
            b'%' => 889, b'&' | b'A' | b'B' | b'E' | b'K' | b'R' | b'S' | b'V' | b'X' | b'Y' => 667,
            b'\'' => 191, b'(' | b')' | b'-' | b'`' | b'r' => 333, b'*' => 389,
            b'+' | b'<' | b'=' | b'>' | b'~' => 584, b'/' => 278, b'@' => 1015,
            b'C' | b'D' | b'H' | b'N' | b'U' => 722, b'F' | b'T' | b'Z' => 611,
            b'G' | b'O' | b'Q' => 778, b'J' | b'c' | b'k' | b's' | b'v' | b'x' | b'y' | b'z' => 500,
            b'M' | b'm' => 833, b'P' => 667, b'W' => 944, b'^' => 469,
            b'i' | b'j' | b'l' => 222, b'u' => 556, b'w' => 722,
            b'{' | b'}' => 334, b'|' => 260,
            _ => return None,
        };
        sum.checked_add(width)
    }).map(f64::from)
}
