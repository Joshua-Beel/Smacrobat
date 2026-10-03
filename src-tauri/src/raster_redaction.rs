use crate::sanitization::{build_clean_raster_pdf, CleanRasterPage};
use serde::Deserialize;

const MAX_PAGES: usize = 4_096;
const MAX_PAGE_PIXELS: u64 = 32_000_000;
const MAX_TOTAL_PIXELS: u64 = 32_000_000;
const MAX_RECTS: usize = 4_096;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterRedactionRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// `rgb` is a complete white-flattened rendering of the displayed page after
/// crop and cardinal rotation. Rectangle coordinates use that displayed page's
/// top-left point origin and must lie wholly inside its point dimensions.
#[derive(Debug)]
pub struct RasterRedactionPage {
    pub page_width: f32,
    pub page_height: f32,
    pub image_width: u32,
    pub image_height: u32,
    pub rgb: Vec<u8>,
    pub rectangles: Vec<RasterRedactionRect>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PreparedRasterRedaction {
    pub bytes: Vec<u8>,
    pub pages: usize,
    pub rectangles: usize,
    pub covered_pixels: u64,
}

#[derive(Clone, Copy)]
struct PixelRect {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

pub fn redact_raster_pages(
    mut pages: Vec<RasterRedactionPage>,
) -> Result<PreparedRasterRedaction, String> {
    if pages.is_empty() || pages.len() > MAX_PAGES {
        return Err("Raster redaction requires 1 to 4,096 displayed pages.".into());
    }

    let mut total_pixels = 0u64;
    let mut total_rectangles = 0usize;
    let mut mapped = Vec::with_capacity(pages.len());
    for (index, page) in pages.iter().enumerate() {
        let label = format!("page {}", index + 1);
        validate_page(page, &label)?;
        let pixels = u64::from(page.image_width) * u64::from(page.image_height);
        total_pixels = total_pixels
            .checked_add(pixels)
            .ok_or("The raster redaction pixel count is out of range.")?;
        if total_pixels > MAX_TOTAL_PIXELS {
            return Err("Raster redaction exceeds the 32 megapixel aggregate limit.".into());
        }
        total_rectangles = total_rectangles
            .checked_add(page.rectangles.len())
            .ok_or("The redaction rectangle count is out of range.")?;
        if total_rectangles > MAX_RECTS {
            return Err("Raster redaction exceeds the 4,096 rectangle limit.".into());
        }
        let mut page_rects = Vec::with_capacity(page.rectangles.len());
        for rect in &page.rectangles {
            page_rects.push(map_rect(page, *rect, &label)?);
        }
        mapped.push(page_rects);
    }
    if total_rectangles == 0 {
        return Err("Raster redaction requires at least one rectangle.".into());
    }

    let mut covered_pixels = 0u64;
    for (page, page_rects) in pages.iter_mut().zip(mapped) {
        let pixels = usize::try_from(u64::from(page.image_width) * u64::from(page.image_height))
            .map_err(|_| "The page pixel count is out of range.")?;
        let mut covered = vec![0u8; pixels.saturating_add(7) / 8];
        for rect in page_rects {
            for y in rect.top..rect.bottom {
                let row = usize::try_from(y).unwrap() * usize::try_from(page.image_width).unwrap();
                for x in rect.left..rect.right {
                    let pixel = row + usize::try_from(x).unwrap();
                    let marker = &mut covered[pixel / 8];
                    let mask = 1u8 << (pixel % 8);
                    if *marker & mask == 0 {
                        *marker |= mask;
                        covered_pixels += 1;
                    }
                    let rgb = pixel * 3;
                    page.rgb[rgb..rgb + 3].fill(0);
                }
            }
        }
    }

    let page_count = pages.len();
    let clean_pages = pages
        .into_iter()
        .map(|page| CleanRasterPage {
            page_width: page.page_width,
            page_height: page.page_height,
            image_width: page.image_width,
            image_height: page.image_height,
            rgb: page.rgb,
        })
        .collect();
    let bytes = build_clean_raster_pdf(clean_pages)?;
    Ok(PreparedRasterRedaction {
        bytes,
        pages: page_count,
        rectangles: total_rectangles,
        covered_pixels,
    })
}

pub fn validate_displayed_rectangles(
    page_width: f32,
    page_height: f32,
    image_width: u32,
    image_height: u32,
    rectangles: &[RasterRedactionRect],
) -> Result<(), String> {
    if rectangles.is_empty() || rectangles.len() > 256 {
        return Err("Choose 1 to 256 redaction rectangles on one page.".into());
    }
    let page = RasterRedactionPage {
        page_width,
        page_height,
        image_width,
        image_height,
        rgb: Vec::new(),
        rectangles: Vec::new(),
    };
    for rect in rectangles {
        map_rect(&page, *rect, "The selected page")?;
    }
    Ok(())
}

fn validate_page(page: &RasterRedactionPage, label: &str) -> Result<(), String> {
    if !page.page_width.is_finite()
        || !page.page_height.is_finite()
        || page.page_width <= 0.0
        || page.page_height <= 0.0
    {
        return Err(format!("{label} has invalid displayed-page dimensions."));
    }
    let pixels = u64::from(page.image_width)
        .checked_mul(u64::from(page.image_height))
        .ok_or_else(|| format!("{label}'s image dimensions are out of range."))?;
    if pixels == 0 || pixels > MAX_PAGE_PIXELS {
        return Err(format!(
            "{label}'s image exceeds the 32 megapixel page limit."
        ));
    }
    let expected = pixels
        .checked_mul(3)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("{label}'s RGB byte count is out of range."))?;
    if page.rgb.len() != expected {
        return Err(format!(
            "{label}'s RGB byte count does not match its dimensions."
        ));
    }
    Ok(())
}

fn map_rect(
    page: &RasterRedactionPage,
    rect: RasterRedactionRect,
    label: &str,
) -> Result<PixelRect, String> {
    let right = rect.x + rect.width;
    let bottom = rect.y + rect.height;
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.x < 0.0
        || rect.y < 0.0
        || rect.width <= 0.0
        || rect.height <= 0.0
        || !right.is_finite()
        || !bottom.is_finite()
        || right > page.page_width
        || bottom > page.page_height
    {
        return Err(format!(
            "{label} has an invalid or out-of-bounds redaction rectangle."
        ));
    }
    let scale_x = page.image_width as f64 / f64::from(page.page_width);
    let scale_y = page.image_height as f64 / f64::from(page.page_height);
    let left = (f64::from(rect.x) * scale_x).floor().max(0.0) as u32;
    let top = (f64::from(rect.y) * scale_y).floor().max(0.0) as u32;
    let right = (f64::from(right) * scale_x)
        .ceil()
        .min(f64::from(page.image_width)) as u32;
    let bottom = (f64::from(bottom) * scale_y)
        .ceil()
        .min(f64::from(page.image_height)) as u32;
    if left >= right || top >= bottom {
        return Err(format!("{label}'s redaction rectangle maps to no pixels."));
    }
    Ok(PixelRect {
        left,
        top,
        right,
        bottom,
    })
}
