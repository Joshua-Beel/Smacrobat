## 0.2.8 (draft candidate)

- Adds the current reading and workspace work: embedded-text selection, visible match geometry, bounded Page text and bookmarks, document properties, password retry/cancel flows, native printing, and saved theme, view, recent-file, and starred-file preferences. Controlled signed-installed-app checks cover the packaged sample, real clipboard, search geometry, password lifecycle, three launches of persistence, print-dialog cancel/reopen, and one-page Microsoft Print to PDF output. They do not establish arbitrary-PDF compatibility, physical pointer selection, physical paper output, non-Microsoft printer behavior, or native-window visual fidelity.
- Adds the current page tools: crop and reset crop, fixed-size split, Combine Files, Insert Pages, Replace Pages, one-image PDF creation, and current-page PNG/JPEG export. These create new outputs and retain the documented source tabs and metadata; crop hides content rather than redacting it. Source, mocked-browser, and structural checks pass. The latest installed expanded-page-tools rerun still needs to complete after the native-picker deferral fix, so the 0.2.8 installer and its real Windows save/folder dialogs are not yet verified.
- Adds app-owned sticky notes, area highlights, selected-text highlights, and a strict form-filling subset for flat single-line text, checkboxes, same-page radio groups, and single-select choices. Unsupported forms are refused as a whole. Replies, author identity, foreign-annotation interchange, editable combos, multi-select lists, form preparation, Fill & Sign, handwritten or certificate signatures, and broader cross-viewer behavior are not provided.
- Hardens update recovery. Download and installer handoff use separate signed-updater phases with an exact bounded native marker that is atomically written, flushed, replaced, and read back before proceeding. Failed downloads must release their updater resource before a fresh retry; a reopened installer-handoff marker blocks a second concurrent installer and directs recovery through waiting or the latest signed installer. Focused frontend, native, workflow, publisher, production-build, and adversarial gates pass. The public 0.2.0-to-0.2.8 in-app update, restart/relaunch, and controlled missing-executable repair still require the signed stable 0.2.8 release and the read-only hosted verifier.
- Keeps the canonical updater endpoint and existing updater public key so installed 0.2.0 clients can verify the new update. Release automation remains fail-closed for missing Azure or updater signing credentials, binds one stable tag to the exact npm, Cargo, lockfile, Tauri, checkout, and release source version, and can create only a draft containing the installer, its detached updater signature, and `latest.json`.

The default release does not bundle OCR. The separately verified opt-in current-page English OCR artifact is not this release and does not establish general accuracy; PDF Workstation still does not create searchable/document OCR. This release also makes no redaction, PDF-signing, certificate-signing, or signature-validation claim. Text or image editing, original-file overwrite, and save-back to the source remain unavailable. The 0.2.8 installer must still be built, publisher-signed, checked, installed, and exercised before the draft can be published. The immutable `v0.2.7` workflow failed during package-lock parsing before tests, signing, build, upload, or draft creation, so no 0.2.7 installer or release artifact exists.

## 0.2.6 (draft candidate)

- Adds on-page embedded-text selection and literal match highlights where supported geometry is available, plus Page text fallbacks for unsupported or capped pages.
- Adds fixed-size splitting, current-page crop, Combine Files, Insert Pages, and Replace Pages. Structural copy operations use current edits, preserve the stated source metadata, and create a new output without changing either source tab.
- Adds source-availability archives for five exact MPL-2.0 crates and current dependency notices to the bundled resources.

Native desktop verification of selection/clipboard behavior, split and structural-copy save dialogs, crop interaction, printing, installation, and upgrade/relaunch remains open.

## 0.2.5 (tagged; no draft artifacts)

- The release workflow stopped during npm tests because the clean runner had not fetched the locked Cargo registry required by the offline dependency-notice checks.
- No native test, signing, installer, asset upload, or GitHub draft-release step ran for this tag.

## 0.2.4

- Verifies the actual application extracted from the signed installer, rather than Tauri's restored unsigned build file.
- Includes embedded-text search, case matching, selectable excerpts, and links to matching pages.

## 0.2.3 (unreleased)

- Runs installer signature verification directly in PowerShell 7 on GitHub Actions.
- Includes embedded-text search and the Windows signing argument fix described below.

## 0.2.2 (unreleased)

- Find embedded PDF text with Ctrl+F, optional case matching, selectable excerpts, and links to matching pages.
- Stop a search while reading; results follow the current page order after edits.
- Fixed Windows signing command arguments containing spaces.

Search shows one excerpt per matching page, up to 500 pages. On-page selection, match highlighting, and OCR remain in development.

## 0.2.1 (unreleased)

- Windows publisher signing through Joshua Beel's Azure signing profile.
- Release builds verify timestamped signatures on the application and installer.
- Keeps the existing updater key so version 0.2.0 can accept this update.

## 0.2.0

- Windows installer with the PDF engine included.
- Menu > Check for updates downloads verified updates from GitHub releases.
- Update installation waits until every edited PDF has been saved or its edits discarded.
- PDF viewer and Organize Pages: rotate, move, delete, extract, undo/redo, and save a new copy.

Text editing, OCR, search, printing, and signatures remain in development.
