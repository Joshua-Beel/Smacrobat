use std::path::{Path, PathBuf};

const DEVICE_NAMES: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];

fn reject(reason: &str) -> String { format!("This path cannot be opened: {reason}.") }

fn reserved_device_component(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_uppercase();
    if DEVICE_NAMES.contains(&stem.as_str()) { return true; }
    let numbered = |prefix: &str| stem.strip_prefix(prefix).is_some_and(|rest| matches!(rest.chars().collect::<Vec<_>>().as_slice(), [digit] if matches!(digit, '1'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}')));
    numbered("COM") || numbered("LPT")
}

pub(crate) fn is_drive_letter_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

/// String-level classification. Accepts only an absolute `X:\...` path or a verbatim `\\?\X:\...` path.
/// Rejects relative paths, UNC (`\\server\share`, `\\?\UNC\`), device and namespace forms (`\\.\`, other `\\?\`, pipes),
/// reserved device names in any component, and alternate data streams. Pure; touches no filesystem.
pub(crate) fn classify_open_path(path: &Path) -> Result<(), String> {
    let text = path.to_string_lossy().replace('/', "\\");
    if text.is_empty() || text.contains('\0') { return Err(reject("the path is empty or contains a null character")); }
    let rest = if let Some(verbatim) = text.strip_prefix("\\\\?\\") {
        if verbatim.len() >= 4 && verbatim[..4].eq_ignore_ascii_case("UNC\\") { return Err(reject("network (UNC) paths are not supported")); }
        if !is_drive_letter_path(verbatim) { return Err(reject("device and namespace paths are not supported")); }
        verbatim
    } else if text.starts_with("\\\\") {
        return Err(reject(if text.starts_with("\\\\.\\") { "device and pipe paths are not supported" } else { "network (UNC) paths are not supported" }));
    } else if is_drive_letter_path(&text) { text.as_str() } else {
        return Err(reject("the path must be absolute and start with a drive letter"));
    };
    let tail = &rest[3..];
    if tail.contains(':') { return Err(reject("alternate data streams are not supported")); }
    if tail.split('\\').any(reserved_device_component) { return Err(reject("device names such as CON, NUL and COM1 are not supported")); }
    Ok(())
}

/// Full gate: classify the string, canonicalise, classify again, then require a regular file.
/// A drive letter that canonicalises to a UNC path is a mapped network drive and is allowed; a UNC string is not.
pub(crate) fn validate_open_path(path: &Path) -> Result<(), String> {
    classify_open_path(path)?;
    let canonical = std::fs::canonicalize(path).map_err(|error| format!("This file could not be found or read: {error}."))?;
    let text = canonical.to_string_lossy().into_owned();
    let mapped = text.len() >= 8 && text[..8].eq_ignore_ascii_case("\\\\?\\UNC\\");
    if !mapped { classify_open_path(&canonical)?; }
    else if text.get(8..).is_some_and(|unc| unc.split('\\').skip(2).any(reserved_device_component) || unc.contains(':')) { return Err(reject("device names and streams are not supported")); }
    let metadata = std::fs::metadata(&canonical).map_err(|error| format!("This file could not be read: {error}."))?;
    if !metadata.is_file() { return Err(reject("it is not a regular file (folders, devices and pipes cannot be opened)")); }
    Ok(())
}

pub(crate) async fn gate_open_path(path: PathBuf) -> Result<PathBuf, String> {
    classify_open_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || validate_open_path(&path).map(|()| path)).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unc_device_namespace_and_relative_forms() {
        for text in [
            r"\\server\share\a.pdf", "//server/share/a.pdf", r"\\?\UNC\server\share\a.pdf", r"\\?\unc\server\share\a.pdf",
            r"\\.\pipe\name", r"\\.\PhysicalDrive0", r"\\.\C:\a.pdf", r"\\?\GLOBALROOT\Device\X", r"\\?\pipe\x", r"\\?\Volume{1234}\a.pdf",
            "CON", "nul", "COM1", r"C:\dir\NUL", r"C:\dir\nul.pdf", r"C:\dir\COM9.txt", r"C:\dir\LPT3", r"C:\CON\a.pdf", r"C:\dir\CONOUT$", r"C:\dir\com1 .pdf",
            r"a.pdf", r"dir\a.pdf", r"\a.pdf", r"C:a.pdf", r"C:", "", "C:\\a\0.pdf", r"C:\a.pdf:stream", r"C:\a.pdf::$DATA",
        ] {
            assert!(classify_open_path(Path::new(text)).is_err(), "should reject {text:?}");
        }
    }

    #[test]
    fn accepts_local_drive_and_verbatim_disk_forms() {
        for text in [r"C:\a.pdf", r"c:\Users\me\My Docs\a.pdf", "C:/Users/me/a.pdf", r"G:\My Drive\a.pdf", r"\\?\C:\Users\me\a.pdf", r"C:\console.pdf", r"C:\com10.pdf", r"C:\comma\a.pdf", r"C:\nullable.pdf"] {
            assert!(classify_open_path(Path::new(text)).is_ok(), "should accept {text:?}");
        }
    }

    #[test]
    fn requires_an_existing_regular_file() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("a.pdf"); std::fs::write(&file, b"%PDF-1.4").unwrap();
        validate_open_path(&file).unwrap();
        let error = validate_open_path(folder.path()).unwrap_err();
        assert!(error.contains("not a regular file"), "{error}");
        assert!(validate_open_path(&folder.path().join("missing.pdf")).unwrap_err().contains("could not be found"));
        assert!(validate_open_path(Path::new(r"\\localhost\c$\Windows\win.ini")).unwrap_err().contains("UNC"));
    }

    #[test]
    fn service_open_entries_used_by_reopen_document_are_gated() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let service = crate::service::PdfService::start(root.join("resources/pdfium/bin/pdfium.dll"));
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("ok.pdf"); std::fs::copy(root.join("resources/welcome.pdf"), &file).unwrap();
        for bad in [PathBuf::from(r"\\127.0.0.1\share\a.pdf"), PathBuf::from(r"\\.\pipe\x"), PathBuf::from("NUL"), folder.path().to_path_buf(), folder.path().join("missing.pdf")] {
            assert!(tauri::async_runtime::block_on(service.begin_open(bad.clone())).is_err(), "begin_open must reject {bad:?}");
            assert!(tauri::async_runtime::block_on(service.open(bad.clone())).is_err(), "open must reject {bad:?}");
        }
        assert!(matches!(tauri::async_runtime::block_on(service.begin_open(file)).unwrap(), crate::service::OpenResult::Opened { .. }));
    }

    #[test]
    fn unlock_rejects_passwords_over_one_kib_before_any_read() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let service = crate::service::PdfService::start(root.join("resources/pdfium/bin/pdfium.dll"));
        let error = tauri::async_runtime::block_on(service.unlock(1, "a".repeat(1025))).err().unwrap();
        assert!(error.contains("1 KiB"), "{error}");
        let multibyte = "\u{e9}".repeat(513);
        assert!(tauri::async_runtime::block_on(service.unlock(1, multibyte)).err().unwrap().contains("1 KiB"));
        let at_limit = tauri::async_runtime::block_on(service.unlock(1, "a".repeat(1024))).err().unwrap();
        assert!(at_limit.contains("expired"), "{at_limit}");
    }

    #[test]
    fn gate_rejects_before_touching_the_filesystem() {
        let error = tauri::async_runtime::block_on(gate_open_path(PathBuf::from(r"\\127.0.0.1\share\a.pdf"))).unwrap_err();
        assert!(error.contains("UNC"), "{error}");
        let folder = tempfile::tempdir().unwrap();
        assert!(tauri::async_runtime::block_on(gate_open_path(folder.path().to_path_buf())).is_err());
    }
}
