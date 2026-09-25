# OCR feasibility

## Status

OCR is disabled. Nothing from this research is bundled, installed, or shipped, and there is no OCR command, user interface, or document mutation path.

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

## Retained evidence

The following local, unshipped research artifacts provide provenance. They are not release assets.

- Benchmark: `target/ocr-probe/results/benchmark-20260924-193439.json`, SHA-256 `5C69A1AD653D9B524854B1C96287E475373C44ED604E158348D861298A8F2E81`.
- Provenance record: `target/ocr-probe/results/provenance.json`, SHA-256 `789C782D2467765D1688F4A99D6BB5B4AFF03C3B1D909C559FD13643289ED635`.
- Build record: `target/ocr-probe/logs/build-20260924-193345.log`, with version, import, and cache evidence under `target/ocr-probe/results/`.
- Static executable: `target/ocr-probe/install/bin/tesseract.exe`, SHA-256 `1AD66BE462A9295B1B6371768147584947442A47DA34DA62DEDEAB309909D3EF`.

## Before any integration

The next proposed implementation slice is local recognition of one current physical page into a copyable plain-text dialog. It would not write OCR text to a PDF, create searchable content or overlays, save a file, alter the source session, or call a cloud service.

That proposal needs a product contract for current physical-page identity, revision ownership, stale results, copy/display behavior, and source-session preservation. It also needs a reviewed packaging and licensing plan for the executable and language data, defined process ownership and bounds, decoding and error policy, supported language selection, and user-cancellation semantics. A representative real-document corpus must measure recognition quality, total page-to-text time, and resource use. Desktop and installed-app behavior would need separate verification.
