#[path = "../src/sanitization.rs"]
mod sanitization;

use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, Stream,
};
use sanitization::verify_clean_raster_pdf;

fn raster_pdf(extra: impl FnOnce(&mut Document, lopdf::ObjectId)) -> Vec<u8> {
    let mut document = Document::with_version("1.7");
    let pages = document.new_object_id();
    let mut image = Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 2, "Height" => 1,
            "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        },
        vec![255, 255, 255, 0, 0, 0],
    );
    image.compress().unwrap();
    let image_id = document.add_object(image);
    let content = Content {
        operations: vec![
            Operation::new("q", vec![]),
            Operation::new(
                "cm",
                vec![
                    Object::Real(612.0),
                    0.into(),
                    0.into(),
                    Object::Real(792.0),
                    0.into(),
                    0.into(),
                ],
            ),
            Operation::new("Do", vec![Object::Name(b"Image".to_vec())]),
            Operation::new("Q", vec![]),
        ],
    }
    .encode()
    .unwrap();
    let content_id = document.add_object(Stream::new(dictionary! {}, content));
    let page = document.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages,
        "MediaBox" => vec![0.into(), 0.into(), Object::Real(612.0), Object::Real(792.0)],
        "Resources" => dictionary! { "XObject" => dictionary! { "Image" => image_id } },
        "Contents" => content_id,
    });
    document.objects.insert(
        pages,
        dictionary! { "Type" => "Pages", "Count" => 1, "Kids" => vec![page.into()] }.into(),
    );
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    document.trailer.set("Root", catalog);
    extra(&mut document, page);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

fn oversized_aggregate_pdf() -> Vec<u8> {
    let mut document = Document::with_version("1.7");
    let pages = document.new_object_id();
    let mut kids = Vec::new();
    for _ in 0..2 {
        let mut image = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 4_000_001, "Height" => 4,
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
            },
            vec![0, 0, 0],
        );
        image.compress().unwrap();
        let image_id = document.add_object(image);
        let content = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        Object::Real(612.0),
                        0.into(),
                        0.into(),
                        Object::Real(792.0),
                        0.into(),
                        0.into(),
                    ],
                ),
                Operation::new("Do", vec![Object::Name(b"Image".to_vec())]),
                Operation::new("Q", vec![]),
            ],
        }
        .encode()
        .unwrap();
        let content_id = document.add_object(Stream::new(dictionary! {}, content));
        let page = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), Object::Real(612.0), Object::Real(792.0)],
            "Resources" => dictionary! { "XObject" => dictionary! { "Image" => image_id } },
            "Contents" => content_id,
        });
        kids.push(page.into());
    }
    document.objects.insert(
        pages,
        dictionary! { "Type" => "Pages", "Count" => 2, "Kids" => kids }.into(),
    );
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
fn accepts_only_complete_bounded_raster_pages() {
    let result = verify_clean_raster_pdf(&raster_pdf(|_, _| {}), 1).unwrap();
    assert_eq!(result.pages, 1);
    assert_eq!(result.total_pixels, 2);
    assert!(verify_clean_raster_pdf(&raster_pdf(|_, _| {}), 2)
        .unwrap_err()
        .contains("expected 2"));
}

#[test]
fn rejects_metadata_attachments_actions_forms_and_annotations() {
    let mutations: [(&str, fn(&mut Document, lopdf::ObjectId)); 5] = [
        ("metadata", |document: &mut Document, _: lopdf::ObjectId| {
            let info = document.add_object(dictionary! { "Title" => "secret" });
            document.trailer.set("Info", info);
        }),
        (
            "attachment",
            |document: &mut Document, _: lopdf::ObjectId| {
                let file = document.add_object(Stream::new(
                    dictionary! { "Type" => "EmbeddedFile" },
                    b"secret".to_vec(),
                ));
                let alias = document.new_object_id();
                document.objects.insert(alias, file.into());
            },
        ),
        (
            "annotation",
            |document: &mut Document, page: lopdf::ObjectId| {
                document
                    .get_object_mut(page)
                    .unwrap()
                    .as_dict_mut()
                    .unwrap()
                    .set("Annots", Vec::<Object>::new());
            },
        ),
        ("action", |document: &mut Document, _: lopdf::ObjectId| {
            let root = document
                .trailer
                .get(b"Root")
                .unwrap()
                .as_reference()
                .unwrap();
            document
                .get_object_mut(root)
                .unwrap()
                .as_dict_mut()
                .unwrap()
                .set(
                    "OpenAction",
                    dictionary! { "S" => "JavaScript", "JS" => "secret" },
                );
        }),
        ("form", |document: &mut Document, _: lopdf::ObjectId| {
            let root = document
                .trailer
                .get(b"Root")
                .unwrap()
                .as_reference()
                .unwrap();
            document
                .get_object_mut(root)
                .unwrap()
                .as_dict_mut()
                .unwrap()
                .set("AcroForm", dictionary! { "Fields" => Vec::<Object>::new() });
        }),
    ];
    for (name, mutate) in mutations {
        assert!(
            verify_clean_raster_pdf(&raster_pdf(mutate), 1).is_err(),
            "{name} must be refused"
        );
    }
}

#[test]
fn rejects_text_operators_fonts_extra_images_and_hidden_objects() {
    let text = raster_pdf(|document, page| {
        let content_id = document
            .get_object(page)
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Contents")
            .unwrap()
            .as_reference()
            .unwrap();
        document.objects.insert(
            content_id,
            Stream::new(dictionary! {}, b"BT (secret) Tj ET".to_vec()).into(),
        );
    });
    assert!(verify_clean_raster_pdf(&text, 1)
        .unwrap_err()
        .contains("paint sequence"));

    let font = raster_pdf(|document, page| {
        let page = document
            .get_object_mut(page)
            .unwrap()
            .as_dict_mut()
            .unwrap();
        page.get_mut(b"Resources")
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Font", dictionary! {});
    });
    assert!(verify_clean_raster_pdf(&font, 1)
        .unwrap_err()
        .contains("/Font"));

    let hidden = raster_pdf(|document, _| {
        let id = document.new_object_id();
        document
            .objects
            .insert(id, Object::string_literal("secret source text"));
    });
    assert!(verify_clean_raster_pdf(&hidden, 1)
        .unwrap_err()
        .contains("extra or unreachable"));

    let extra_image = raster_pdf(|document, page| {
        let extra = document.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image" },
            vec![],
        ));
        let page = document
            .get_object_mut(page)
            .unwrap()
            .as_dict_mut()
            .unwrap();
        page.get_mut(b"Resources")
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .get_mut(b"XObject")
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Other", extra);
    });
    assert!(verify_clean_raster_pdf(&extra_image, 1)
        .unwrap_err()
        .contains("exactly one image"));
}

#[test]
fn rejects_malformed_or_mismatched_image_payloads() {
    let bad = raster_pdf(|document, page| {
        let page = document.get_object(page).unwrap().as_dict().unwrap();
        let image_id = page
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"XObject")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Image")
            .unwrap()
            .as_reference()
            .unwrap();
        document
            .get_object_mut(image_id)
            .unwrap()
            .as_stream_mut()
            .unwrap()
            .dict
            .set("Width", 3);
    });
    assert!(verify_clean_raster_pdf(&bad, 1)
        .unwrap_err()
        .contains("byte count"));
    assert!(verify_clean_raster_pdf(b"not a pdf", 1)
        .unwrap_err()
        .contains("invalid"));
}

#[test]
fn rejects_bytes_outside_canonical_streams_and_aggregate_work_before_decode() {
    let mut after_eof = raster_pdf(|_, _| {});
    after_eof.extend_from_slice(b"SECRET");
    assert!(verify_clean_raster_pdf(&after_eof, 1)
        .unwrap_err()
        .contains("canonical output"));

    let trailing_flate = raster_pdf(|document, page| {
        let image_id = document
            .get_object(page)
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"XObject")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Image")
            .unwrap()
            .as_reference()
            .unwrap();
        document
            .get_object_mut(image_id)
            .unwrap()
            .as_stream_mut()
            .unwrap()
            .content
            .extend_from_slice(b"SECRET");
    });
    assert!(verify_clean_raster_pdf(&trailing_flate, 1).is_err());

    assert!(verify_clean_raster_pdf(&oversized_aggregate_pdf(), 2)
        .unwrap_err()
        .contains("aggregate sanitization limit"));
}
