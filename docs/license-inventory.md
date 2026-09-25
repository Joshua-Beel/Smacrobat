# Dependency license inventory

This inventory covers the current Windows x64 source tree, the locally extracted v0.2.4 draft installer, a fresh local unsigned debug installer extraction, and the verified signed v0.2.6 draft extraction. It identifies notice-packaging work; it does not mark the app's licensing review complete. Versions below come from the lockfiles and installed package manifests, not requested version ranges.

## What is packaged today

`src-tauri/tauri.conf.json` explicitly includes the PDFium DLL, its top-level `LICENSE`, all files under `resources/pdfium/licenses/`, the generated Rust/frontend third-party notice collection, and five exact MPL source archives. The extracted 0.2.4 draft contains the older PDFium notice set. A fresh local unsigned debug installer extraction matched the generated inventory, full notices, source-archive manifest, and all five archive hashes. The signed v0.2.6 draft was independently extracted from [run 35250878119](https://github.com/Joshua-Beel/Smacrobat/actions/runs/35250878119) before the privacy rewrite: all five archives, their manifest, inventory, and both notice resources matched the then-tagged source. The rewritten [`v0.2.6` tag](https://github.com/Joshua-Beel/Smacrobat/commit/8cf90166623857dddd3854ce769549da55f6f5c4) records the cleaned source history; the draft assets were not rebuilt. That checks bundled resources only; it does not verify installation, notice interaction, or complete licensing review.

The PDFium distribution is Chromium build **151.0.7881.0**, pinned by `scripts/setup-pdfium.ps1`. Its local `args.gn` says Windows x64, standalone, V8 disabled, XFA disabled. Keep its complete upstream notice set rather than deriving a new list from the wrapper crate's license:

`abseil.txt`, `agg23.txt`, `fast_float.txt`, `freetype.txt`, `icu.txt`, `lcms.txt`, `libjpeg_turbo.ijg`, `libjpeg_turbo.md`, `libopenjpeg.txt`, `libpng.txt`, `libtiff.txt`, `llvm-libc.txt`, `pdfium.txt`, `simdutf.txt`, `zlib.txt`.

PDFium's version/build configuration files are present locally but are not in the bundle resource list. Record that version in the eventual notice index so the DLL and its notices remain traceable.

## Frontend production dependencies

These are the eight non-development entries in `package-lock.json`. A production bundler may remove unused code; this list is the conservative package inventory, not a claim that every package is present byte-for-byte in the final JavaScript.

| Package | Locked version | Declared license | Notice source in `node_modules` |
| --- | --- | --- | --- |
| `@tauri-apps/api` | 2.11.1 | Apache-2.0 OR MIT | `@tauri-apps/api/LICENSE_APACHE-2.0`, `LICENSE_MIT` |
| `@tauri-apps/plugin-updater` | 2.11.0 | MIT OR Apache-2.0 | npm package contains `LICENSE.spdx`; full matching-version texts exist in the cached Rust updater crate |
| `lucide-react` | 1.46.0 | ISC in package metadata | `lucide-react/LICENSE` also contains Feather-derived icon attribution and MIT text; retain the whole file |
| `react` | 18.3.1 | MIT | `react/LICENSE` |
| `react-dom` | 18.3.1 | MIT | `react-dom/LICENSE` |
| `scheduler` | 0.23.2 | MIT | `scheduler/LICENSE` |
| `loose-envify` | 1.4.0 | MIT | `loose-envify/LICENSE` |
| `js-tokens` | 4.0.0 | MIT | `js-tokens/LICENSE` |

The updater's `LICENSE.spdx` is metadata, not the full Apache/MIT text. Its generic `PackageName: tauri` should not be used as an exact inventory of that npm package's contents.

Frontend development tools are separately declared: Tauri CLI 2.11.4, TypeScript 5.8.3, Vite 6.4.3, Vitest 3.2.4, React Vite plugin 4.7.0, React test renderer 18.3.1, and React type packages. They are not application runtime dependencies just because they appear in the lockfile. Their installed development trees still need their own upstream notices if those trees or tools are redistributed.

## Direct Rust dependencies

The following versions and expressions were read through offline, locked Cargo metadata for `x86_64-pc-windows-msvc`. Preserve upstream expressions: `AND` and `OR` are not interchangeable.

| Runtime dependency | Locked version | Declared license |
| --- | --- | --- |
| `tauri` | 2.11.5 | Apache-2.0 OR MIT |
| `tauri-plugin-updater` | 2.11.0 | Apache-2.0 OR MIT |
| `serde` | 1.0.229 | MIT OR Apache-2.0 |
| `serde_json` | 1.0.151 | MIT OR Apache-2.0 |
| `pdfium-render` | 0.9.4 | MIT OR Apache-2.0 |
| `image` | 0.25.10 | MIT OR Apache-2.0 |
| `rfd` | 0.15.4 | MIT |
| `tokio` | 1.53.1 | MIT |
| `lopdf` | 0.45.0 | MIT |
| `tempfile` | 3.27.0 | MIT OR Apache-2.0 |
| `windows` | 0.61.3 | MIT OR Apache-2.0 |

`tempfile` is used by the production atomic-save implementation, not only tests. `tauri-build` 2.6.3 is a build dependency (Apache-2.0 OR MIT). Procedural macros and build tools must be classified separately when generating the final inventory; simply copying every `Cargo.lock` package into a list of shipped libraries would overstate it.

## Rust transitive packages requiring more than a generic MIT notice

Walking normal dependency edges produced 340 third-party package identities. Excluding procedural-macro packages and their traversal produced 292. These are conservative metadata sets: feature unification and actual linker elimination still require release-build confirmation. Neither count is a verified count of linked libraries.

Examples that a notice generator must retain accurately:

| Package(s) | Declared expression / local evidence |
| --- | --- |
| `cssparser` 0.36.0, `dtoa-short` 0.3.5, `selectors` 0.36.1, `option-ext` 0.2.0 | MPL-2.0; still reachable after the procedural-macro exclusion. The first three occur through `dom_query`/CSS parsing; `option-ext` is a normal dependency of `dirs-sys`. Their exact `.crate` archives are bundled under `resources/third-party-sources/` with Cargo.lock SHA-256 values and official crates.io URLs in the source manifest and generated notices. |
| `cssparser-macros` 0.6.1 | MPL-2.0; procedural-macro package, classified separately from shipped runtime code. Its exact source archive is packaged with the same verification. |
| `ring` 0.17.14 | Apache-2.0 AND ISC. Its root `LICENSE` refers to `LICENSE-BoringSSL`, `LICENSE-other-bits`, and `src/polyfill/once_cell/LICENSE-APACHE` / `LICENSE-MIT`; copying the small root file alone loses the referenced texts. |
| `brotli` 8.0.4 | BSD-3-Clause AND MIT |
| `dpi` 0.1.2 | Apache-2.0 AND MIT |
| `encoding_rs` 0.8.41 | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| `unicode-ident` 1.0.25 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| ICU4X, `litemap`, `potential_utf`, `tinystr`, `writeable`, `yoke`, `zerofrom`, `zerotrie`, `zerovec` | Unicode-3.0 across the resolved versions; preserve individual package identity and notice files. |
| `alloc-no-stdlib`, `alloc-stdlib`, `subtle` | BSD-3-Clause |
| `libloading`, `rustls-webpki`, `untrusted` | ISC |
| `foldhash`, `zlib-rs` | Zlib |

This table highlights exceptions; it is not the complete transitive package list. Cached crate sources are under `%USERPROFILE%/.cargo/registry/src/<registry>/<crate>-<version>/`. The manifests, complete license files, notice files, and any referenced subcomponent licenses there are the collection sources.

## Generated collection

`scripts/dependency-notices.mjs` collects the conservative resolved Windows Cargo graph and production npm lock entries into `src-tauri/resources/third-party-licenses/inventory.json` and `THIRD-PARTY-NOTICES.txt`. There are 367 package records, including build/auxiliary packages; this is not a count of libraries linked into the application. The collection includes Lucide's Feather attribution and nested `ring` notices. The current inventory is 209,343 bytes with SHA-256 `E167ED2496828C8654FFBA8387D808CC742E843095A03E8900803551DA67CA0F`; its refresh changed only Cargo input hashes, not package records or notice text.

Twelve missing local notices were resolved using published crate commits and official upstream license files. `scripts/notice-supplements/manifest.json` records exact commits, provenance URLs and SHA-256 hashes. Offline generation verifies those inputs. Explicitly running `scripts/fetch-notice-supplements.mjs --fetch` retrieves the recorded files and rejects unexpected hashes.

`scripts/mpl-source-archives.manifest.json` pins `cssparser` 0.36.0, `cssparser-macros` 0.6.1, `dtoa-short` 0.3.5, `option-ext` 0.2.0, and `selectors` 0.36.1 to their Cargo.lock SHA-256 values and official crates.io archive URLs. `scripts/mpl-source-archives.mjs` verifies every cached archive hash and every extracted source file before copying the archives and a resource manifest to `src-tauri/resources/third-party-sources/`. It fails closed for a missing, tampered, stale, lock-mismatched, or source-mismatched archive without network access. The local cache comparison found no changed or missing source files; Cargo's generated `.cargo-ok` marker is excluded from that comparison.

The generated files are included in Tauri resources and available through **Menu > Third-party notices** in the source build. The installer script checks freshness before building. Existing PDFium notices remain separately packaged.

## Optional OCR installer sidecars

The normal generated notice collection remains the 367-package Cargo/npm inventory above. It does not include OCR files, and the default installer extraction proof contains no `resources/ocr/` entries. That default behavior must remain unchanged while OCR is absent.

An explicitly requested unsigned local OCR installer proof copied a separate five-file resource set under `resources/ocr/1d0f85d0655ed8c0b5f6472cd29213bbd79dc5275ccbee7336360665a94f8c16/`: `bin/tesseract.exe`, `tessdata/eng.traineddata`, and these license-text sidecars:

| Component | Version / source record | Packaged relative path | License-text SHA-256 |
| --- | --- | --- | --- |
| Tesseract | 5.5.3; `scripts/ocr/pins.json` | `licenses/Tesseract-Apache-2.0.txt` | `CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30` |
| Leptonica | 1.87.0; `scripts/ocr/pins.json` | `licenses/Leptonica-BSD-2-Clause.txt` | `87829ABB5BBB00B55A107365DA89E9A33F86C4250169E5A1E5588505BE7D5806` |
| English fast model | 4.1.0; `scripts/ocr/pins.json` | `licenses/eng-fast-Apache-2.0.txt` | `CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30` |

The opt-in extraction receipt is `target/ocr-installer-opt-in-proof-20260925-v3/installer-verification.json`, SHA-256 `0E4B373E90916D2B50BD3C1B09000B15030E6A8646C91CA2B1C4362CBA0BDBC6`; the corresponding default receipt is `target/ocr-installer-default-proof-20260925-v3/installer-verification.json`, SHA-256 `E5962F54E3E85F6E78AA1A1EA29291100652ED11B4F1B30BAA1F63197865C50A`. Both checks only inspect unsigned installer contents. They do not verify installation, application launch, updates, signing, a release artifact, or the notice-dialog interaction. Signed OCR packaging is explicitly refused and remains unverified.

These OCR texts are packaged sidecars, not entries in the current **Third-party notices** menu. Any future OCR distribution needs to keep this separate inventory and its copied source texts accurate, then decide and verify how users reach them. The signed-OCR installer path fails closed before an output root, credentials, build, or signing; its retained control log is `target/ocr-page-probe/logs/installer-signed-ocr-refusal-20260925.log`, SHA-256 `E5C0794710A39270F47D58AFE6503427E7489A523DA74A5F0D9309B334CAF048`. Azure-signed OCR packaging remains unsupported pending a signed-engine/Tauri hash-order solution. This is an inventory and provenance record, not a complete licensing review or legal advice.

To regenerate after a dependency change:

```powershell
cargo fetch --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
node scripts/mpl-source-archives.mjs
node scripts/mpl-source-archives.mjs --check
node scripts/dependency-notices.mjs
node scripts/dependency-notices.mjs --check
```

## Remaining release checks

1. Check the installed app's notice entry after installation. The signed v0.2.6 draft extraction establishes bundled resources, not installed-app interaction.
2. Record the WebView2 bootstrapper/distribution version and its associated terms separately. The config downloads the bootstrapper; this inventory did not inspect that payload. The app's own redistribution license is also unresolved: the root has no `LICENSE` file and its Cargo package has no license field. Joshua owns that choice.

## Reproducing the metadata read

```text
cargo metadata --offline --locked --filter-platform x86_64-pc-windows-msvc --format-version 1 --manifest-path src-tauri/Cargo.toml
```

The initial inventory used local lockfiles, installed dependency notices and the extracted v0.2.4 draft's PDFium directory. The later supplement collection fetched the recorded upstream license files. The MPL archive collection compared all five official cached archives to their extracted Cargo source trees; fresh unsigned debug and signed v0.2.6 draft extractions hash-checked all five archives plus both notice resources. These checks establish reproducibility and resource inclusion, not complete release-license review.
