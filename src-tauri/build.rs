mod ocr_build;

fn main() {
    if let Err(error) = ocr_build::configure() {
        panic!("OCR build configuration failed: {error}");
    }
    tauri_build::build();
}
