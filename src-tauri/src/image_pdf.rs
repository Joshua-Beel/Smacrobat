use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, Limits};
use lopdf::{content::{Content, Operation}, dictionary, Document, Object, Stream};
use serde::Deserialize;
use std::{fs::File, io::{Cursor, Read}, path::Path};

const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EDGE_PIXELS: u32 = 16_384;
const MAX_PIXELS: u64 = 32_000_000;
const MAX_DECODED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImagePdfPageSize { Letter, A4 }

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImagePdfOrientation { Auto, Portrait, Landscape }

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePdfOptions {
    pub page_size: ImagePdfPageSize,
    pub orientation: ImagePdfOrientation,
    pub margin_points: f32,
}

#[derive(Debug)]
pub struct PreparedImagePdf {
    pub bytes: Vec<u8>,
    pub page_width: f32,
    pub page_height: f32,
}

fn read_source(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| format!("Could not open the source image: {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1).read_to_end(&mut bytes).map_err(|error| format!("Could not read the source image: {error}"))?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES { return Err("The source image exceeds the 64 MiB input limit.".into()); }
    if bytes.is_empty() { return Err("The source image is empty.".into()); }
    Ok(bytes)
}

fn validate_output_path(path: &Path) -> Result<(), String> {
    if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("pdf")) { return Err("The output filename must end in .pdf.".into()); }
    if path.symlink_metadata().is_ok() { return Err("That file already exists. Choose a new filename; Create PDF never overwrites an existing file.".into()); }
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).ok_or("Choose an output folder.")?;
    if !parent.is_dir() { return Err("Choose an existing output folder.".into()); }
    Ok(())
}

fn png_is_single(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("The source is not a valid PNG image.".into()); }
    let mut offset = 8usize;
    let mut ended = false;
    while offset < bytes.len() {
        let header = bytes.get(offset..offset + 8).ok_or("The PNG chunk table is truncated.")?;
        let length = u32::from_be_bytes(header[..4].try_into().expect("The PNG chunk length has four bytes")) as usize;
        let kind = &header[4..8];
        let end = offset.checked_add(12).and_then(|value| value.checked_add(length)).ok_or("The PNG chunk length is out of range.")?;
        if end > bytes.len() { return Err("The PNG chunk table is truncated.".into()); }
        if kind == b"acTL" { return Err("Animated PNG images are not supported; choose a single-frame PNG or JPEG.".into()); }
        offset = end;
        if kind == b"IEND" {
            if length != 0 { return Err("The PNG end marker is invalid.".into()); }
            ended = true;
            break;
        }
    }
    if !ended || offset != bytes.len() { return Err("The PNG contains trailing or multiple-image data.".into()); }
    Ok(())
}

fn jpeg_is_single(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(&[0xff, 0xd8]) { return Err("The source is not a valid JPEG image.".into()); }
    let mut offset = 2usize;
    let mut in_scan = false;
    loop {
        if in_scan {
            while offset < bytes.len() && bytes[offset] != 0xff { offset += 1; }
            if offset == bytes.len() { return Err("The JPEG image has no end marker.".into()); }
        } else if bytes.get(offset) != Some(&0xff) { return Err("The JPEG marker table is invalid.".into()); }
        while offset < bytes.len() && bytes[offset] == 0xff { offset += 1; }
        let marker = *bytes.get(offset).ok_or("The JPEG marker table is truncated.")?;
        offset += 1;
        if in_scan && (marker == 0x00 || (0xd0..=0xd7).contains(&marker)) { continue; }
        in_scan = false;
        if marker == 0xd9 {
            if bytes[offset..].iter().any(|byte| *byte != 0x00 && *byte != 0xff) { return Err("The JPEG contains trailing or multiple-image data.".into()); }
            return Ok(());
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) { continue; }
        let length_bytes = bytes.get(offset..offset + 2).ok_or("The JPEG marker table is truncated.")?;
        let length = u16::from_be_bytes(length_bytes.try_into().expect("The JPEG segment length has two bytes")) as usize;
        if length < 2 { return Err("The JPEG marker length is invalid.".into()); }
        let end = offset.checked_add(length).ok_or("The JPEG marker length is out of range.")?;
        let data = bytes.get(offset + 2..end).ok_or("The JPEG marker table is truncated.")?;
        if marker == 0xe2 && data.starts_with(b"MPF\0") { return Err("Multi-picture JPEG images are not supported; choose one PNG or JPEG image.".into()); }
        offset = end;
        if marker == 0xda { in_scan = true; }
    }
}

fn decode(bytes: Vec<u8>) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes.as_slice())).with_guessed_format().map_err(|error| format!("Could not identify the source image: {error}"))?;
    let format = reader.format().ok_or("Only PNG and JPEG images are supported.")?;
    match format {
        ImageFormat::Png => png_is_single(&bytes)?,
        ImageFormat::Jpeg => jpeg_is_single(&bytes)?,
        _ => return Err("Only PNG and JPEG images are supported.".into()),
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_EDGE_PIXELS);
    limits.max_image_height = Some(MAX_EDGE_PIXELS);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|error| format!("Could not read the image header: {error}"))?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 { return Err("The source image has invalid zero dimensions.".into()); }
    let pixels = u64::from(width).checked_mul(u64::from(height)).ok_or("The source image dimensions are out of range.")?;
    if pixels > MAX_PIXELS { return Err("The source image exceeds the 32 megapixel decoded-image limit.".into()); }
    if decoder.total_bytes() > MAX_DECODED_BYTES { return Err("The source image exceeds the 128 MiB decoded-image limit.".into()); }
    let orientation = decoder.orientation().map_err(|error| format!("Could not read JPEG orientation metadata: {error}"))?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|error| format!("Could not decode the source image: {error}"))?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn composite_on_white(image: DynamicImage) -> Result<(u32, u32, Vec<u8>), String> {
    let (width, height) = image.dimensions();
    let pixels = u64::from(width).checked_mul(u64::from(height)).ok_or("The oriented image dimensions are out of range.")?;
    let rgb_bytes = pixels.checked_mul(3).ok_or("The converted image size is out of range.")?;
    if pixels > MAX_PIXELS || rgb_bytes > MAX_DECODED_BYTES { return Err("The oriented image exceeds the decoded-image limit.".into()); }
    let rgba = image.into_rgba8().into_raw();
    let capacity = usize::try_from(rgb_bytes).map_err(|_| "The converted image size is out of range.")?;
    let mut rgb = Vec::with_capacity(capacity);
    for pixel in rgba.chunks_exact(4) {
        let alpha = u16::from(pixel[3]);
        for channel in &pixel[..3] {
            let value = (u16::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255;
            rgb.push(value as u8);
        }
    }
    Ok((width, height, rgb))
}

fn page_dimensions(options: ImagePdfOptions, image_width: u32, image_height: u32) -> Result<(f32, f32, f32), String> {
    if !options.margin_points.is_finite() || !(0.0..=72.0).contains(&options.margin_points) { return Err("Page margins must be a finite value from 0 to 72 points.".into()); }
    let (short, long) = match options.page_size { ImagePdfPageSize::Letter => (612.0, 792.0), ImagePdfPageSize::A4 => (595.28, 841.89) };
    let landscape = match options.orientation { ImagePdfOrientation::Auto => image_width > image_height, ImagePdfOrientation::Portrait => false, ImagePdfOrientation::Landscape => true };
    let (width, height) = if landscape { (long, short) } else { (short, long) };
    if width - 2.0 * options.margin_points < 1.0 || height - 2.0 * options.margin_points < 1.0 { return Err("Page margins must leave at least one point for the image.".into()); }
    Ok((width, height, options.margin_points))
}

fn assemble(image: DynamicImage, options: ImagePdfOptions) -> Result<PreparedImagePdf, String> {
    let (image_width, image_height, rgb) = composite_on_white(image)?;
    let (page_width, page_height, margin) = page_dimensions(options, image_width, image_height)?;
    let available_width = page_width - 2.0 * margin;
    let available_height = page_height - 2.0 * margin;
    let scale = (available_width / image_width as f32).min(available_height / image_height as f32);
    let placed_width = image_width as f32 * scale;
    let placed_height = image_height as f32 * scale;
    let x = (page_width - placed_width) / 2.0;
    let y = (page_height - placed_height) / 2.0;

    let mut document = Document::with_version("1.7");
    let pages = document.new_object_id();
    let mut image_stream = Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => image_width as i64,
        "Height" => image_height as i64, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
    }, rgb);
    image_stream.compress().map_err(|error| format!("Could not compress the converted image: {error}"))?;
    let image_id = document.add_object(image_stream);
    let content = Content { operations: vec![
        Operation::new("q", vec![]),
        Operation::new("cm", vec![placed_width.into(), 0.into(), 0.into(), placed_height.into(), x.into(), y.into()]),
        Operation::new("Do", vec![Object::Name(b"Image".to_vec())]),
        Operation::new("Q", vec![]),
    ] }.encode().map_err(|error| format!("Could not encode the image page: {error}"))?;
    let content_id = document.add_object(Stream::new(dictionary! {}, content));
    let page = document.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages,
        "MediaBox" => vec![0.into(), 0.into(), Object::Real(page_width), Object::Real(page_height)],
        "Resources" => dictionary! { "XObject" => dictionary! { "Image" => image_id } },
        "Contents" => content_id,
    });
    document.objects.insert(pages, dictionary! { "Type" => "Pages", "Count" => 1, "Kids" => vec![page.into()] }.into());
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).map_err(|error| format!("Could not serialize the image PDF: {error}"))?;
    if bytes.len() > MAX_OUTPUT_BYTES { return Err("The converted PDF exceeds the 256 MiB output limit.".into()); }
    let check = Document::load_mem(&bytes).map_err(|error| format!("The converted PDF is invalid: {error}"))?;
    let checked_pages = check.get_pages();
    if check.is_encrypted() || checked_pages.len() != 1 { return Err("The converted PDF failed its one-page structure check.".into()); }
    let checked_page = check.get_dictionary(*checked_pages.values().next().ok_or("The converted PDF has no page.")?).map_err(|_| "The converted PDF page is invalid.")?;
    let xobjects = checked_page.get(b"Resources").and_then(Object::as_dict).and_then(|resources| resources.get(b"XObject")).and_then(Object::as_dict).map_err(|_| "The converted PDF image resources are invalid.")?;
    if xobjects.len() != 1 { return Err("The converted PDF must contain exactly one image resource.".into()); }
    let checked_image = xobjects.get(b"Image").and_then(Object::as_reference).and_then(|id| check.get_object(id)).and_then(Object::as_stream).map_err(|_| "The converted PDF image resource is invalid.")?;
    if checked_image.dict.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Image")
        || checked_image.dict.get(b"Width").and_then(Object::as_i64).ok() != Some(i64::from(image_width))
        || checked_image.dict.get(b"Height").and_then(Object::as_i64).ok() != Some(i64::from(image_height))
        || checked_image.dict.get(b"ColorSpace").and_then(Object::as_name).ok() != Some(b"DeviceRGB")
        || checked_image.dict.get(b"BitsPerComponent").and_then(Object::as_i64).ok() != Some(8)
    { return Err("The converted PDF image resource differs from the conversion plan.".into()); }
    Ok(PreparedImagePdf { bytes, page_width, page_height })
}

pub fn prepare_and_write(source: &Path, output: &Path, options: ImagePdfOptions, validate: impl FnOnce(&PreparedImagePdf) -> Result<(), String>) -> Result<PreparedImagePdf, String> {
    validate_output_path(output)?;
    let prepared = assemble(decode(read_source(source)?)?, options)?;
    validate(&prepared).map_err(|error| format!("Created PDF validation failed: {error}"))?;
    crate::editor::write_new_file(output, &prepared.bytes)?;
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{metadata::Orientation, ImageBuffer, ImageEncoder, Rgb};

    fn png(width: u32, height: u32, pixels: Vec<u8>, color: image::ExtendedColorType) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes).write_image(&pixels, width, height, color).unwrap();
        bytes
    }

    fn options(page_size: ImagePdfPageSize, orientation: ImagePdfOrientation, margin_points: f32) -> ImagePdfOptions { ImagePdfOptions { page_size, orientation, margin_points } }

    fn base64(value: &str) -> Vec<u8> {
        let decode = |byte| match byte { b'A'..=b'Z' => byte - b'A', b'a'..=b'z' => byte - b'a' + 26, b'0'..=b'9' => byte - b'0' + 52, b'+' => 62, b'/' => 63, _ => 0 };
        let mut output = Vec::new();
        for chunk in value.as_bytes().chunks(4) {
            let first = decode(chunk[0]); let second = decode(chunk[1]); let third = decode(*chunk.get(2).unwrap_or(&b'=')); let fourth = decode(*chunk.get(3).unwrap_or(&b'='));
            output.push(first << 2 | second >> 4);
            if chunk.get(2) != Some(&b'=') { output.push(second << 4 | third >> 2); }
            if chunk.get(3) != Some(&b'=') { output.push(third << 6 | fourth); }
        }
        output
    }

    fn with_exif_orientation(jpeg: &[u8], orientation: u8) -> Vec<u8> {
        let mut exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        exif.extend_from_slice(&[orientation, 0, 0, 0, 0, 0, 0, 0]);
        let mut output = jpeg[..2].to_vec(); output.extend_from_slice(&[0xff, 0xe1]); output.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes()); output.extend_from_slice(&exif); output.extend_from_slice(&jpeg[2..]); output
    }

    fn replace_png_header(bytes: &mut [u8], width: u32, height: u32, depth: u8, color: u8) {
        bytes[16..20].copy_from_slice(&width.to_be_bytes()); bytes[20..24].copy_from_slice(&height.to_be_bytes()); bytes[24] = depth; bytes[25] = color;
        let mut crc = 0xffff_ffffu32;
        for byte in &bytes[12..29] { crc ^= u32::from(*byte); for _ in 0..8 { crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1)); } }
        bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
    }

    #[test]
    fn png_alpha_and_layout_are_normalized_without_cropping() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.bin");
        let output = folder.path().join("created.pdf");
        let bytes = png(2, 1, vec![255, 0, 0, 128, 0, 0, 255, 255], image::ExtendedColorType::Rgba8);
        std::fs::write(&source, &bytes).unwrap();
        let prepared = prepare_and_write(&source, &output, options(ImagePdfPageSize::Letter, ImagePdfOrientation::Auto, 12.0), |_| Ok(())).unwrap();
        assert_eq!((prepared.page_width, prepared.page_height), (792.0, 612.0));
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        let document = Document::load_mem(&prepared.bytes).unwrap();
        let page = *document.get_pages().values().next().unwrap();
        let page = document.get_dictionary(page).unwrap();
        assert_eq!(page.get(b"MediaBox").unwrap().as_array().unwrap()[2].as_float().unwrap(), 792.0);
        let content = Content::decode(&document.get_page_content(*document.get_pages().values().next().unwrap())).unwrap();
        assert_eq!(content.operations[1].operator, "cm");
        assert_eq!(content.operations[1].operands[0].as_float().unwrap(), 768.0);
        assert_eq!(content.operations[1].operands[3].as_float().unwrap(), 384.0);
        let image_id = page.get(b"Resources").unwrap().as_dict().unwrap().get(b"XObject").unwrap().as_dict().unwrap().get(b"Image").unwrap().as_reference().unwrap();
        let rgb = document.get_object(image_id).unwrap().as_stream().unwrap().decompressed_content().unwrap();
        assert_eq!(rgb, vec![255, 127, 127, 0, 0, 255]);
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/image-pdf-probe"); std::fs::create_dir_all(&folder).unwrap();
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let probe_source = folder.join(format!("rgba-2x1-{stamp}.bin")); let probe_pdf = folder.join(format!("rgba-letter-auto-12-{stamp}.pdf"));
        std::fs::copy(&source, &probe_source).unwrap(); std::fs::copy(&output, &probe_pdf).unwrap();
        println!("IMAGE_PDF_PROBE source={} output={} pixels=rgba[(255,0,0,128),(0,0,255,255)] options=letter,auto,12", probe_source.display(), probe_pdf.display());
    }

    #[test]
    fn format_animation_and_resource_limits_fail_before_publication() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.png");
        let output = folder.path().join("created.pdf");
        std::fs::write(&source, b"GIF89a").unwrap();
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("PNG and JPEG"));
        assert!(!output.exists());
        let mut animated = png(1, 1, vec![0, 0, 0, 255], image::ExtendedColorType::Rgba8);
        let iend = animated.len() - 12;
        animated.splice(iend..iend, [0, 0, 0, 8, b'a', b'c', b'T', b'L', 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
        std::fs::write(&source, animated).unwrap();
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("Animated PNG"));
        assert!(!output.exists());
        let single = png(1, 1, vec![0, 0, 0, 255], image::ExtendedColorType::Rgba8); let mut concatenated = single.clone(); concatenated.extend_from_slice(&single); std::fs::write(&source, concatenated).unwrap();
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("trailing or multiple-image"));
        assert!(!output.exists());
        std::fs::write(&source, &single[..20]).unwrap();
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).is_err());
        assert!(!output.exists());
        let huge = png(1, 1, vec![0, 0, 0, 255], image::ExtendedColorType::Rgba8);
        let mut huge = huge;
        huge[16..20].copy_from_slice(&16_385u32.to_be_bytes());
        std::fs::write(&source, huge).unwrap();
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).is_err());
        assert!(!output.exists());
    }

    #[test]
    fn options_and_publication_are_fail_closed() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.jpg");
        let output = folder.path().join("created.pdf");
        let rgb = ImageBuffer::<Rgb<u8>, _>::from_raw(1, 1, vec![10, 20, 30]).unwrap();
        rgb.save_with_format(&source, ImageFormat::Jpeg).unwrap();
        for margin in [f32::NAN, -1.0, 72.1] {
            assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, margin), |_| Ok(())).is_err());
        }
        assert!(!output.exists());
        std::fs::write(&output, b"owned").unwrap();
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Landscape, 72.0), |_| Ok(())).unwrap_err().contains("never overwrites"));
        assert_eq!(std::fs::read(&output).unwrap(), b"owned");
        let first = std::fs::read(&source).unwrap();
        let mut duplicate = first.clone(); duplicate.extend_from_slice(&first);
        std::fs::write(&source, duplicate).unwrap();
        let second_output = folder.path().join("second.pdf");
        assert!(prepare_and_write(&source, &second_output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("multiple-image"));
        assert!(!second_output.exists());
        let mut mpo = first[..2].to_vec(); mpo.extend_from_slice(&[0xff, 0xe2, 0, 6, b'M', b'P', b'F', 0]); mpo.extend_from_slice(&first[2..]); std::fs::write(&source, mpo).unwrap();
        assert!(prepare_and_write(&source, &second_output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("Multi-picture JPEG"));
        assert!(!second_output.exists());
    }

    #[test]
    fn invalid_output_paths_fail_before_source_work() {
        let folder = tempfile::tempdir().unwrap();
        let missing_source = folder.path().join("missing-source.png");
        let wrong_extension = folder.path().join("created.jpg");
        assert!(prepare_and_write(&missing_source, &wrong_extension, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("must end in .pdf"));

        let malformed_source = folder.path().join("malformed.png");
        std::fs::write(&malformed_source, b"GIF89a").unwrap();
        let missing_parent = folder.path().join("missing-folder").join("created.pdf");
        assert!(prepare_and_write(&malformed_source, &missing_parent, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("existing output folder"));

        let existing_output = folder.path().join("owned.pdf");
        std::fs::write(&existing_output, b"owned").unwrap();
        assert!(prepare_and_write(&missing_source, &existing_output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("never overwrites"));
        assert_eq!(std::fs::read(existing_output).unwrap(), b"owned");
    }

    #[test]
    fn all_jpeg_exif_orientations_are_applied_before_auto_layout() {
        let source = ImageBuffer::<Rgb<u8>, _>::from_fn(3, 2, |x, y| Rgb([(x * 70) as u8, (y * 100) as u8, (x * 20 + y * 30) as u8]));
        let mut jpeg = Vec::new(); image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95).encode_image(&source).unwrap();
        let original = image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg).unwrap();
        for exif in 1..=8 {
            let mut expected = original.clone(); expected.apply_orientation(Orientation::from_exif(exif).unwrap());
            let actual = decode(with_exif_orientation(&jpeg, exif)).unwrap();
            assert_eq!(actual.to_rgba8(), expected.to_rgba8(), "EXIF orientation {exif}");
            let (_, height, _) = page_dimensions(options(ImagePdfPageSize::A4, ImagePdfOrientation::Auto, 0.0), actual.width(), actual.height()).unwrap();
            assert_eq!(height == 595.28, actual.width() > actual.height(), "auto page orientation must use oriented dimensions for EXIF {exif}");
        }
    }

    #[test]
    fn decoder_supported_png_and_jpeg_colors_convert_to_rgb() {
        let palette = base64("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAMAAADD/I+4AAADAFBMVEX/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADmyjLsAAAAC0lEQVR4nGNgYAQAAAQAAr96P0oAAAAASUVORK5CYII=");
        drop(palette);
        let palette = base64("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAABlBMVEX/AAAA/wDSh+9xAAAACklEQVR42mNwAAAAQgBBhL+OYgAAAABJRU5ErkJggg==");
        let sixteen = base64("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAAAAACB2fwVAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==");
        let cmyk = base64("/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwACAQEBAQECAQEBAgICAgIEAwICAgIFBAQDBAYFBgYGBQYGBgcJCAYHCQcGBggLCAkKCgoKCgYICwwLCgwJCgoK/8AAFAgAAQACBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD8fv8AgrF/ylN/aW/7OA8Zf+ny8r9ff+CTv/KLL9mn/s3/AMG/+mOzr+f+v38r/9k=");
        for (name, bytes) in [("palette PNG", palette), ("16-bit PNG", sixteen), ("CMYK JPEG", cmyk)] {
            let image = decode(bytes).unwrap_or_else(|error| panic!("{name}: {error}"));
            let (_, _, rgb) = composite_on_white(image).unwrap();
            assert_eq!(rgb.len(), 6, "{name}");
        }
    }

    #[test]
    fn source_pixel_and_decoded_byte_caps_are_independent() {
        let folder = tempfile::tempdir().unwrap(); let source = folder.path().join("source.png"); let output = folder.path().join("created.pdf");
        let base = png(1, 1, vec![0, 0, 0, 255], image::ExtendedColorType::Rgba8);
        let mut too_many_pixels = base.clone(); replace_png_header(&mut too_many_pixels, 8_000, 5_000, 8, 6); std::fs::write(&source, too_many_pixels).unwrap();
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("32 megapixel"));
        let mut too_many_bytes = base; replace_png_header(&mut too_many_bytes, 8_000, 3_000, 16, 6); std::fs::write(&source, too_many_bytes).unwrap();
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("128 MiB"));
        let oversized = File::create(&source).unwrap(); oversized.set_len(MAX_SOURCE_BYTES + 1).unwrap(); drop(oversized);
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::A4, ImagePdfOrientation::Portrait, 0.0), |_| Ok(())).unwrap_err().contains("64 MiB"));
        assert!(!output.exists());
    }

    #[test]
    fn validator_failure_does_not_publish() {
        let folder = tempfile::tempdir().unwrap(); let source = folder.path().join("source.png"); let output = folder.path().join("created.pdf");
        std::fs::write(&source, png(1, 1, vec![1, 2, 3], image::ExtendedColorType::Rgb8)).unwrap();
        assert!(prepare_and_write(&source, &output, options(ImagePdfPageSize::Letter, ImagePdfOrientation::Portrait, 0.0), |_| Err("probe refusal".into())).unwrap_err().contains("probe refusal"));
        assert!(!output.exists());
    }
}
