use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use windows::core::PCWSTR;
use windows::Win32::Security::Cryptography::{
    BCryptCloseAlgorithmProvider, BCryptHash, BCryptOpenAlgorithmProvider,
    BCRYPT_ALG_HANDLE, BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS, BCRYPT_SHA256_ALGORITHM,
};
use windows::Win32::Storage::FileSystem::FILE_SHARE_READ;

const BASE_NOTICES_RELATIVE: &str = "resources/third-party-licenses/THIRD-PARTY-NOTICES.txt";
const BASE_NOTICES_LIMIT: u64 = 8 * 1024 * 1024;
const OCR_LICENSE_LIMIT: u64 = 64 * 1024;
const OCR_LICENSE_COUNT: usize = 3;
const OCR_COMBINED_LIMIT: usize = BASE_NOTICES_LIMIT as usize + OCR_LICENSE_COUNT * OCR_LICENSE_LIMIT as usize + 4096;
const REPARSE_POINT: u32 = 0x400;

pub(crate) const OCR_SECTION_HEADER: &str = "\n\n==============================================================================\nOPTIONAL OCR ENGINE LICENSES\n";
pub(crate) const OCR_WARNING: &str = "\n\n==============================================================================\nOPTIONAL OCR ENGINE LICENSES\n\nOptional OCR license texts could not be verified.\n";

const LICENSE_SPECS: [(&str, &str); OCR_LICENSE_COUNT] = [
    ("Tesseract 5.5.3 - Apache-2.0", "Tesseract-Apache-2.0.txt"),
    ("Leptonica 1.87.0 - BSD-2-Clause", "Leptonica-BSD-2-Clause.txt"),
    ("English fast model 4.1.0 - Apache-2.0", "eng-fast-Apache-2.0.txt"),
];

#[derive(Clone, Debug)]
struct LicenseReceipt {
    bytes: u64,
    sha256: [u8; 32],
}

#[derive(Clone, Debug)]
struct OcrNoticeConfig {
    relative: PathBuf,
    licenses: [LicenseReceipt; OCR_LICENSE_COUNT],
}

#[allow(dead_code)]
enum CompiledOcrNotices {
    Disabled,
    Enabled(OcrNoticeConfig),
    Invalid,
}

pub(crate) fn load(resource_dir: &Path) -> Result<String, String> {
    let base_path = resource_dir.join(BASE_NOTICES_RELATIVE);
    let base = read_utf8_bounded(&base_path, BASE_NOTICES_LIMIT)
        .map_err(|error| format!("Could not read bundled notices: {error}"))?;
    match compiled_ocr_notices() {
        CompiledOcrNotices::Disabled => Ok(base),
        CompiledOcrNotices::Invalid => Ok(with_warning(base)),
        CompiledOcrNotices::Enabled(config) => match load_ocr_section(resource_dir, &config) {
            Ok(section) => append_section(base, &section).map_err(|_| "Could not assemble bundled notices.".to_owned()),
            Err(()) => Ok(with_warning(base)),
        },
    }
}

fn load_ocr_section(resource_dir: &Path, config: &OcrNoticeConfig) -> Result<String, ()> {
    validate_relative_identity(&config.relative)?;
    let license_root = resource_dir.join(&config.relative).join("licenses");
    reject_reparse_ancestors(&license_root).map_err(|_| ())?;
    let mut texts = Vec::with_capacity(OCR_LICENSE_COUNT);
    for ((_, name), receipt) in LICENSE_SPECS.iter().zip(config.licenses.iter()) {
        if receipt.bytes == 0 || receipt.bytes > OCR_LICENSE_LIMIT { return Err(()); }
        let path = license_root.join(name);
        let bytes = read_bounded(&path, receipt.bytes).map_err(|_| ())?;
        if bytes.len() as u64 != receipt.bytes || sha256(&bytes).map_err(|_| ())? != receipt.sha256 { return Err(()); }
        texts.push(String::from_utf8(bytes).map_err(|_| ())?);
    }
    format_ocr_section(&texts)
}

fn format_ocr_section(texts: &[String]) -> Result<String, ()> {
    if texts.len() != OCR_LICENSE_COUNT { return Err(()); }
    let content_bytes = texts.iter().try_fold(OCR_SECTION_HEADER.len(), |total, text| total.checked_add(text.len()))
        .and_then(|total| LICENSE_SPECS.iter().try_fold(total, |value, (heading, _)| value.checked_add(heading.len() + 10)))
        .ok_or(())?;
    if content_bytes > OCR_LICENSE_COUNT * OCR_LICENSE_LIMIT as usize + 4096 { return Err(()); }
    let mut section = String::with_capacity(content_bytes);
    section.push_str(OCR_SECTION_HEADER);
    for ((heading, _), text) in LICENSE_SPECS.iter().zip(texts.iter()) {
        section.push_str("\n--- ");
        section.push_str(heading);
        section.push_str(" ---\n");
        section.push_str(text);
        if !text.ends_with('\n') { section.push('\n'); }
    }
    Ok(section)
}

fn append_section(mut base: String, section: &str) -> Result<String, ()> {
    let combined = base.len().checked_add(section.len()).ok_or(())?;
    if combined > OCR_COMBINED_LIMIT { return Err(()); }
    base.reserve(section.len());
    base.push_str(section);
    Ok(base)
}

fn with_warning(base: String) -> String {
    if let Some(length) = base.len().checked_add(OCR_WARNING.len()) {
        if length <= OCR_COMBINED_LIMIT {
            let mut combined = String::with_capacity(length);
            combined.push_str(OCR_WARNING);
            combined.push_str(&base);
            return combined;
        }
    }
    base
}

fn read_utf8_bounded(path: &Path, limit: u64) -> Result<String, String> {
    String::from_utf8(read_bounded(path, limit)?).map_err(|_| "bundled notice text is not UTF-8".into())
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    reject_reparse_ancestors(path)?;
    let mut file = open_locked(path)?;
    let metadata = file.metadata().map_err(|error| format!("could not inspect bundled notice text: {error}"))?;
    if !metadata.is_file() || metadata.len() > limit { return Err("bundled notice text exceeds its size limit".into()); }
    let capacity = usize::try_from(metadata.len()).map_err(|_| "bundled notice text is too large")?;
    let mut bytes = Vec::with_capacity(capacity);
    file.by_ref().take(limit + 1).read_to_end(&mut bytes).map_err(|error| format!("could not read bundled notice text: {error}"))?;
    if bytes.len() != capacity { return Err("bundled notice text changed while it was read".into()); }
    Ok(bytes)
}

fn open_locked(path: &Path) -> Result<File, String> {
    OpenOptions::new().read(true).share_mode(FILE_SHARE_READ.0).open(path)
        .map_err(|error| format!("could not open bundled notice text: {error}"))
}

fn validate_relative_identity(path: &Path) -> Result<(), ()> {
    let value = path.to_str().ok_or(())?.replace('\\', "/");
    let Some(identity) = value.strip_prefix("resources/ocr/") else { return Err(()); };
    if identity.len() != 64 || identity.contains('/') || !identity.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(()); }
    Ok(())
}

#[cfg_attr(not(ocr_opt_in), allow(dead_code))]
fn parse_receipt(bytes: Option<&str>, sha256: Option<&str>) -> Result<LicenseReceipt, ()> {
    let bytes = bytes.ok_or(())?.parse::<u64>().map_err(|_| ())?;
    let value = sha256.ok_or(())?;
    if value.len() != 64 { return Err(()); }
    let mut parsed = [0_u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let text = std::str::from_utf8(chunk).map_err(|_| ())?;
        parsed[index] = u8::from_str_radix(text, 16).map_err(|_| ())?;
    }
    Ok(LicenseReceipt { bytes, sha256: parsed })
}

#[cfg(ocr_opt_in)]
fn compiled_ocr_notices() -> CompiledOcrNotices {
    let parsed = (|| {
        let relative = PathBuf::from(option_env!("PDF_WORKSTATION_OCR_RESOURCE_RELATIVE").ok_or(())?);
        validate_relative_identity(&relative)?;
        let licenses = [
            parse_receipt(option_env!("PDF_WORKSTATION_OCR_LICENSE_TESSERACT_BYTES"), option_env!("PDF_WORKSTATION_OCR_LICENSE_TESSERACT_SHA256"))?,
            parse_receipt(option_env!("PDF_WORKSTATION_OCR_LICENSE_LEPTONICA_BYTES"), option_env!("PDF_WORKSTATION_OCR_LICENSE_LEPTONICA_SHA256"))?,
            parse_receipt(option_env!("PDF_WORKSTATION_OCR_LICENSE_ENG_FAST_BYTES"), option_env!("PDF_WORKSTATION_OCR_LICENSE_ENG_FAST_SHA256"))?,
        ];
        Ok::<_, ()>(OcrNoticeConfig { relative, licenses })
    })();
    match parsed { Ok(config) => CompiledOcrNotices::Enabled(config), Err(()) => CompiledOcrNotices::Invalid }
}

#[cfg(not(ocr_opt_in))]
fn compiled_ocr_notices() -> CompiledOcrNotices { CompiledOcrNotices::Disabled }

fn reject_reparse_ancestors(path: &Path) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match std::fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_attributes() & REPARSE_POINT != 0 => return Err("bundled notice paths may not contain reparse points".into()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not inspect bundled notice path: {error}")),
        }
        current = candidate.parent();
    }
    Ok(())
}

fn sha256(input: &[u8]) -> Result<[u8; 32], String> {
    let mut algorithm = BCRYPT_ALG_HANDLE::default();
    let open = unsafe { BCryptOpenAlgorithmProvider(&mut algorithm, BCRYPT_SHA256_ALGORITHM, PCWSTR::null(), BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0)) };
    if open.0 < 0 { return Err("could not initialize notice verification".into()); }
    let mut output = [0_u8; 32];
    let hashed = unsafe { BCryptHash(algorithm, None, input, &mut output) };
    let closed = unsafe { BCryptCloseAlgorithmProvider(algorithm, 0) };
    if hashed.0 < 0 || closed.0 < 0 { return Err("could not verify bundled notice text".into()); }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(text: &[u8]) -> LicenseReceipt {
        LicenseReceipt { bytes: text.len() as u64, sha256: sha256(text).unwrap() }
    }

    fn config(texts: [&[u8]; OCR_LICENSE_COUNT]) -> OcrNoticeConfig {
        OcrNoticeConfig {
            relative: PathBuf::from("resources").join("ocr").join("a".repeat(64)),
            licenses: texts.map(receipt),
        }
    }

    #[cfg(not(ocr_opt_in))]
    fn write_base(root: &Path, text: &[u8]) {
        let path = root.join(BASE_NOTICES_RELATIVE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn write_licenses(root: &Path, config: &OcrNoticeConfig, texts: [&[u8]; OCR_LICENSE_COUNT]) {
        let folder = root.join(&config.relative).join("licenses");
        std::fs::create_dir_all(&folder).unwrap();
        for ((_, name), text) in LICENSE_SPECS.iter().zip(texts) { std::fs::write(folder.join(name), text).unwrap(); }
    }

    #[cfg(not(ocr_opt_in))]
    #[test]
    fn default_text_is_byte_for_byte_unchanged_even_with_stale_ocr_files() {
        let folder = tempfile::tempdir().unwrap();
        let base = "base notices\r\nexact bytes";
        write_base(folder.path(), base.as_bytes());
        let stale = folder.path().join("resources/ocr/stale/licenses/Tesseract-Apache-2.0.txt");
        std::fs::create_dir_all(stale.parent().unwrap()).unwrap();
        std::fs::write(stale, b"stale").unwrap();
        assert!(matches!(compiled_ocr_notices(), CompiledOcrNotices::Disabled));
        assert_eq!(load(folder.path()).unwrap(), base);
    }

    #[test]
    fn valid_licenses_append_exact_text_in_fixed_order_without_an_engine() {
        let folder = tempfile::tempdir().unwrap();
        let texts: [&[u8]; 3] = [b"tesseract text", b"leptonica text\n", b"model text"];
        let config = config(texts);
        write_licenses(folder.path(), &config, texts);
        assert!(!folder.path().join(&config.relative).join("bin/tesseract.exe").exists());
        let section = load_ocr_section(folder.path(), &config).unwrap();
        let first = section.find("tesseract text").unwrap();
        let second = section.find("leptonica text").unwrap();
        let third = section.find("model text").unwrap();
        assert!(section.starts_with(OCR_SECTION_HEADER));
        assert!(first < second && second < third);
    }

    #[test]
    fn all_optional_failures_preserve_base_and_return_one_stable_warning() {
        let base = "BASE-367".to_owned();
        let texts: [&[u8]; 3] = [b"one", b"two", b"three"];
        for mode in ["missing", "tampered", "wrong-size", "invalid-utf8", "over-cap", "bad-relative"] {
            let folder = tempfile::tempdir().unwrap();
            let mut config = config(texts);
            write_licenses(folder.path(), &config, texts);
            match mode {
                "missing" => std::fs::remove_file(folder.path().join(&config.relative).join("licenses/Tesseract-Apache-2.0.txt")).unwrap(),
                "tampered" => std::fs::write(folder.path().join(&config.relative).join("licenses/Tesseract-Apache-2.0.txt"), b"bad").unwrap(),
                "wrong-size" => config.licenses[0].bytes += 1,
                "invalid-utf8" => {
                    let bytes = [0xff, 0xfe];
                    std::fs::write(folder.path().join(&config.relative).join("licenses/Tesseract-Apache-2.0.txt"), bytes).unwrap();
                    config.licenses[0] = receipt(&bytes);
                }
                "over-cap" => config.licenses[0].bytes = OCR_LICENSE_LIMIT + 1,
                "bad-relative" => config.relative = PathBuf::from("resources/ocr/../escape"),
                _ => unreachable!(),
            }
            let result = match load_ocr_section(folder.path(), &config) {
                Ok(section) => append_section(base.clone(), &section).unwrap(),
                Err(()) => with_warning(base.clone()),
            };
            assert_eq!(result, OCR_WARNING.to_owned() + &base, "{mode}");
            assert!(result.ends_with(&base), "{mode}");
            assert!(!result.contains("tampered"));
        }
    }

    #[test]
    fn bounded_reader_accepts_boundary_and_rejects_one_byte_over() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("notice.txt");
        std::fs::write(&path, b"1234").unwrap();
        assert_eq!(read_utf8_bounded(&path, 4).unwrap(), "1234");
        assert!(read_utf8_bounded(&path, 3).is_err());
    }

    #[test]
    fn compiled_receipts_require_exact_sizes_hashes_and_identity() {
        assert!(parse_receipt(Some("1"), Some(&"A".repeat(64))).is_ok());
        assert!(parse_receipt(Some("bad"), Some(&"A".repeat(64))).is_err());
        assert!(parse_receipt(Some("1"), Some("AA")).is_err());
        assert!(validate_relative_identity(Path::new(&format!("resources/ocr/{}", "f".repeat(64)))).is_ok());
        assert!(validate_relative_identity(Path::new("resources/ocr/not-a-hash")).is_err());
    }

    #[test]
    fn reparse_license_ancestor_is_rejected() {
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let config = config([b"one", b"two", b"three"]);
        let identity = folder.path().join(&config.relative);
        std::fs::create_dir_all(&identity).unwrap();
        let link = identity.join("licenses");
        let output = std::process::Command::new("cmd.exe").args(["/d", "/c", "mklink", "/J"]).arg(&link).arg(outside.path()).output().unwrap();
        assert!(output.status.success(), "mklink failed: stdout={} stderr={}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(load_ocr_section(folder.path(), &config).is_err());
        std::fs::remove_dir(&link).unwrap();
    }

    #[cfg(ocr_opt_in)]
    #[test]
    #[ignore = "requires the verified opt-in OCR build resources"]
    fn retained_opt_in_resources_produce_verified_notice_texts() {
        let profile = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().to_path_buf();
        let CompiledOcrNotices::Enabled(config) = compiled_ocr_notices() else { panic!("compiled OCR notice receipts unavailable") };
        let section = load_ocr_section(&profile, &config).unwrap();
        assert!(section.contains("Tesseract 5.5.3 - Apache-2.0"));
        assert!(section.contains("Leptonica 1.87.0 - BSD-2-Clause"));
        assert!(section.contains("English fast model 4.1.0 - Apache-2.0"));
        println!("verified OCR notice identity {} with {} appended bytes", config.relative.display(), section.len());
    }
}
