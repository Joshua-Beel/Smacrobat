# OCR feasibility

## Status

OCR is disabled. Nothing from this research is bundled, installed, or shipped, and there is no OCR command, user interface, or document mutation path.

## Internal runner foundation

The native source now contains an internal runner foundation only. It has no application command, bridge, interface, bundled resource, installer wiring, or release behavior. OCR therefore remains disabled and unshipped.

The runner requires a trusted internal engine identity and a fixed English-model identity, with no IPC or user engine path or hash, shell, or `PATH` lookup. One global admission gate refuses a second job immediately and limits process-plus-job committed memory to 256 MiB. It accepts only owned P6 input up to 16,777,216 bytes and a 16,384-pixel edge, uses fixed English-fast/150-DPI arguments, strict UTF-8 decoding, 1 MiB standard output, 64 KiB standard error, and a 30-second limit. Successful standard error fails closed. Each child is created suspended, assigned to its kill-on-close job, cancellation-checked, then resumed; timeout, cancellation, or output-cap work kills and reaps the child tree. These bounds do not cover RSS, application or PDFium memory, or source-raster allocation.

Focused native checks passed 14 tests with 0 failures and 3 ignored in 3.64 seconds; retained checks passed 3 of 3 in 0.87 seconds. They included a deterministic 16,766,993-byte owned P6 result at 88,735,744 bytes peak job commitment. The full native gate passed 181 tests with 0 failures and 4 ignored in 420.00 seconds. A successful standalone debug/no-bundle rerun transformed 1,936 frontend modules in 2.96 seconds and native code in 22.78 seconds; its 30,217,216-byte executable SHA-256 is `E69DB97531D2A5A6A74BA8E8DB98ACAA04715D11F553EFC7920FDB148B103085`. The embedded Brotli JavaScript and CSS bytes exactly matched current assets; embedded transformed HTML referenced those assets. This is runner evidence only; it does not establish general recognition accuracy, end-to-end page-to-text time, desktop interaction, installed-app behavior, or a reachable OCR runtime.

## Windows OCR API

The current NSIS distribution has no package identity. Microsoft lists `Windows.Media.Ocr` among the WinRT APIs that require package identity, and says those APIs are supported only for desktop apps packaged with MSIX. See [WinRT APIs not supported in desktop apps](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/winrt-api-desktop-app-support) and the [Windows.Media.Ocr namespace](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr?view=winrt-26100). An isolated unpackaged experiment does not change that support boundary. No MSIX packaging change is proposed.

## Local prototype

An isolated research build produced a static Tesseract 5.5.3 executable with Leptonica 1.87.0 and pinned English 4.1.0 `fast` and `best` model files. The executable was 4,390,400 bytes. The fast model was 4,113,088 bytes; the best model was 15,400,601 bytes.

Each model/case combination ran three independent child processes with fixed arguments, P6 input on standard input, and a 150 DPI setting. The harness bounded input at 16 MiB, standard output at 1 MiB, standard error at 64 KiB, and each child at 15 seconds. Its timeout and output-cap controls reaped their child processes; the input-cap control rejected before spawn. These are research harness controls, not application behavior.

The table records the observed range across three runs. Time is OCR child-process time only; it excludes page rasterization and application work. Peak is the observed child-process working set.

| Fixture | Fast: time / peak / normalized exact passes | Best: time / peak / normalized exact passes |
| --- | --- | --- |
| Blank | 55–70 ms / 16.5 MiB / 3 of 3 | 99–105 ms / 48.1 MiB / 3 of 3 |
| Synthetic 5×7 normal text | 145–213 ms / 16.5 MiB / 0 of 3 | 164–176 ms / 48.1 MiB / 0 of 3 |
| Synthetic 5×7 small text | 102–162 ms / 16.5 MiB / 0 of 3 | 118–135 ms / 48.1 MiB / 0 of 3 |
| Synthetic 5×7, 2° rotation | 85–146 ms / 16.5 MiB / 0 of 3 | 143–197 ms / 48.1 MiB / 0 of 3 |
| Locally rendered Arial 28-point text | 100–116 ms / 16.5 MiB / 3 of 3 | 165–195 ms / 48.1 MiB / 3 of 3 |
| Repository synthetic raster page | 273–287 ms / 39.8 MiB / 0 of 3 | 447–462 ms / 51.2 MiB / 0 of 3 |

The exact-pass field is a normalized comparison to the owned fixture's expected text. It is not a general accuracy estimate. The bitmap fixtures are synthetic smoke inputs, and the Arial fixture is locally rendered text; none establishes results on real scanned pages. Both models recognized the synthetic page footer but also emitted line-pattern noise. This narrow suite makes fast a smaller, lower-observed-cost prototype candidate with the same observed exact-pass set; it does not select a product engine or model.

## Opt-in source-build recipe

This development recipe does not enable OCR in the app and does not add an application, installer, or release resource. It requires x64 Windows, PowerShell 7 or later, the Visual Studio C++ build tools, and Internet access to download the pinned inputs.

From the repository root, run:

```powershell
pwsh -NoProfile -File scripts/setup-ocr.ps1
```

The default output is `target/ocr/5.5.3-eng-fast-4.1.0`. To use a fresh named output root or fewer build jobs, run:

```powershell
pwsh -NoProfile -File scripts/setup-ocr.ps1 -OutputRoot target/ocr-my-run -Jobs 1
```

`-OutputRoot` must resolve to a new directory under this repository's `target`; `-Jobs` accepts 1 through 4. The recipe refuses an existing output root or a path outside `target`, does not clean a failed root, and does not install tools globally. It keeps verified downloads, extracted sources, and build directories in that selected root.

The finished root contains `engine/bin/tesseract.exe`, `engine/tessdata/eng.traineddata`, the three source/model license texts under `engine/licenses`, `engine/ocr-engine-manifest.json`, and `logs/setup.log`. The manifest records relative paths, versions, byte counts, and SHA-256 values. The recipe verifies its pinned HTTPS inputs, builds a static x64 `/MT` engine with the pinned fast English model, validates its configured build properties, and completes only after the owned P6 smoke text matches exactly and an oversize input is rejected before the process starts. Pinned inputs and options make the recipe repeatable, but executable bytes are not claimed to be bit-reproducible across toolchain or operating-system updates.

One verified run used `target/ocr-recipe-verified-20260924` with four jobs and finished in about 173.70 seconds. Its exact smoke text matched with empty standard error in 160 ms; a 16,777,217-byte control input was rejected before spawn. The local manifest was 8,096 bytes with SHA-256 `3C6B8130968955B50AA252778BAF5D0D188AA7680F35A61EF9E8EEF990A70144`; its setup log was 266,611 bytes with SHA-256 `2877A57ED2F4A03088FCCFF33409A7AAACAF7AE93FAE1AC134C9B992167F9817`. The executable was 4,391,424 bytes with SHA-256 `1D0F85D0655ED8C0B5F6472CD29213BBD79DC5275CCBEE7336360665A94F8C16`; the model retained its pinned SHA-256 `7D4322BD2A7749724879683FC3912CB542F19906C83BCC1A52132556427170B2`.

After a successful setup, run the focused offline recipe controls with fresh evidence and a completed verified root:

```powershell
pwsh -NoProfile -File scripts/ocr/setup-ocr.test.ps1 -EvidenceRoot target/ocr-setup-controls-my-run -VerifiedRoot target/ocr/5.5.3-eng-fast-4.1.0
```

Both parameters are required: `-EvidenceRoot` must be a new directory beneath `target`, and `-VerifiedRoot` must be a completed setup output whose manifest binds the current setup script. The 12 controls tie the current setup script to the verified manifest and check outside-target, existing-root, and junction refusal; bounded standard-output, standard-error, and timeout cleanup; same-length hash tampering; ZIP traversal, link, and expanded-size guards; and the final-log oversize pre-spawn receipt. They do not inject a tampered HTTP response, and TAR hostile-entry handling is source-inspected rather than exercised by these controls. The retained receipt is `target/ocr-setup-negative-controls-v8-20260924/negative-controls.json`, SHA-256 `79BCC6AD7A8966342A273972D0525E68DC9B29E0D04CEBE86E927B56270051E1`.

## Retained evidence

The following local, unshipped research artifacts provide provenance. They are not release assets.

- Benchmark: `target/ocr-probe/results/benchmark-20260924-193439.json`, SHA-256 `5C69A1AD653D9B524854B1C96287E475373C44ED604E158348D861298A8F2E81`.
- Provenance record: `target/ocr-probe/results/provenance.json`, SHA-256 `789C782D2467765D1688F4A99D6BB5B4AFF03C3B1D909C559FD13643289ED635`.
- Build record: `target/ocr-probe/logs/build-20260924-193345.log`, with version, import, and cache evidence under `target/ocr-probe/results/`.
- Static executable: `target/ocr-probe/install/bin/tesseract.exe`, SHA-256 `1AD66BE462A9295B1B6371768147584947442A47DA34DA62DEDEAB309909D3EF`.

## Before any integration

The next proposed implementation slice is local recognition of one current physical page into a copyable plain-text dialog. It would not write OCR text to a PDF, create searchable content or overlays, save a file, alter the source session, or call a cloud service.

That proposal needs a product contract for current physical-page identity, revision ownership, stale results, copy/display behavior, and source-session preservation. It also needs a reviewed packaging and licensing plan for the executable and language data, defined process ownership and bounds, decoding and error policy, supported language selection, and user-cancellation semantics. A representative real-document corpus must measure recognition quality, total page-to-text time, and resource use. Desktop and installed-app behavior would need separate verification.
