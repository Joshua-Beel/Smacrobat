import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { offlineCargoMetadata, prepareMplSourceArchives } from './mpl-source-archives.mjs';

const source = 'registry+https://github.com/rust-lang/crates.io-index';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function tarEntry(path: string, bytes: Buffer) {
  const header = Buffer.alloc(512);
  header.write(path);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257);
  header.write('00', 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  const padding = Buffer.alloc((512 - bytes.length % 512) % 512);
  return Buffer.concat([header, bytes, padding]);
}

function crate(contents: Record<string, string>) {
  return gzipSync(Buffer.concat([...Object.entries(contents).map(([path, text]) => tarEntry(path, Buffer.from(text))), Buffer.alloc(1024)]));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pdf-mpl-archives-'));
  const definitions = [
    ['alpha', '1.0.0'], ['bravo', '1.0.0'], ['charlie', '1.0.0'], ['delta', '1.0.0'], ['echo', '1.0.0'],
  ].map(([name, version]) => {
    const bytes = crate({ [`${name}-${version}/Cargo.toml`]: `[package]\nname = \"${name}\"\n`, [`${name}-${version}/src/lib.rs`]: `pub const ${name.toUpperCase()} : bool = true;\n` });
    return { name, version, sha256: sha256(bytes), url: `https://static.crates.io/crates/${name}/${name}-${version}.crate`, bytes };
  });
  const cache = join(root, 'registry/cache/index');
  mkdirSync(cache, { recursive: true });
  const packages = definitions.map(definition => {
    const sourceDir = join(root, 'registry/src/index', `${definition.name}-${definition.version}`);
    mkdirSync(join(sourceDir, 'src'), { recursive: true });
    writeFileSync(join(sourceDir, 'Cargo.toml'), `[package]\nname = \"${definition.name}\"\n`);
    writeFileSync(join(sourceDir, 'src/lib.rs'), `pub const ${definition.name.toUpperCase()} : bool = true;\n`);
    writeFileSync(join(cache, `${definition.name}-${definition.version}.crate`), definition.bytes);
    return { name: definition.name, version: definition.version, source, manifest_path: join(sourceDir, 'Cargo.toml') };
  });
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(join(root, 'src-tauri/Cargo.lock'), definitions.map(definition => `[[package]]\nname = \"${definition.name}\"\nversion = \"${definition.version}\"\nsource = \"${source}\"\nchecksum = \"${definition.sha256}\"\n`).join('\n'));
  return { root, definitions, metadata: { packages }, output: join(root, 'bundled') };
}

it('packages and re-verifies five exact archives against Cargo.lock and cached source trees', () => {
  const { root, definitions, metadata, output } = fixture();
  try {
    const entries = prepareMplSourceArchives(root, metadata, false, { archives: definitions, folder: output });
    expect(entries.map(entry => entry.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
    expect(JSON.parse(readFileSync(join(output, 'MANIFEST.json'), 'utf8')).archives).toHaveLength(5);
    writeFileSync(join(output, 'MANIFEST.json'), readFileSync(join(output, 'MANIFEST.json'), 'utf8').replaceAll('\n', '\r\n'));
    expect(() => prepareMplSourceArchives(root, metadata, true, { archives: definitions, folder: output })).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('fails closed for missing, tampered, stale, lock-mismatched, and source-mismatched archives', () => {
  const { root, definitions, metadata, output } = fixture();
  try {
    prepareMplSourceArchives(root, metadata, false, { archives: definitions, folder: output });
    unlinkSync(join(output, 'alpha-1.0.0.crate'));
    expect(() => prepareMplSourceArchives(root, metadata, true, { archives: definitions, folder: output })).toThrow('is missing');
    prepareMplSourceArchives(root, metadata, false, { archives: definitions, folder: output });
    writeFileSync(join(output, 'stale.crate'), 'old');
    expect(() => prepareMplSourceArchives(root, metadata, true, { archives: definitions, folder: output })).toThrow('Unexpected or stale');
    unlinkSync(join(output, 'stale.crate'));
    writeFileSync(join(root, 'registry/cache/index/alpha-1.0.0.crate'), 'tampered');
    expect(() => prepareMplSourceArchives(root, metadata, false, { archives: definitions, folder: output })).toThrow('hash does not match Cargo.lock');
  } finally { rmSync(root, { recursive: true, force: true }); }
  const changedLock = fixture();
  try {
    writeFileSync(join(changedLock.root, 'src-tauri/Cargo.lock'), readFileSync(join(changedLock.root, 'src-tauri/Cargo.lock'), 'utf8').replace(changedLock.definitions[0].sha256, 'f'.repeat(64)));
    expect(() => prepareMplSourceArchives(changedLock.root, changedLock.metadata, false, { archives: changedLock.definitions, folder: changedLock.output })).toThrow('Cargo.lock does not match');
  } finally { rmSync(changedLock.root, { recursive: true, force: true }); }
  const changedSource = fixture();
  try {
    writeFileSync(join(changedSource.root, 'registry/src/index/alpha-1.0.0/src/lib.rs'), 'changed');
    expect(() => prepareMplSourceArchives(changedSource.root, changedSource.metadata, false, { archives: changedSource.definitions, folder: changedSource.output })).toThrow('Cached crate source differs');
  } finally { rmSync(changedSource.root, { recursive: true, force: true }); }
});

it('verifies the five checked-in archive resources against offline locked Cargo metadata without fetching', () => {
  const root = process.cwd();
  const entries = prepareMplSourceArchives(root, offlineCargoMetadata(root), true);
  expect(entries.map(entry => `${entry.name}@${entry.version}`)).toEqual([
    'cssparser@0.36.0', 'cssparser-macros@0.6.1', 'dtoa-short@0.3.5', 'option-ext@0.2.0', 'selectors@0.36.1',
  ]);
}, 30_000);
