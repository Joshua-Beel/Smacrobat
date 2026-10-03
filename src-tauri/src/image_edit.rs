use std::collections::{BTreeMap, BTreeSet};

use lopdf::{content::Content, Dictionary, Document, Object, ObjectId, Stream};

pub const MAX_IMAGE_EDIT_INPUT: usize = 256 * 1024 * 1024;
pub const MAX_IMAGE_EDIT_OUTPUT: usize = 256 * 1024 * 1024;
pub const MAX_IMAGE_EDIT_OBJECTS: usize = 20_000;
pub const MAX_IMAGE_EDIT_PAGES: usize = 4_096;
pub const MAX_IMAGE_EDIT_CONTENT: usize = 4_096;
pub const MAX_IMAGE_EDIT_PIXELS: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct ImageEditTargetInfo {
    pub page_width: f32,
    pub page_height: f32,
    pub pixel_width: u32,
    pub pixel_height: u32,
}

pub fn inspect_flat_raster_image(source: &[u8], physical_page: u32) -> Result<ImageEditTargetInfo, String> {
    if source.len() > MAX_IMAGE_EDIT_INPUT { return Err("image-edit source exceeds the input limit".into()); }
    require_exact_eof(source)?;
    let document = Document::load_mem(source).map_err(|error| format!("image-edit source is malformed: {error}"))?;
    let profile = validate_profile(&document)?;
    let target = profile.pages.get(usize::try_from(physical_page).unwrap_or(usize::MAX).wrapping_sub(1)).ok_or("image-edit page is outside the document")?;
    Ok(ImageEditTargetInfo { page_width: target.page_width, page_height: target.page_height, pixel_width: target.width, pixel_height: target.height })
}

pub fn replace_flat_raster_image(
    source: &[u8],
    physical_page: u32,
    replacement_rgb: &[u8],
) -> Result<Vec<u8>, String> {
    if source.len() > MAX_IMAGE_EDIT_INPUT {
        return Err("image-edit source exceeds the input limit".into());
    }
    require_exact_eof(source)?;
    let mut document = Document::load_mem(source)
        .map_err(|error| format!("image-edit source is malformed: {error}"))?;
    let profile = validate_profile(&document)?;
    let target = profile
        .pages
        .get(usize::try_from(physical_page).unwrap_or(usize::MAX).wrapping_sub(1))
        .ok_or_else(|| "image-edit page is outside the document".to_string())?;
    let expected = usize::try_from(
        u64::from(target.width)
            .checked_mul(u64::from(target.height))
            .and_then(|value| value.checked_mul(3))
            .ok_or_else(|| "image-edit replacement length overflows".to_string())?,
    )
    .map_err(|_| "image-edit replacement length overflows".to_string())?;
    if replacement_rgb.len() != expected {
        return Err("image-edit replacement must exactly match the source pixel dimensions".into());
    }

    let original_objects = document.objects.clone();
    let image = document
        .get_object_mut(target.image_id)
        .and_then(Object::as_stream_mut)
        .map_err(|_| "image-edit target image disappeared".to_string())?;
    image.set_content(replacement_rgb.to_vec());
    image.dict.remove(b"Filter");
    image
        .compress()
        .map_err(|error| format!("image-edit replacement cannot be compressed: {error}"))?;
    let expected_target = image.clone();

    let mut output = Vec::new();
    document
        .save_to(&mut output)
        .map_err(|error| format!("image-edit output cannot be serialized: {error}"))?;
    if output.len() > MAX_IMAGE_EDIT_OUTPUT {
        return Err("image-edit output exceeds the output limit".into());
    }
    require_exact_eof(&output)?;
    let reopened = Document::load_mem(&output)
        .map_err(|error| format!("image-edit output cannot be reopened: {error}"))?;
    let output_profile = validate_profile(&reopened)?;
    let output_target = output_profile
        .pages
        .get(usize::try_from(physical_page).unwrap_or(usize::MAX).wrapping_sub(1))
        .ok_or_else(|| "image-edit output page is missing".to_string())?;
    if output_target != target {
        return Err("image-edit output changed target identity or geometry".into());
    }
    for (id, original) in &original_objects {
        if profile.xref_ids.contains(id) {
            continue;
        }
        let actual = reopened
            .objects
            .get(id)
            .ok_or_else(|| "image-edit output removed an object".to_string())?;
        if *id == target.image_id {
            if actual != &Object::Stream(expected_target.clone()) {
                return Err("image-edit output changed unsupported target image fields".into());
            }
        } else if actual != original {
            return Err("image-edit output changed a non-target object".into());
        }
    }
    if reopened.objects.len().saturating_sub(output_profile.xref_ids.len())
        != original_objects.len().saturating_sub(profile.xref_ids.len())
    {
        return Err("image-edit output added an object".into());
    }
    Ok(output)
}

#[derive(Clone, Debug, PartialEq)]
struct ImageTarget {
    image_id: ObjectId,
    width: u32,
    height: u32,
    page_width: f32,
    page_height: f32,
}

struct Profile {
    pages: Vec<ImageTarget>,
    xref_ids: BTreeSet<ObjectId>,
}

fn validate_profile(document: &Document) -> Result<Profile, String> {
    if document.is_encrypted() {
        return Err("encrypted PDFs cannot use strict image editing".into());
    }
    if document.objects.len() > MAX_IMAGE_EDIT_OBJECTS {
        return Err("image-edit source exceeds the object limit".into());
    }
    require_keys(&document.trailer, &[b"Root", b"Type", b"Size"])?;
    require_name(&document.trailer, b"Type", b"XRef")?;
    let root_id = document
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|_| "image-edit source has no direct catalog reference".to_string())?;
    let catalog = document
        .get_dictionary(root_id)
        .map_err(|_| "image-edit catalog is malformed".to_string())?;
    require_keys(catalog, &[b"Type", b"Pages"])?;
    require_name(catalog, b"Type", b"Catalog")?;
    let pages_id = catalog
        .get(b"Pages")
        .and_then(Object::as_reference)
        .map_err(|_| "image-edit page tree must be direct and flat".to_string())?;
    let pages = document
        .get_dictionary(pages_id)
        .map_err(|_| "image-edit page tree is malformed".to_string())?;
    require_keys(pages, &[b"Type", b"Count", b"Kids"])?;
    require_name(pages, b"Type", b"Pages")?;
    let kids = pages
        .get(b"Kids")
        .and_then(Object::as_array)
        .map_err(|_| "image-edit page tree has invalid children".to_string())?;
    if kids.is_empty() || kids.len() > MAX_IMAGE_EDIT_PAGES {
        return Err("image-edit page count is outside the supported range".into());
    }
    if pages.get(b"Count").and_then(Object::as_i64).ok() != Some(kids.len() as i64) {
        return Err("image-edit page count does not match its children".into());
    }

    let mut reachable = BTreeSet::from([root_id, pages_id]);
    let mut references: BTreeMap<ObjectId, usize> = BTreeMap::new();
    count_references(&document.trailer.clone().into(), &mut references);
    for object in document.objects.values() {
        count_references(object, &mut references);
    }
    let mut result = Vec::with_capacity(kids.len());
    let mut pixels = 0_u64;
    for kid in kids {
        let page_id = kid
            .as_reference()
            .map_err(|_| "image-edit page tree must contain only references".to_string())?;
        reachable.insert(page_id);
        let page = document
            .get_dictionary(page_id)
            .map_err(|_| "image-edit page is malformed".to_string())?;
        require_keys(page, &[b"Type", b"Parent", b"MediaBox", b"Resources", b"Contents"])?;
        require_name(page, b"Type", b"Page")?;
        if page.get(b"Parent").and_then(Object::as_reference).ok() != Some(pages_id) {
            return Err("image-edit page tree is not flat".into());
        }
        let media = page.get(b"MediaBox").map_err(|_| "image-edit page has no direct MediaBox".to_string())?;
        let (page_width, page_height) = media_box(media)?;
        let resources = page
            .get(b"Resources")
            .and_then(Object::as_dict)
            .map_err(|_| "image-edit resources must be direct".to_string())?;
        require_keys(resources, &[b"XObject"])?;
        let xobjects = resources
            .get(b"XObject")
            .and_then(Object::as_dict)
            .map_err(|_| "image-edit XObject resources must be direct".to_string())?;
        if xobjects.len() != 1 {
            return Err("image-edit page must have exactly one image resource".into());
        }
        let (name, image_object) = xobjects.iter().next().unwrap();
        let image_id = image_object
            .as_reference()
            .map_err(|_| "image-edit image must be an indirect object".to_string())?;
        if references.get(&image_id).copied() != Some(1) || !reachable.insert(image_id) {
            return Err("image-edit image is shared or aliased".into());
        }
        let contents_id = page
            .get(b"Contents")
            .and_then(Object::as_reference)
            .map_err(|_| "image-edit page must have one indirect content stream".to_string())?;
        if references.get(&contents_id).copied() != Some(1) || !reachable.insert(contents_id) {
            return Err("image-edit content stream is shared or aliased".into());
        }
        validate_content(document, contents_id, name, page_width, page_height)?;
        let (width, height) = validate_image(document, image_id)?;
        pixels = pixels
            .checked_add(u64::from(width) * u64::from(height))
            .ok_or_else(|| "image-edit pixel count overflows".to_string())?;
        if pixels > MAX_IMAGE_EDIT_PIXELS {
            return Err("image-edit source exceeds the aggregate pixel limit".into());
        }
        result.push(ImageTarget { image_id, width, height, page_width, page_height });
    }
    let xref_ids: BTreeSet<_> = document.objects.iter().filter_map(|(id, object)| {
        let stream = object.as_stream().ok()?;
        (stream.dict.get(b"Type").and_then(Object::as_name).ok() == Some(b"XRef")).then_some(*id)
    }).collect();
    if xref_ids.len() > 1 { return Err("image-edit source has unsupported cross-reference structure".into()); }
    for id in &xref_ids { validate_xref_stream(document, *id, root_id)?; }
    reachable.extend(xref_ids.iter().copied());
    let object_ids: BTreeSet<_> = document.objects.keys().copied().collect();
    if reachable != object_ids {
        return Err(format!("image-edit source contains extra or unreachable objects: reachable={reachable:?}, objects={object_ids:?}"));
    }
    Ok(Profile { pages: result, xref_ids })
}

fn validate_content(document: &Document, id: ObjectId, name: &[u8], width: f32, height: f32) -> Result<(), String> {
    let stream = document.get_object(id).and_then(Object::as_stream)
        .map_err(|_| "image-edit content object is not a stream".to_string())?;
    if stream.dict.iter().any(|(key, _)| key.as_slice() != b"Length") {
        return Err("image-edit content stream has unsupported fields".into());
    }
    if stream.content.len() > MAX_IMAGE_EDIT_CONTENT {
        return Err("image-edit content exceeds its byte limit".into());
    }
    let content = Content::decode(&stream.content).map_err(|_| "image-edit content is malformed".to_string())?;
    if content.operations.len() != 4 || content.operations[0].operator != "q"
        || content.operations[1].operator != "cm" || content.operations[2].operator != "Do"
        || content.operations[3].operator != "Q" || !content.operations[0].operands.is_empty()
        || !content.operations[3].operands.is_empty()
    {
        return Err("image-edit page has unsupported drawing operations".into());
    }
    let matrix = &content.operations[1].operands;
    if matrix.len() != 6 || number(&matrix[0])? != width || number(&matrix[1])? != 0.0
        || number(&matrix[2])? != 0.0 || number(&matrix[3])? != height
        || number(&matrix[4])? != 0.0 || number(&matrix[5])? != 0.0
    {
        return Err("image-edit page has unsupported crop or rotation geometry".into());
    }
    if content.operations[2].operands.as_slice() != [Object::Name(name.to_vec())] {
        return Err("image-edit page draws a different resource".into());
    }
    Ok(())
}

fn validate_image(document: &Document, id: ObjectId) -> Result<(u32, u32), String> {
    let stream = document.get_object(id).and_then(Object::as_stream)
        .map_err(|_| "image-edit target is not an image stream".to_string())?;
    for key in stream.dict.iter().map(|(key, _)| key.as_slice()) {
        if ![b"Type".as_slice(), b"Subtype", b"Width", b"Height", b"ColorSpace", b"BitsPerComponent", b"Filter", b"Length"].contains(&key) {
            return Err("image-edit image has unsupported channels or fields".into());
        }
    }
    require_name(&stream.dict, b"Type", b"XObject")?;
    require_name(&stream.dict, b"Subtype", b"Image")?;
    require_name(&stream.dict, b"ColorSpace", b"DeviceRGB")?;
    if stream.dict.get(b"BitsPerComponent").and_then(Object::as_i64).ok() != Some(8) {
        return Err("image-edit image is not RGB8".into());
    }
    let width = positive_u32(stream.dict.get(b"Width").map_err(|_| "image-edit image has no width".to_string())?)?;
    let height = positive_u32(stream.dict.get(b"Height").map_err(|_| "image-edit image has no height".to_string())?)?;
    let image_pixels = u64::from(width).checked_mul(u64::from(height))
        .ok_or_else(|| "image-edit image pixel count overflows".to_string())?;
    let expected = usize::try_from(image_pixels.checked_mul(3)
        .ok_or_else(|| "image-edit image RGB length overflows".to_string())?)
        .map_err(|_| "image-edit image length overflows".to_string())?;
    let decoded = stream.decompressed_content_with_limit(expected.saturating_add(1))
        .map_err(|_| "image-edit image uses an unsupported filter or exceeds its limit".to_string())?;
    if decoded.len() != expected { return Err("image-edit image RGB length is invalid".into()); }
    if let Ok(filter) = stream.dict.get(b"Filter") {
        if filter.as_name().ok() != Some(b"FlateDecode") { return Err("image-edit image filter is unsupported".into()); }
        let mut canonical = Stream::new(Dictionary::new(), decoded);
        canonical.compress().map_err(|_| "image-edit image cannot be recompressed".to_string())?;
        if canonical.content != stream.content { return Err("image-edit image has noncanonical or trailing compressed bytes".into()); }
    }
    Ok((width, height))
}

fn validate_xref_stream(document: &Document, id: ObjectId, root_id: ObjectId) -> Result<(), String> {
    let stream = document.get_object(id).and_then(Object::as_stream)
        .map_err(|_| "image-edit cross-reference object is malformed".to_string())?;
    require_keys(&stream.dict, &[b"Root", b"Type", b"Size", b"W", b"Index", b"Length"])?;
    require_name(&stream.dict, b"Type", b"XRef")?;
    if stream.dict.get(b"Root").and_then(Object::as_reference).ok() != Some(root_id) {
        return Err("image-edit cross-reference root is inconsistent".into());
    }
    let size = stream.dict.get(b"Size").and_then(Object::as_i64)
        .map_err(|_| "image-edit cross-reference size is malformed".to_string())?;
    let max_id = document.objects.keys().map(|value| value.0).max().unwrap_or(0);
    if size != i64::from(max_id) + 1 { return Err("image-edit cross-reference size is inconsistent".into()); }
    let widths = stream.dict.get(b"W").and_then(Object::as_array)
        .map_err(|_| "image-edit cross-reference widths are malformed".to_string())?;
    if widths.len() != 3 || widths[0].as_i64().ok() != Some(1)
        || widths[1].as_i64().ok() != Some(4) || widths[2].as_i64().ok() != Some(2) {
        return Err("image-edit cross-reference widths are unsupported".into());
    }
    let index = stream.dict.get(b"Index").and_then(Object::as_array)
        .map_err(|_| "image-edit cross-reference index is malformed".to_string())?;
    if index.is_empty() || index.len() % 2 != 0 { return Err("image-edit cross-reference index is unsupported".into()); }
    let mut indexed_ids = Vec::new();
    for pair in index.chunks_exact(2) {
        let start = u32::try_from(pair[0].as_i64().map_err(|_| "image-edit cross-reference index is malformed".to_string())?)
            .map_err(|_| "image-edit cross-reference index is malformed".to_string())?;
        let count = u32::try_from(pair[1].as_i64().map_err(|_| "image-edit cross-reference index is malformed".to_string())?)
            .map_err(|_| "image-edit cross-reference index is malformed".to_string())?;
        for value in start..start.checked_add(count).ok_or_else(|| "image-edit cross-reference index overflows".to_string())? { indexed_ids.push(value); }
    }
    let object_ids: Vec<_> = document.objects.keys().map(|value| value.0).collect();
    if indexed_ids != object_ids { return Err("image-edit cross-reference index is inconsistent".into()); }
    if stream.content.len() != document.objects.len().checked_mul(7).ok_or_else(|| "image-edit cross-reference length overflows".to_string())? {
        return Err("image-edit cross-reference payload length is inconsistent".into());
    }
    for (offset, object_id) in indexed_ids.into_iter().enumerate() {
        let entry = &stream.content[offset * 7..offset * 7 + 7];
        let generation = document.objects.keys().find(|value| value.0 == object_id)
            .map(|value| value.1).ok_or_else(|| "image-edit cross-reference IDs are not contiguous".to_string())?;
        if entry[0] != 1 || entry[1..5] == [0, 0, 0, 0] || u16::from_be_bytes([entry[5], entry[6]]) != generation {
            return Err("image-edit cross-reference entry is inconsistent".into());
        }
    }
    Ok(())
}

fn media_box(value: &Object) -> Result<(f32, f32), String> {
    let values = value.as_array().map_err(|_| "image-edit MediaBox is malformed".to_string())?;
    if values.len() != 4 || number(&values[0])? != 0.0 || number(&values[1])? != 0.0 { return Err("image-edit MediaBox must start at zero".into()); }
    let width = number(&values[2])?; let height = number(&values[3])?;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 { return Err("image-edit MediaBox is invalid".into()); }
    Ok((width, height))
}

fn require_keys(dict: &Dictionary, keys: &[&[u8]]) -> Result<(), String> {
    if dict.len() != keys.len() || keys.iter().any(|key| !dict.has(key)) { return Err("image-edit object has unsupported fields".into()); }
    Ok(())
}
fn require_name(dict: &Dictionary, key: &[u8], expected: &[u8]) -> Result<(), String> {
    if dict.get(key).and_then(Object::as_name).ok() != Some(expected) { return Err("image-edit object has an unsupported type".into()); }
    Ok(())
}
fn positive_u32(value: &Object) -> Result<u32, String> {
    let value = value.as_i64().map_err(|_| "image-edit dimension is malformed".to_string())?;
    u32::try_from(value).ok().filter(|value| *value > 0).ok_or_else(|| "image-edit dimension is invalid".to_string())
}
fn number(value: &Object) -> Result<f32, String> {
    match value { Object::Integer(value) => Ok(*value as f32), Object::Real(value) => Ok(*value), _ => Err("image-edit number is malformed".into()) }
}
fn count_references(object: &Object, counts: &mut BTreeMap<ObjectId, usize>) {
    match object {
        Object::Reference(id) => *counts.entry(*id).or_default() += 1,
        Object::Array(values) => values.iter().for_each(|value| count_references(value, counts)),
        Object::Dictionary(dict) => dict.iter().for_each(|(_, value)| count_references(value, counts)),
        Object::Stream(stream) => stream.dict.iter().for_each(|(_, value)| count_references(value, counts)),
        _ => {}
    }
}
fn require_exact_eof(bytes: &[u8]) -> Result<(), String> {
    let eof = bytes.windows(5).rposition(|value| value == b"%%EOF").ok_or_else(|| "image-edit PDF has no EOF marker".to_string())?;
    if bytes[eof + 5..].iter().any(|byte| !byte.is_ascii_whitespace()) { return Err("image-edit PDF has trailing serialized data".into()); }
    Ok(())
}
