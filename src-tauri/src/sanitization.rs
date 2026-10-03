use lopdf::{
    content::{Content, Operation},
    dictionary, Dictionary, Document, Object, ObjectId, Stream,
};
use std::collections::HashSet;

const MAX_OUTPUT_BYTES: usize = 256 * 1024 * 1024;
const MAX_PAGES: usize = 4_096;
const MAX_IMAGE_PIXELS_PER_PAGE: u64 = 32_000_000;
const MAX_TOTAL_IMAGE_PIXELS: u64 = 32_000_000;

#[derive(Debug, PartialEq, Eq)]
pub struct CleanRasterSummary {
    pub pages: usize,
    pub total_pixels: u64,
}

/// Verifies the deliberately small PDF profile used for sanitized raster copies.
///
/// Passing this check proves that the serialized PDF has no accepted non-raster
/// document channel. It does not prove that sensitive pixels were removed before
/// encoding; the redaction renderer must establish that separately.
pub fn verify_clean_raster_pdf(
    bytes: &[u8],
    expected_pages: usize,
) -> Result<CleanRasterSummary, String> {
    if bytes.is_empty() || bytes.len() > MAX_OUTPUT_BYTES {
        return Err("The candidate PDF is empty or exceeds the 256 MiB sanitization limit.".into());
    }
    if expected_pages == 0 || expected_pages > MAX_PAGES {
        return Err(
            "The expected page count is outside the 1 to 4,096 page sanitization limit.".into(),
        );
    }

    let document = Document::load_mem(bytes)
        .map_err(|error| format!("The candidate PDF is invalid: {error}"))?;
    if document.is_encrypted() {
        return Err("A sanitized raster copy cannot be encrypted.".into());
    }
    let has_xref_trailer = document.trailer.has(b"Type");
    let trailer_keys: &[&[u8]] = if has_xref_trailer {
        &[
            b"Root", b"Size", b"Type", b"W", b"Index", b"Filter", b"Length",
        ]
    } else {
        &[b"Root", b"Size"]
    };
    allowed_keys(&document.trailer, trailer_keys, "trailer")?;
    for forbidden in [b"Info".as_slice(), b"Encrypt"] {
        if document.trailer.has(forbidden) {
            return Err(format!(
                "The candidate PDF retains forbidden trailer entry /{}.",
                String::from_utf8_lossy(forbidden)
            ));
        }
    }
    if has_xref_trailer
        && document.trailer.get(b"Type").and_then(Object::as_name).ok() != Some(b"XRef")
    {
        return Err("The candidate PDF has an unsupported trailer type.".into());
    }

    let root_id = document
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|_| "The candidate PDF has no indirect catalog root.")?;
    let catalog = dictionary_at(&document, root_id, "catalog")?;
    allowed_keys(catalog, &[b"Type", b"Pages"], "catalog")?;
    require_name(catalog, b"Type", b"Catalog", "catalog")?;
    let pages_id = required_reference(catalog, b"Pages", "catalog")?;
    let pages = dictionary_at(&document, pages_id, "page tree")?;
    allowed_keys(pages, &[b"Type", b"Count", b"Kids"], "page tree")?;
    require_name(pages, b"Type", b"Pages", "page tree")?;

    let page_map = document.get_pages();
    if page_map.len() != expected_pages {
        return Err(format!(
            "The candidate PDF has {} pages; expected {expected_pages}.",
            page_map.len()
        ));
    }
    let count = pages
        .get(b"Count")
        .and_then(Object::as_i64)
        .map_err(|_| "The page tree has no valid /Count.")?;
    if count != expected_pages as i64 {
        return Err("The page-tree count does not match the expected page count.".into());
    }

    let kids = pages
        .get(b"Kids")
        .and_then(Object::as_array)
        .map_err(|_| "The page tree has no direct /Kids array.")?;
    let kid_ids = kids
        .iter()
        .map(Object::as_reference)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Every page-tree kid must be an indirect page reference.")?;
    let mapped_ids = page_map.values().copied().collect::<Vec<_>>();
    if kid_ids != mapped_ids {
        return Err("Nested, reordered, duplicated, or inconsistent page trees are outside the sanitized raster profile.".into());
    }

    let mut allowed_objects = HashSet::from([root_id, pages_id]);
    let mut total_pixels = 0u64;
    let mut image_ids = HashSet::new();
    let mut content_ids = HashSet::new();
    let mut images = Vec::with_capacity(expected_pages);
    for (index, page_id) in mapped_ids.into_iter().enumerate() {
        let page_label = format!("page {}", index + 1);
        let page = dictionary_at(&document, page_id, &page_label)?;
        allowed_keys(
            page,
            &[b"Type", b"Parent", b"MediaBox", b"Resources", b"Contents"],
            &page_label,
        )?;
        require_name(page, b"Type", b"Page", &page_label)?;
        if required_reference(page, b"Parent", &page_label)? != pages_id {
            return Err(format!(
                "{page_label} does not point directly to the one-level page tree."
            ));
        }
        let (page_width, page_height) = validate_media_box(page, &page_label)?;

        let content_id = required_reference(page, b"Contents", &page_label)?;
        if !content_ids.insert(content_id) {
            return Err("Sanitized pages cannot reuse a content stream.".into());
        }
        let content_stream = stream_at(&document, content_id, "page content")?;
        allowed_keys(
            &content_stream.dict,
            &[b"Length", b"Filter"],
            "page content stream",
        )?;
        validate_optional_flate_filter(content_stream, "page content stream")?;
        validate_content(content_stream, page_width, page_height)?;

        let resources = page
            .get(b"Resources")
            .and_then(Object::as_dict)
            .map_err(|_| format!("{page_label} must have a direct resource dictionary."))?;
        allowed_keys(resources, &[b"XObject"], "page resources")?;
        let xobjects = resources
            .get(b"XObject")
            .and_then(Object::as_dict)
            .map_err(|_| format!("{page_label} must have one direct image resource dictionary."))?;
        if xobjects.len() != 1 {
            return Err(format!(
                "{page_label} must have exactly one image resource."
            ));
        }
        let (image_name, image_object) = xobjects.iter().next().expect("one image was required");
        if image_name.as_slice() != b"Image" {
            return Err(format!(
                "{page_label} uses an unexpected image resource name."
            ));
        }
        let image_id = image_object
            .as_reference()
            .map_err(|_| format!("{page_label}'s image must be indirect."))?;
        if !image_ids.insert(image_id) {
            return Err("Sanitized pages cannot reuse an image stream.".into());
        }
        let image = stream_at(&document, image_id, "page image")?;
        let (image_width, image_height, pixels) = validate_image_header(image, &page_label)?;
        total_pixels = total_pixels
            .checked_add(pixels)
            .ok_or("The candidate PDF pixel count is out of range.")?;
        if total_pixels > MAX_TOTAL_IMAGE_PIXELS {
            return Err(
                "The candidate PDF exceeds the 32 megapixel aggregate sanitization limit.".into(),
            );
        }
        images.push((
            image,
            page_label,
            page_width,
            page_height,
            image_width,
            image_height,
            pixels,
        ));
        allowed_objects.extend([page_id, content_id, image_id]);
    }

    let mut raster_pages = Vec::with_capacity(expected_pages);
    for (image, page_label, page_width, page_height, image_width, image_height, pixels) in images {
        let rgb = validate_image_payload(image, &page_label, pixels)?;
        raster_pages.push((page_width, page_height, image_width, image_height, rgb));
    }

    let mut xref_streams = 0usize;
    for (id, object) in &document.objects {
        if allowed_objects.contains(id) {
            continue;
        }
        let stream = object.as_stream().map_err(|_| "The candidate PDF contains an extra or unreachable object that could retain source content.")?;
        validate_xref_stream(stream, root_id)?;
        xref_streams += 1;
        if xref_streams > 1 {
            return Err("The candidate PDF contains multiple cross-reference streams.".into());
        }
    }
    if xref_streams != usize::from(has_xref_trailer) {
        return Err("The candidate PDF's trailer and cross-reference objects disagree.".into());
    }
    let canonical_bytes = assemble_canonical(&raster_pages)?;
    if canonical_bytes != bytes {
        return Err(
            "The candidate PDF is not the exact canonical output of the trusted raster writer."
                .into(),
        );
    }
    Ok(CleanRasterSummary {
        pages: expected_pages,
        total_pixels,
    })
}

fn validate_xref_stream(stream: &Stream, root_id: ObjectId) -> Result<(), String> {
    allowed_keys(
        &stream.dict,
        &[
            b"Root", b"Size", b"Type", b"W", b"Index", b"Filter", b"Length",
        ],
        "cross-reference stream",
    )?;
    require_name(&stream.dict, b"Type", b"XRef", "cross-reference stream")?;
    if stream.dict.has(b"Filter")
        && stream.dict.get(b"Filter").and_then(Object::as_name).ok() != Some(b"ASCIIHexDecode")
    {
        return Err("The cross-reference stream uses an unsupported filter.".into());
    }
    if required_reference(&stream.dict, b"Root", "cross-reference stream")? != root_id {
        return Err("The cross-reference stream points to a different catalog.".into());
    }
    let widths = stream
        .dict
        .get(b"W")
        .and_then(Object::as_array)
        .map_err(|_| "The cross-reference stream has no valid /W array.")?;
    let widths = widths
        .iter()
        .map(Object::as_i64)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The cross-reference stream /W array is invalid.")?;
    if widths != [1, 4, 2] {
        return Err("The cross-reference stream uses an unsupported record layout.".into());
    }
    let index = stream
        .dict
        .get(b"Index")
        .and_then(Object::as_array)
        .map_err(|_| "The cross-reference stream has no valid /Index array.")?;
    let index = index
        .iter()
        .map(Object::as_i64)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The cross-reference stream /Index array is invalid.")?;
    if index.is_empty() || index.len() % 2 != 0 || index.iter().any(|value| *value < 0) {
        return Err("The cross-reference stream /Index array is invalid.".into());
    }
    let records = index
        .chunks_exact(2)
        .try_fold(0usize, |total, pair| {
            usize::try_from(pair[1])
                .ok()
                .and_then(|count| total.checked_add(count))
        })
        .ok_or("The cross-reference stream record count is out of range.")?;
    let expected_bytes = records
        .checked_mul(7)
        .ok_or("The cross-reference stream size is out of range.")?;
    let decoded = stream
        .decompressed_content_with_limit(expected_bytes.saturating_add(1))
        .map_err(|_| "The cross-reference stream cannot be decoded within its declared size.")?;
    if decoded.len() != expected_bytes {
        return Err("The cross-reference stream contains trailing or missing record bytes.".into());
    }
    Ok(())
}

fn dictionary_at<'a>(
    document: &'a Document,
    id: ObjectId,
    label: &str,
) -> Result<&'a Dictionary, String> {
    document
        .get_object(id)
        .and_then(Object::as_dict)
        .map_err(|_| format!("The {label} object is not a dictionary."))
}

fn stream_at<'a>(document: &'a Document, id: ObjectId, label: &str) -> Result<&'a Stream, String> {
    document
        .get_object(id)
        .and_then(Object::as_stream)
        .map_err(|_| format!("The {label} object is not a stream."))
}

fn allowed_keys(dictionary: &Dictionary, allowed: &[&[u8]], label: &str) -> Result<(), String> {
    if let Some(key) = dictionary
        .iter()
        .map(|(key, _)| key)
        .find(|key| !allowed.iter().any(|allowed| key.as_slice() == *allowed))
    {
        return Err(format!(
            "The {label} contains unsupported entry /{}.",
            String::from_utf8_lossy(key)
        ));
    }
    Ok(())
}

fn required_reference(
    dictionary: &Dictionary,
    key: &[u8],
    label: &str,
) -> Result<ObjectId, String> {
    dictionary
        .get(key)
        .and_then(Object::as_reference)
        .map_err(|_| {
            format!(
                "The {label} has no valid /{} reference.",
                String::from_utf8_lossy(key)
            )
        })
}

fn require_name(
    dictionary: &Dictionary,
    key: &[u8],
    expected: &[u8],
    label: &str,
) -> Result<(), String> {
    if dictionary.get(key).and_then(Object::as_name).ok() != Some(expected) {
        return Err(format!(
            "The {label} has an invalid /{} value.",
            String::from_utf8_lossy(key)
        ));
    }
    Ok(())
}

fn validate_media_box(page: &Dictionary, label: &str) -> Result<(f32, f32), String> {
    let media_box = page
        .get(b"MediaBox")
        .and_then(Object::as_array)
        .map_err(|_| format!("{label} has no direct /MediaBox."))?;
    if media_box.len() != 4 {
        return Err(format!("{label} has an invalid /MediaBox."));
    }
    let values = media_box
        .iter()
        .map(Object::as_float)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| format!("{label} has a nonnumeric /MediaBox."))?;
    if values.iter().any(|value| !value.is_finite())
        || values[0] != 0.0
        || values[1] != 0.0
        || values[2] <= 0.0
        || values[3] <= 0.0
    {
        return Err(format!("{label} has an unsupported /MediaBox."));
    }
    Ok((values[2], values[3]))
}

fn validate_content(stream: &Stream, page_width: f32, page_height: f32) -> Result<(), String> {
    let bytes = stream
        .decompressed_content_with_limit(4_096)
        .map_err(|_| "The page content stream cannot be decoded within its 4 KiB limit.")?;
    let content = Content::decode(&bytes).map_err(|_| "The page content stream is malformed.")?;
    let operators = content
        .operations
        .iter()
        .map(|operation| operation.operator.as_str())
        .collect::<Vec<_>>();
    if operators != ["q", "cm", "Do", "Q"] {
        return Err("The page content stream is not the exact raster-only paint sequence.".into());
    }
    if !content.operations[0].operands.is_empty()
        || !content.operations[3].operands.is_empty()
        || content.operations[1].operands.len() != 6
        || content.operations[1]
            .operands
            .iter()
            .any(|operand| operand.as_float().map_or(true, |value| !value.is_finite()))
        || content.operations[1]
            .operands
            .iter()
            .map(|operand| operand.as_float().unwrap())
            .collect::<Vec<_>>()
            != [page_width, 0.0, 0.0, page_height, 0.0, 0.0]
        || content.operations[2].operands.as_slice() != [Object::Name(b"Image".to_vec())]
    {
        return Err("The raster-only paint sequence has invalid operands.".into());
    }
    validate_canonical_flate_payload(stream, &bytes, "page content stream")?;
    Ok(())
}

fn validate_optional_flate_filter(stream: &Stream, label: &str) -> Result<(), String> {
    if stream.dict.has(b"Filter")
        && stream.dict.get(b"Filter").and_then(Object::as_name).ok() != Some(b"FlateDecode")
    {
        return Err(format!("The {label} uses an unsupported filter."));
    }
    Ok(())
}

fn validate_image_header(image: &Stream, label: &str) -> Result<(u32, u32, u64), String> {
    allowed_keys(
        &image.dict,
        &[
            b"Type",
            b"Subtype",
            b"Width",
            b"Height",
            b"ColorSpace",
            b"BitsPerComponent",
            b"Length",
            b"Filter",
        ],
        "page image",
    )?;
    validate_optional_flate_filter(image, "page image")?;
    require_name(&image.dict, b"Type", b"XObject", "page image")?;
    require_name(&image.dict, b"Subtype", b"Image", "page image")?;
    require_name(&image.dict, b"ColorSpace", b"DeviceRGB", "page image")?;
    if image
        .dict
        .get(b"BitsPerComponent")
        .and_then(Object::as_i64)
        .ok()
        != Some(8)
    {
        return Err(format!("{label}'s image must use 8-bit RGB pixels."));
    }
    let width = image
        .dict
        .get(b"Width")
        .and_then(Object::as_i64)
        .map_err(|_| format!("{label}'s image width is invalid."))?;
    let height = image
        .dict
        .get(b"Height")
        .and_then(Object::as_i64)
        .map_err(|_| format!("{label}'s image height is invalid."))?;
    let pixels = u64::try_from(width)
        .ok()
        .and_then(|width| {
            u64::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or_else(|| format!("{label}'s image dimensions are invalid."))?;
    if width == 0 || height == 0 || pixels > MAX_IMAGE_PIXELS_PER_PAGE {
        return Err(format!(
            "{label}'s image exceeds the 32 megapixel page limit."
        ));
    }
    Ok((width as u32, height as u32, pixels))
}

fn validate_image_payload(image: &Stream, label: &str, pixels: u64) -> Result<Vec<u8>, String> {
    let expected_bytes = pixels
        .checked_mul(3)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("{label}'s image size is out of range."))?;
    let decoded = image
        .decompressed_content_with_limit(expected_bytes.saturating_add(1))
        .map_err(|_| format!("{label}'s image cannot be decoded within its declared size."))?;
    if decoded.len() != expected_bytes {
        return Err(format!(
            "{label}'s decoded RGB byte count does not match its dimensions."
        ));
    }
    validate_canonical_flate_payload(image, &decoded, "page image")?;
    Ok(decoded)
}

fn validate_canonical_flate_payload(
    stream: &Stream,
    decoded: &[u8],
    label: &str,
) -> Result<(), String> {
    if !stream.dict.has(b"Filter") {
        if stream.content != decoded {
            return Err(format!("The {label} has noncanonical unfiltered bytes."));
        }
        return Ok(());
    }
    let mut canonical = Stream::new(Dictionary::new(), decoded.to_vec());
    canonical
        .compress()
        .map_err(|_| format!("The {label} cannot be canonically recompressed."))?;
    if canonical.content != stream.content {
        return Err(format!(
            "The {label} contains trailing or noncanonical compressed bytes."
        ));
    }
    Ok(())
}

fn assemble_canonical(pages_data: &[(f32, f32, u32, u32, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let mut kids = Vec::with_capacity(pages_data.len());
    for (page_width, page_height, image_width, image_height, rgb) in pages_data {
        let mut image = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => i64::from(*image_width),
                "Height" => i64::from(*image_height), "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
            },
            rgb.clone(),
        );
        image.compress().map_err(|error| {
            format!("The raster image cannot be canonically compressed: {error}")
        })?;
        let image_id = document.add_object(image);
        let content = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        Object::Real(*page_width),
                        0.into(),
                        0.into(),
                        Object::Real(*page_height),
                        0.into(),
                        0.into(),
                    ],
                ),
                Operation::new("Do", vec![Object::Name(b"Image".to_vec())]),
                Operation::new("Q", vec![]),
            ],
        }
        .encode()
        .map_err(|error| format!("The raster page cannot be canonically encoded: {error}"))?;
        let content_id = document.add_object(Stream::new(dictionary! {}, content));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), Object::Real(*page_width), Object::Real(*page_height)],
            "Resources" => dictionary! { "XObject" => dictionary! { "Image" => image_id } },
            "Contents" => content_id,
        });
        kids.push(page_id.into());
    }
    document.objects.insert(
        pages_id,
        dictionary! { "Type" => "Pages", "Count" => pages_data.len() as i64, "Kids" => kids }
            .into(),
    );
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document
        .save_to(&mut bytes)
        .map_err(|error| format!("The raster PDF cannot be canonically serialized: {error}"))?;
    Ok(bytes)
}
