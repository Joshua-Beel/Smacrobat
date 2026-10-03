import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

const versionPath = 'resources/pdfium/VERSION';
const argsPath = 'resources/pdfium/args.gn';

it('bundles the exact PDFium version and build configuration beside the binary', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const resources = config.bundle.resources as string[];
  expect(resources.filter(resource => resource === versionPath)).toEqual([versionPath]);
  expect(resources.filter(resource => resource === argsPath)).toEqual([argsPath]);
  expect(resources).toContain('resources/pdfium/bin/pdfium.dll');

  const version = Object.fromEntries(readFileSync(`src-tauri/${versionPath}`, 'utf8').trim().split(/\r?\n/).map(line => line.split('=')));
  expect(version).toEqual({ MAJOR: '151', MINOR: '0', BUILD: '7881', PATCH: '0' });
  expect(createHash('sha256').update(readFileSync(`src-tauri/${versionPath}`)).digest('hex')).toBe('9ea21b933a52e57cd585f5a543c16155513f8195a158b0526f3a3c50fc3431cd');

  const args = readFileSync(`src-tauri/${argsPath}`, 'utf8').trim().split(/\r?\n/).sort();
  expect(args).toEqual([
    'is_component_build = false',
    'is_debug = false',
    'pdf_enable_v8 = false',
    'pdf_enable_xfa = false',
    'pdf_is_standalone = true',
    'pdf_use_partition_alloc = false',
    'target_cpu = "x64"',
    'target_os = "win"',
    'treat_warnings_as_errors = false',
  ].sort());
  expect(createHash('sha256').update(readFileSync(`src-tauri/${argsPath}`)).digest('hex')).toBe('161bf08999e403b7da9d924c45b7ee7bc8beb3038b08f9e174ba6761dd06a976');
});

it('retains both provenance files when reconstructing pinned PDFium resources', () => {
  const preparation = readFileSync('scripts/prepare-default-draft-pdfium.ps1', 'utf8');
  expect(preparation).toContain("$required=@('LICENSE','VERSION','args.gn','bin/pdfium.dll')");
  expect(preparation).toContain("[IO.File]::Copy((Join-Path $extract 'VERSION'),(Join-Path $destination 'VERSION'))");
  expect(preparation).toContain("[IO.File]::Copy((Join-Path $extract 'args.gn'),(Join-Path $destination 'args.gn'))");
});
