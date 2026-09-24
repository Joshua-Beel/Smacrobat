use std::{fs::File, io::{BufReader, Write}, path::Path};

const MAX_EDGE: u32 = 16_384;
const MAX_PIXELS: u64 = 32_000_000;
const MAX_BGRA_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PNG_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RasterDimensions {
    pub width: u32,
    pub height: u32,
    pixels: usize,
    bgra_bytes: usize,
    rgb_bytes: usize,
}

pub fn dimensions(width_points: f32, height_points: f32, dpi: u16) -> Result<RasterDimensions, String> {
    if !matches!(dpi, 72 | 150 | 300) { return Err("Choose 72, 150, or 300 DPI for PNG export.".into()); }
    if !width_points.is_finite() || !height_points.is_finite() || width_points <= 0.0 || height_points <= 0.0 {
        return Err("The page has invalid displayed dimensions.".into());
    }
    let scale = f64::from(dpi) / 72.0;
    let width = (f64::from(width_points) * scale).ceil();
    let height = (f64::from(height_points) * scale).ceil();
    if !width.is_finite() || !height.is_finite() || width < 1.0 || height < 1.0 || width > f64::from(MAX_EDGE) || height > f64::from(MAX_EDGE) {
        return Err("The PNG dimensions exceed the 16,384 pixel edge limit.".into());
    }
    let width = width as u32;
    let height = height as u32;
    let pixels = u64::from(width).checked_mul(u64::from(height)).ok_or("The PNG pixel count is out of range.")?;
    if pixels > MAX_PIXELS { return Err("The PNG exceeds the 32 megapixel limit.".into()); }
    let bgra_bytes = pixels.checked_mul(4).ok_or("The PNG bitmap size is out of range.")?;
    if bgra_bytes > MAX_BGRA_BYTES { return Err("The PNG bitmap exceeds the 128 MiB limit.".into()); }
    let rgb_bytes = pixels.checked_mul(3).ok_or("The PNG pixel data size is out of range.")?;
    Ok(RasterDimensions {
        width,
        height,
        pixels: usize::try_from(pixels).map_err(|_| "The PNG pixel count is out of range.")?,
        bgra_bytes: usize::try_from(bgra_bytes).map_err(|_| "The PNG bitmap size is out of range.")?,
        rgb_bytes: usize::try_from(rgb_bytes).map_err(|_| "The PNG pixel data size is out of range.")?,
    })
}

pub fn pixels_per_meter(dpi: u16) -> Result<u32, String> {
    match dpi {
        72 => Ok(2_835),
        150 => Ok(5_906),
        300 => Ok(11_811),
        _ => Err("Choose 72, 150, or 300 DPI for PNG export.".into()),
    }
}

fn bgra_to_rgb(dimensions: RasterDimensions, bgra: &[u8]) -> Result<Vec<u8>, String> {
    if bgra.len() != dimensions.bgra_bytes { return Err("Unexpected PNG export bitmap layout.".into()); }
    let mut rgb = Vec::with_capacity(dimensions.rgb_bytes);
    for pixel in bgra.chunks_exact(4) {
        let alpha = u16::from(pixel[3]);
        for channel in [pixel[2], pixel[1], pixel[0]] {
            rgb.push(((u16::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8);
        }
    }
    if rgb.len() != dimensions.rgb_bytes { return Err("Unexpected PNG export pixel layout.".into()); }
    Ok(rgb)
}

struct BoundedWriter<W> {
    inner: W,
    written: u64,
    limit: u64,
}

impl<W> BoundedWriter<W> {
    fn new(inner: W, limit: u64) -> Self { Self { inner, written: 0, limit } }
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let next = self.written.checked_add(bytes.len() as u64).ok_or_else(|| std::io::Error::other("PNG output size overflow"))?;
        if next > self.limit { return Err(std::io::Error::other("PNG exceeds the 256 MiB encoded-size limit")); }
        let count = self.inner.write(bytes)?;
        self.written += count as u64;
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> { self.inner.flush() }
}

fn validate_png(path: &Path, expected: RasterDimensions, dpi: u16, rgb: &[u8]) -> Result<(), String> {
    if rgb.len() != expected.rgb_bytes { return Err("PNG validation received an invalid pixel buffer.".into()); }
    let file = File::open(path).map_err(|error| format!("Could not reopen the PNG for validation: {error}"))?;
    let decoder = png::Decoder::new_with_limits(BufReader::new(file), png::Limits { bytes: MAX_BGRA_BYTES as usize });
    let mut reader = decoder.read_info().map_err(|error| format!("Could not validate the PNG header: {error}"))?;
    let info = reader.info();
    if info.width != expected.width || info.height != expected.height || info.color_type != png::ColorType::Rgb || info.bit_depth != png::BitDepth::Eight {
        return Err("The PNG header differs from the export plan.".into());
    }
    let meter = pixels_per_meter(dpi)?;
    let physical = info.pixel_dims.ok_or("The PNG is missing physical-resolution metadata.")?;
    if physical.xppu != meter || physical.yppu != meter || physical.unit != png::Unit::Meter {
        return Err("The PNG physical-resolution metadata differs from the export plan.".into());
    }
    if info.animation_control.is_some() { return Err("The PNG unexpectedly contains animation metadata.".into()); }
    if reader.output_buffer_size() != Some(expected.rgb_bytes) { return Err("The decoded PNG size differs from the export plan.".into()); }
    let mut decoded = vec![0; expected.rgb_bytes];
    let output = reader.next_frame(&mut decoded).map_err(|error| format!("Could not decode the PNG for validation: {error}"))?;
    if output.width != expected.width || output.height != expected.height || output.color_type != png::ColorType::Rgb || output.bit_depth != png::BitDepth::Eight || output.buffer_size() != expected.rgb_bytes || decoded != rgb {
        return Err("The decoded PNG pixels differ from the export plan.".into());
    }
    reader.finish().map_err(|error| format!("Could not finish validating the PNG: {error}"))?;
    Ok(())
}

pub fn write_png(path: &Path, dimensions: RasterDimensions, dpi: u16, bgra: &[u8], canceled: impl Fn() -> bool) -> Result<(), String> {
    if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("png")) { return Err("The output filename must end in .png.".into()); }
    if path.symlink_metadata().is_ok() { return Err("That file already exists. Choose a new filename; PNG export never overwrites an existing file.".into()); }
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).ok_or("Choose an output folder.")?;
    if canceled() { return Err("PNG export was canceled.".into()); }
    let rgb = bgra_to_rgb(dimensions, bgra)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|error| format!("Could not create the PNG output: {error}"))?;
    {
        let bounded = BoundedWriter::new(temporary.as_file_mut(), MAX_PNG_BYTES);
        let mut encoder = png::Encoder::new(bounded, dimensions.width, dimensions.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let meter = pixels_per_meter(dpi)?;
        encoder.set_pixel_dims(Some(png::PixelDimensions { xppu: meter, yppu: meter, unit: png::Unit::Meter }));
        encoder.validate_sequence(true);
        let mut writer = encoder.write_header().map_err(|error| format!("Could not encode the PNG header: {error}"))?;
        writer.write_image_data(&rgb).map_err(|error| format!("Could not encode the PNG pixels: {error}"))?;
        writer.finish().map_err(|error| format!("Could not finish the PNG: {error}"))?;
    }
    let encoded = temporary.as_file().metadata().map_err(|error| format!("Could not inspect the PNG output: {error}"))?.len();
    if encoded > MAX_PNG_BYTES { return Err("The PNG exceeds the 256 MiB encoded-size limit.".into()); }
    temporary.as_file().sync_all().map_err(|error| format!("Could not sync the PNG output: {error}"))?;
    validate_png(temporary.path(), dimensions, dpi, &rgb)?;
    if canceled() { return Err("PNG export was canceled.".into()); }
    temporary.persist_noclobber(path).map_err(|error| format!("Could not publish the PNG without overwriting another file: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpi_ceil_and_resource_bounds_are_exact() {
        assert_eq!(dimensions(612.0, 792.0, 72).unwrap(), RasterDimensions { width: 612, height: 792, pixels: 484_704, bgra_bytes: 1_938_816, rgb_bytes: 1_454_112 });
        assert_eq!((dimensions(612.01, 792.01, 150).unwrap().width, dimensions(612.01, 792.01, 150).unwrap().height), (1_276, 1_651));
        assert_eq!((dimensions(1.0, 1.0, 300).unwrap().width, dimensions(1.0, 1.0, 300).unwrap().height), (5, 5));
        for dpi in [0, 71, 73, 149, 151, 299, 301, 600] { assert!(dimensions(1.0, 1.0, dpi).is_err(), "dpi {dpi}"); }
        assert!(dimensions(f32::NAN, 1.0, 72).is_err());
        assert!(dimensions(16_385.0, 1.0, 72).is_err());
        assert!(dimensions(8_000.0, 4_001.0, 72).is_err());
        assert!(dimensions(8_000.0, 4_000.0, 72).is_ok());
        assert_eq!([pixels_per_meter(72).unwrap(), pixels_per_meter(150).unwrap(), pixels_per_meter(300).unwrap()], [2_835, 5_906, 11_811]);
    }

    #[test]
    fn disk_png_is_rgb8_white_composited_and_never_overwritten() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("page.png");
        let dimensions = dimensions(2.0, 1.0, 72).unwrap();
        let bgra = [0, 0, 255, 128, 255, 0, 0, 255];
        write_png(&path, dimensions, 72, &bgra, || false).unwrap();
        let decoder = png::Decoder::new(BufReader::new(File::open(&path).unwrap()));
        let mut reader = decoder.read_info().unwrap();
        assert_eq!(reader.info().pixel_dims.unwrap().xppu, 2_835);
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let output = reader.next_frame(&mut pixels).unwrap();
        assert_eq!((output.width, output.height, output.color_type, output.bit_depth), (2, 1, png::ColorType::Rgb, png::BitDepth::Eight));
        assert_eq!(pixels, [255, 127, 127, 0, 0, 255]);
        let bytes = std::fs::read(&path).unwrap();
        assert!(write_png(&path, dimensions, 72, &bgra, || false).unwrap_err().contains("never overwrites"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(write_png(&folder.path().join("wrong.jpg"), dimensions, 72, &bgra, || false).is_err());
        assert!(write_png(&folder.path().join("canceled.png"), dimensions, 72, &bgra, || true).is_err());
        assert!(!folder.path().join("canceled.png").exists());
        let probe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/page-image-probe"); std::fs::create_dir_all(&probe).unwrap();
        let artifact = probe.join("rgb-alpha-2x1-72dpi.png"); if !artifact.exists() { std::fs::copy(&path, &artifact).unwrap(); }
        println!("PAGE_IMAGE_PROBE path={} width=2 height=1 dpi=72 pixels=rgb[(255,127,127),(0,0,255)]", artifact.display());
    }

    #[test]
    fn bitmap_layout_and_prepublication_cancellation_fail_without_output() {
        let folder = tempfile::tempdir().unwrap(); let path = folder.path().join("page.png"); let dimensions = dimensions(1.0, 1.0, 72).unwrap();
        assert!(write_png(&path, dimensions, 72, &[0, 0, 0], || false).is_err()); assert!(!path.exists());
        let checks = std::cell::Cell::new(0); let canceled = || { let count = checks.get(); checks.set(count + 1); count >= 1 };
        assert!(write_png(&path, dimensions, 72, &[0, 0, 0, 255], canceled).unwrap_err().contains("canceled")); assert!(!path.exists());
        let mut bounded = BoundedWriter::new(Vec::new(), 4); assert_eq!(bounded.write(&[1, 2, 3, 4]).unwrap(), 4); assert!(bounded.write(&[5]).is_err());
        let corrupt = folder.path().join("corrupt.tmp"); std::fs::write(&corrupt, b"not a PNG").unwrap();
        assert!(validate_png(&corrupt, dimensions, 72, &[0, 0, 0]).is_err());

        let raced = folder.path().join("raced.png"); let checks = std::cell::Cell::new(0);
        let race = || { let count = checks.get(); checks.set(count + 1); if count == 1 { std::fs::write(&raced, b"racer owns this path").unwrap(); } false };
        assert!(write_png(&raced, dimensions, 72, &[0, 0, 0, 255], race).is_err());
        assert_eq!(std::fs::read(&raced).unwrap(), b"racer owns this path");
    }
}
