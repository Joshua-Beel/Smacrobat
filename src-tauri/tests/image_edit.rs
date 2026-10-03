#[path = "../src/image_edit.rs"]
mod image_edit;

use image_edit::{inspect_flat_raster_image, replace_flat_raster_image};
use lopdf::{content::{Content, Operation}, dictionary, Dictionary, Document, Object, Stream};

fn fixture() -> (Vec<u8>, lopdf::ObjectId) {
    let mut pdf = Document::with_version("1.7");
    let pages = pdf.new_object_id();
    let mut image = Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => 2,
        "Height" => 1, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
    }, vec![255, 0, 0, 0, 255, 0]);
    image.compress().unwrap();
    let image_id = pdf.add_object(image);
    let content = Content { operations: vec![
        Operation::new("q", vec![]),
        Operation::new("cm", vec![200.into(), 0.into(), 0.into(), 100.into(), 0.into(), 0.into()]),
        Operation::new("Do", vec![Object::Name(b"Image".to_vec())]),
        Operation::new("Q", vec![]),
    ]}.encode().unwrap();
    let contents = pdf.add_object(Stream::new(Dictionary::new(), content));
    let page = pdf.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
        "Resources" => dictionary! { "XObject" => dictionary! { "Image" => image_id } },
        "Contents" => contents,
    });
    pdf.objects.insert(pages, dictionary! { "Type" => "Pages", "Count" => 1, "Kids" => vec![Object::Reference(page)] }.into());
    let catalog = pdf.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    pdf.trailer.set("Root", catalog);
    let mut bytes = Vec::new(); pdf.save_to(&mut bytes).unwrap();
    (bytes, image_id)
}

#[test]
fn replaces_only_the_unique_rgb_image_object() {
    let (source, image_id) = fixture();
    let before = Document::load_mem(&source).unwrap();
    let output = replace_flat_raster_image(&source, 1, &[0, 0, 255, 255, 255, 255]).unwrap();
    let after = Document::load_mem(&output).unwrap();
    assert_eq!(before.objects.len(), after.objects.len());
    for (id, object) in &before.objects {
        let is_xref = object.as_stream().ok().and_then(|stream| stream.dict.get(b"Type").ok()).and_then(|value| value.as_name().ok()) == Some(b"XRef");
        if *id != image_id && !is_xref { assert_eq!(after.objects.get(id), Some(object)); }
    }
    let pixels = after.get_object(image_id).unwrap().as_stream().unwrap().decompressed_content().unwrap();
    assert_eq!(pixels, [0, 0, 255, 255, 255, 255]);
}

#[test]
fn inspection_reports_exact_display_and_pixel_dimensions() {
    let (source, _) = fixture();
    let target = inspect_flat_raster_image(&source, 1).unwrap();
    assert_eq!((target.page_width, target.page_height), (200.0, 100.0));
    assert_eq!((target.pixel_width, target.pixel_height), (2, 1));
    assert!(inspect_flat_raster_image(&source, 0).is_err());
}

#[test]
fn rejects_wrong_page_or_replacement_dimensions() {
    let (source, _) = fixture();
    assert!(replace_flat_raster_image(&source, 0, &[0; 6]).is_err());
    assert!(replace_flat_raster_image(&source, 2, &[0; 6]).is_err());
    assert!(replace_flat_raster_image(&source, 1, &[0; 5]).is_err());
}

#[test]
fn rejects_shared_images_extra_objects_and_trailing_data() {
    let (source, image_id) = fixture();
    let mut shared = Document::load_mem(&source).unwrap();
    let page = shared.get_pages()[&1];
    shared.get_dictionary_mut(page).unwrap().set("Alias", image_id);
    let mut bytes = Vec::new(); shared.save_to(&mut bytes).unwrap();
    assert!(replace_flat_raster_image(&bytes, 1, &[0; 6]).is_err());

    let mut extra = Document::load_mem(&source).unwrap();
    extra.add_object(Object::string_literal("secret"));
    let mut bytes = Vec::new(); extra.save_to(&mut bytes).unwrap();
    assert!(replace_flat_raster_image(&bytes, 1, &[0; 6]).is_err());

    let mut trailing = source; trailing.extend_from_slice(b"SECRET");
    assert!(replace_flat_raster_image(&trailing, 1, &[0; 6]).is_err());
}

#[test]
fn rejects_crop_rotation_masks_and_noncanonical_flate() {
    let (source, image_id) = fixture();
    for key in ["CropBox", "Rotate"] {
        let mut pdf = Document::load_mem(&source).unwrap();
        let page = pdf.get_pages()[&1];
        if key == "CropBox" { pdf.get_dictionary_mut(page).unwrap().set(key, vec![0.into(), 0.into(), 200.into(), 100.into()]); }
        else { pdf.get_dictionary_mut(page).unwrap().set(key, 90); }
        let mut bytes = Vec::new(); pdf.save_to(&mut bytes).unwrap();
        assert!(replace_flat_raster_image(&bytes, 1, &[0; 6]).is_err());
    }
    let mut masked = Document::load_mem(&source).unwrap();
    masked.get_object_mut(image_id).unwrap().as_stream_mut().unwrap().dict.set("SMask", Object::Null);
    let mut bytes = Vec::new(); masked.save_to(&mut bytes).unwrap();
    assert!(replace_flat_raster_image(&bytes, 1, &[0; 6]).is_err());

    let mut tailed = Document::load_mem(&source).unwrap();
    tailed.get_object_mut(image_id).unwrap().as_stream_mut().unwrap().content.extend_from_slice(b"TAIL");
    let mut bytes = Vec::new(); tailed.save_to(&mut bytes).unwrap();
    assert!(replace_flat_raster_image(&bytes, 1, &[0; 6]).is_err());
}

#[test]
fn rejects_catalog_permission_and_signature_channels() {
    let (source, _) = fixture();
    for key in ["Perms", "AcroForm"] {
        let mut pdf = Document::load_mem(&source).unwrap();
        let root = pdf.trailer.get(b"Root").unwrap().as_reference().unwrap();
        pdf.get_dictionary_mut(root).unwrap().set(key, Dictionary::new());
        let mut bytes = Vec::new(); pdf.save_to(&mut bytes).unwrap();
        assert!(replace_flat_raster_image(&bytes, 1, &[0; 6]).is_err());
    }
}

#[test]
fn rejects_dimension_overflow_without_panicking() {
    let (source, image_id) = fixture();
    let mut pdf = Document::load_mem(&source).unwrap();
    let image = pdf.get_object_mut(image_id).unwrap().as_stream_mut().unwrap();
    image.dict.set("Width", i64::from(u32::MAX));
    image.dict.set("Height", i64::from(u32::MAX));
    let mut bytes = Vec::new(); pdf.save_to(&mut bytes).unwrap();
    assert!(replace_flat_raster_image(&bytes, 1, &[0; 6]).is_err());
}

#[test]
fn rejects_fake_or_mutated_xref_streams() {
    let (mut bytes, _) = fixture();
    let position = bytes.windows(b"/W[1 4 2]".len())
        .rposition(|window| window == b"/W[1 4 2]").unwrap();
    bytes[position..position + b"/W[1 4 2]".len()].copy_from_slice(b"/Secret/X");
    assert!(replace_flat_raster_image(&bytes, 1, &[0; 6]).is_err());
}
