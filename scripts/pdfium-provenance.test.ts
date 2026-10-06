import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const pinnedArchiveSha256 = '73CC0DE638AC2095E7445BF56A38200A5B7C7CA0E9F4BA144598F2457377AC08';

function runPwsh(args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh.exe', args, { windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`pwsh timed out: ${output}`)); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

it('pins the same PDFium archive SHA-256 for setup and draft reconstruction', () => {
  const setup = readFileSync('scripts/setup-pdfium.ps1', 'utf8');
  const preparation = readFileSync('scripts/prepare-default-draft-pdfium.ps1', 'utf8');
  expect(setup).toContain(`$archiveSha256 = '${pinnedArchiveSha256}'`);
  expect(preparation).toContain(`$assetSha256='${pinnedArchiveSha256}'`);
});

it('refuses and deletes a downloaded PDFium archive whose SHA-256 differs from the pin, without extracting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smacrobat-pdfium-pin-'));
  const server = createServer();
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync('scripts/setup-pdfium.ps1', join(root, 'scripts', 'setup-pdfium.ps1'));
    const payload = join(root, 'payload');
    mkdirSync(join(payload, 'bin'), { recursive: true });
    writeFileSync(join(payload, 'bin', 'pdfium.dll'), 'not the pinned binary');
    const tgz = join(root, 'substitute.tgz');
    const packed = spawnSync('tar', ['-czf', 'substitute.tgz', '-C', 'payload', 'bin'], { cwd: root, encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const bytes = readFileSync(tgz);
    const substituteSha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase();
    expect(substituteSha256).not.toBe(pinnedArchiveSha256);

    let requests = 0;
    server.on('request', (_request, response) => { requests += 1; response.writeHead(200, { 'Content-Type': 'application/gzip' }); response.end(bytes); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const result = await runPwsh(['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts', 'setup-pdfium.ps1'), '-ArchiveUri', `http://127.0.0.1:${port}/pdfium-win-x64.tgz`], 60_000);
    expect(requests).toBe(1);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('PDFium archive SHA-256 mismatch');
    expect(result.output).toContain(substituteSha256);
    const resources = join(root, 'src-tauri', 'resources');
    expect(existsSync(join(resources, 'pdfium-win-x64.tgz'))).toBe(false);
    expect(existsSync(join(resources, 'pdfium', 'bin', 'pdfium.dll'))).toBe(false);
    expect(readdirSync(resources)).toEqual([]);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

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
