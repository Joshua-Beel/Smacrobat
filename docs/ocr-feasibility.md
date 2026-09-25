# OCR feasibility

## Status

OCR is unavailable by default and remains absent from published releases. A developer can build an opt-in source executable with a verified local English engine; that build alone enables one current-page, plain-text OCR dialog. It does not create a searchable PDF, edit a document, or call a service. An unsigned local opt-in installer extraction now proves the selected resources can be packaged, but not installed, launched, updated, signed, or released.

## Internal runner foundation

The native runner is exposed only to an opt-in source build. Default builds report OCR unavailable, even if stale copied resources exist. The default installer has no OCR resource path; the separately checked unsigned opt-in installer is not a signed or release path.

The runner requires a trusted internal engine identity and a fixed English-model identity, with no IPC or user engine path or hash, shell, or `PATH` lookup. One global admission gate refuses a second job immediately and limits process-plus-job committed memory to 256 MiB. It accepts only owned P6 input up to 16,777,216 bytes and a 16,384-pixel edge, uses fixed English-fast/150-DPI arguments, strict UTF-8 decoding, 1 MiB standard output, 64 KiB standard error, and a 30-second limit. Successful standard error fails closed. Each child is created suspended, assigned to its kill-on-close job, cancellation-checked, then resumed; timeout, cancellation, or output-cap work kills and reaps the child tree. These bounds do not cover RSS, application or PDFium memory, or source-raster allocation.

Focused native checks passed 14 tests with 0 failures and 3 ignored in 3.64 seconds; retained checks passed 3 of 3 in 0.87 seconds. They included a deterministic 16,766,993-byte owned P6 result at 88,735,744 bytes peak job commitment. The full native gate passed 181 tests with 0 failures and 4 ignored in 420.00 seconds. A successful standalone debug/no-bundle rerun transformed 1,936 frontend modules in 2.96 seconds and native code in 22.78 seconds; its 30,217,216-byte executable SHA-256 is `E69DB97531D2A5A6A74BA8E8DB98ACAA04715D11F553EFC7920FDB148B103085`. The embedded Brotli JavaScript and CSS bytes exactly matched current assets; embedded transformed HTML referenced those assets. This is runner evidence only; it does not establish general recognition accuracy, end-to-end page-to-text time, desktop interaction, installed-app behavior, or a reachable OCR runtime.

## Current-page source build

The coordinator captures one current physical page at fixed 150 DPI, including supported current edits, and conservatively refuses encrypted, restricted, signed, or certified documents. The dialog captures a document ID, revision, zero-based physical page, and opaque request ID. It accepts text only when the returned ID, revision, page, and request ID match. The text is read-only and copyable; it is never indexed, overlaid, or written into the PDF. A cancellation cannot interrupt a PDFium call already in progress; shared admission stays held until the cancelled worker drains. These controls do not bound total application RSS.

Focused and retained checks are verified. The retained case captured document 2, revision 5, physical page 0 as a 1,618×1,250 P6 snapshot: 6,067,517 bytes, SHA-256 `8084BE11A715ADC2937EEF8E117DA35F69240E00D0D3158035E68F5DCF493292`. Its 222-byte receipt SHA-256 was `3F3C168A7906FE16F15000A745703282E6C069559C2B8005B951369605D0D14F`; the fixed known text matched exactly and peak child commitment was 39,063,552 bytes. The frontend gate passed 207 tests across 45 files, including eight mocked-IPC OCR tests. The opt-in native gate passed 190 tests with 0 failures and 11 ignored in 416.28 seconds, and its build helper passed 6 tests in 0.07 seconds. A separately invoked retained command path passed three real command tests in 2.71 seconds; its log SHA-256 is `721C41114EBF7C61DCCDE99061CB67E7A738AB328207721FA6191538C91DD3B8`, and its binding receipt SHA-256 is `8A2B09E8381AC480F9E30CB0483355DC279778FF75503C9B10467F7AD4B0F48D`. The final retained opt-in standalone build transformed 1,937 frontend modules in 2.18 seconds and native code in 5.49 seconds. Its retained executable is `target/ocr-page-probe/artifacts/pdf-workstation-opt-in-20260924.exe`, 30,574,080 bytes, SHA-256 `EB90DD65BE72CACC98E945EF21AD1B0C32E0901066BFB534016B41B75DA6E5D7`. The native log `target/ocr-page-probe/logs/full-native-opt-in-20260924.log` has SHA-256 `7D5F231B6765B5F83976AB8E49E9145229A21B713E32448AC64D752C459A2E99`; retained standalone log `target/ocr-page-probe/logs/standalone-opt-in-20260924-retained.log` has SHA-256 `06408AEA10ED2526F9A04F4071E2DE7BF97060D14B4390834D339BF44CD3B159`; and retained build receipt `target/ocr-page-probe/opt-in-build-receipt-retained-20260924.json` is 5,652 bytes with SHA-256 `4CA41349E7AAEC1ECC4251E2085AF0D2230ACAAD678D5A7C178DDF8881398246`. That receipt binds the retained and live executable, current assets, copied resources, and all logs. A separate default-build proof passed with stale resources present but the opt-in environment absent, confirming that OCR remained unavailable. A local browser harness exercised recognized text, an empty response, and cancellation for `{id:9,revision:3,page:1}`. A later frontend lifecycle audit added mocked StrictMode and teardown cases: one replayed request settles into read-only text without a cancellation call, while real teardown sends one cancellation request and records no unhandled-rejection event. The full frontend gate then passed 213 tests across 47 files in 5.35 seconds. The final retained opt-in standalone build transformed 1,937 modules in 2.19 seconds and native code in 7.22 seconds; its 30,602,240-byte executable SHA-256 is `7175555A89C781D538015B3307A625DED7C41DDB66B347409E4E8F7B1F63E889`. Its standalone log is `target/ocr-adversarial-final-standalone-20260925.log`, SHA-256 `706DA740BC8F2C7D47363601C4D55659BDFB156D08F550FA32F262FE84257825`. Those browser and unit checks do not establish native desktop interaction, installed-app behavior, general recognition accuracy, total memory, or end-to-end page-to-text time.

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

## Enabling the source build

After a completed setup, set the root for the build and create a debug executable:

```powershell
$env:PDF_WORKSTATION_OCR_SETUP_ROOT = 'target/ocr/5.5.3-eng-fast-4.1.0'
npm.cmd run tauri -- build --debug --no-bundle
```

The environment value must name that completed setup root. The build rechecks the current setup and support files, engine and model sizes and hashes, fixed configuration, licenses, and non-reparse paths before embedding the executable identity and fixed English-model identity with a resource-relative path. The runtime rechecks copied resources and reparse points; it does not trust the adjacent setup manifest and exposes no engine paths or hashes to the interface. The resulting source-build resources must remain beside the executable at its built resource path.

This only binds selected local inputs to an unsigned development build. It does not authenticate a publisher, validate an installed copy, or make the engine a release resource. A separate unsigned local installer extraction check packaged exactly five OCR sidecars under an engine-identity directory: the engine, English model, and the three license texts. The default installer check packaged zero OCR files. Both checks stop before installation or launch. The existing **Third-party notices** command now appends the three verified OCR license texts in an opt-in source build, while a default build returns the original base text. Optional license verification failure puts its generic warning before that intact base text. The command reads license texts only; a focused success fixture omitted the engine, which does not describe a complete installer. A retained bundled-resource readback produced a 24,473-byte appended section containing the three verified license sidecar texts. Signed OCR packaging is refused before an output root, credentials, build, or signing; Azure-signed OCR packaging remains unsupported pending a signed-engine/Tauri hash-order solution. The broader native gate passed 195 tests with 0 failures and 12 ignored in 317.62 seconds, plus 7 of 7 `ocr_build` integration checks, before the warning-order correction. The correction passed six focused native cases in 0.07 seconds and a retained actual-resource readback. The retained opt-in standalone build transformed 1,937 frontend modules in 2.22 seconds and native code in 7.84 seconds; its 30,602,240-byte executable SHA-256 is `4CDDD9FC2425D5B70455C19FCBEC31671CFEE2DF16AA83227CC98909376D13FA`. The retained post-correction frontend gate passed 212 tests across 47 files in 5.14 seconds; its 3,097-byte log is `target/ocr-page-probe/logs/notices-frontend-warning-final-v2-20260925.log`, SHA-256 `5780943C2A620A699A7618F0FAF6F43A86BAE2EFA2BE14CE7EDF38356191DEB4`. The final retained embed receipt `target/ocr-notices-proof-20260925/embed-proof-warning-final.json`, SHA-256 `9030349A258AE293391078011630D4A11FCEDE0D58CD2C6F22EA59D2E4E9338C`, verifies exact current JavaScript/CSS bytes and transformed HTML asset references; it does not establish installed-app interaction. See the [dependency license inventory](license-inventory.md) for paths, license-text hashes, and the extraction receipts.

## Retained evidence

The following local, unshipped research artifacts provide provenance. They are not release assets.

- Benchmark: `target/ocr-probe/results/benchmark-20260924-193439.json`, SHA-256 `5C69A1AD653D9B524854B1C96287E475373C44ED604E158348D861298A8F2E81`.
- Provenance record: `target/ocr-probe/results/provenance.json`, SHA-256 `789C782D2467765D1688F4A99D6BB5B4AFF03C3B1D909C559FD13643289ED635`.
- Build record: `target/ocr-probe/logs/build-20260924-193345.log`, with version, import, and cache evidence under `target/ocr-probe/results/`.
- Static executable: `target/ocr-probe/install/bin/tesseract.exe`, SHA-256 `1AD66BE462A9295B1B6371768147584947442A47DA34DA62DEDEAB309909D3EF`.

## Remaining work

The opt-in source build still needs native desktop interaction testing, installed-copy validation, and release packaging and signing work before it can be described as installed or shipped. A representative real-document corpus is still needed to measure recognition quality, total page-to-text time, and resource use.
