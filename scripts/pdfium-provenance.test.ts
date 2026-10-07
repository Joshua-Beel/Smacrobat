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
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

async function withPinnedArchiveFixture(archive: Buffer, body: (fixture: { resources: string; requests: () => number; runSetup: (extra?: string[]) => Promise<{ code: number | null; output: string }> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'smacrobat-pdfium-swap-'));
  const server = createServer();
  try {
    mkdirSync(join(root, 'scripts'));
    const archiveSha256 = createHash('sha256').update(archive).digest('hex').toUpperCase();
    const original = readFileSync('scripts/setup-pdfium.ps1', 'utf8');
    const pinLine = `$archiveSha256 = '${pinnedArchiveSha256}'`;
    expect(original.split(pinLine).length).toBe(2);
    writeFileSync(join(root, 'scripts', 'setup-pdfium.ps1'), original.replace(pinLine, `$archiveSha256 = '${archiveSha256}'`));
    let requests = 0;
    server.on('request', (_request, response) => { requests += 1; response.writeHead(200, { 'Content-Type': 'application/gzip' }); response.end(archive); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await body({
      resources: join(root, 'src-tauri', 'resources'),
      requests: () => requests,
      runSetup: (extra = []) => runPwsh(['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts', 'setup-pdfium.ps1'), '-ArchiveUri', `http://127.0.0.1:${port}/pdfium-win-x64.tgz`, ...extra], 60_000),
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

function packArchive(files: Record<string, string | Buffer>): Buffer {
  const root = mkdtempSync(join(tmpdir(), 'smacrobat-pdfium-pack-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      mkdirSync(join(root, 'payload', relative, '..'), { recursive: true });
      writeFileSync(join(root, 'payload', relative), content);
    }
    const packed = spawnSync('tar', ['-czf', 'archive.tgz', '-C', 'payload', ...Object.keys(files)], { cwd: root, encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    return readFileSync(join(root, 'archive.tgz'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedStaleFolder(resources: string) {
  mkdirSync(join(resources, 'pdfium', 'bin'), { recursive: true });
  writeFileSync(join(resources, 'pdfium', 'bin', 'pdfium.dll'), 'stale unverified binary');
  writeFileSync(join(resources, 'pdfium', 'leftover.txt'), 'from an older archive');
}

it('replaces a stale, unmarked pdfium folder with the verified archive and re-extracts when the recorded DLL hash no longer matches', async () => {
  const archive = packArchive({ 'bin/pdfium.dll': 'verified binary', LICENSE: 'license text' });
  await withPinnedArchiveFixture(archive, async ({ resources, requests, runSetup }) => {
    seedStaleFolder(resources);
    const stale = await runSetup(['-SkipIfCurrent']);
    expect(stale.code, stale.output).toBe(0);
    expect(requests()).toBe(1);
    expect(readFileSync(join(resources, 'pdfium', 'bin', 'pdfium.dll'), 'utf8')).toBe('verified binary');
    expect(readdirSync(join(resources, 'pdfium')).sort()).toEqual(['.verified-archive', 'LICENSE', 'bin']);
    expect(readdirSync(resources).sort()).toEqual(['pdfium', 'pdfium-win-x64.tgz']);
    const archiveSha256 = createHash('sha256').update(archive).digest('hex').toUpperCase();
    const dllSha256 = createHash('sha256').update('verified binary').digest('hex').toUpperCase();
    expect(readFileSync(join(resources, 'pdfium', '.verified-archive'), 'utf8')).toBe(`archive-sha256=${archiveSha256}\npdfium.dll-sha256=${dllSha256}\n`);

    const current = await runSetup(['-SkipIfCurrent']);
    expect(current.code, current.output).toBe(0);
    expect(current.output).toContain('already extracted');
    expect(requests()).toBe(1);

    writeFileSync(join(resources, 'pdfium', 'bin', 'pdfium.dll'), 'swapped after extraction');
    const tampered = await runSetup(['-SkipIfCurrent']);
    expect(tampered.code, tampered.output).toBe(0);
    expect(requests()).toBe(2);
    expect(readFileSync(join(resources, 'pdfium', 'bin', 'pdfium.dll'), 'utf8')).toBe('verified binary');
  });
}, 120_000);

it('leaves no half-populated pdfium folder when a hash-matching archive fails to extract', async () => {
  const filler = Buffer.concat(Array.from({ length: 4096 }, (_, index) => createHash('sha512').update(String(index)).digest()));
  const full = packArchive({ 'bin/pdfium.dll': 'first entry', 'licenses/large.bin': filler });
  await withPinnedArchiveFixture(full.subarray(0, Math.floor(full.length * 0.7)), async ({ resources, requests, runSetup }) => {
    const fresh = await runSetup();
    expect(requests()).toBe(1);
    expect(fresh.code, fresh.output).not.toBe(0);
    expect(fresh.output).toContain('PDFium extraction failed');
    expect(readdirSync(resources)).toEqual(['pdfium-win-x64.tgz']);

    seedStaleFolder(resources);
    const overStale = await runSetup();
    expect(overStale.code, overStale.output).not.toBe(0);
    expect(readdirSync(resources).sort()).toEqual(['pdfium', 'pdfium-win-x64.tgz']);
    expect(readdirSync(join(resources, 'pdfium')).sort()).toEqual(['bin', 'leftover.txt']);
    expect(readFileSync(join(resources, 'pdfium', 'bin', 'pdfium.dll'), 'utf8')).toBe('stale unverified binary');
  });
  await withPinnedArchiveFixture(packArchive({ LICENSE: 'license only' }), async ({ resources, runSetup }) => {
    const result = await runSetup();
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('no bin/pdfium.dll');
    expect(readdirSync(resources)).toEqual(['pdfium-win-x64.tgz']);
  });
}, 120_000);

it('restores the previous pdfium folder intact when moving the staged folder into place fails', async () => {
  const archive = packArchive({ 'bin/pdfium.dll': 'verified binary', LICENSE: 'license text' });
  await withPinnedArchiveFixture(archive, async ({ resources, requests, runSetup }) => {
    seedStaleFolder(resources);
    const result = await runSetup(['-TestOnlyFailStagingMove']);
    expect(requests()).toBe(1);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('previous pdfium folder was restored unchanged');
    expect(readdirSync(resources).sort()).toEqual(['pdfium', 'pdfium-win-x64.tgz']);
    expect(readdirSync(join(resources, 'pdfium')).sort()).toEqual(['bin', 'leftover.txt']);
    expect(readFileSync(join(resources, 'pdfium', 'bin', 'pdfium.dll'), 'utf8')).toBe('stale unverified binary');
    expect(readFileSync(join(resources, 'pdfium', 'leftover.txt'), 'utf8')).toBe('from an older archive');
  });
}, 120_000);

it('leaves every file of the previous pdfium folder in place when a file inside it is locked', async () => {
  const archive = packArchive({ 'bin/pdfium.dll': 'verified binary', LICENSE: 'license text' });
  await withPinnedArchiveFixture(archive, async ({ resources, runSetup }) => {
    seedStaleFolder(resources);
    const locked = join(resources, 'pdfium', 'leftover.txt');
    const locker = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$h=[IO.File]::Open('${locked.replace(/'/g, "''")}','Open','Read','None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $h.Dispose()`], { windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => {
        let seen = '';
        locker.stdout.on('data', chunk => { seen += chunk; if (seen.includes('locked')) resolve(); });
        locker.on('error', reject);
        locker.on('close', code => reject(new Error(`locker exited ${code}: ${seen}`)));
      });
      const result = await runSetup();
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('existing pdfium folder was left unchanged');
    } finally {
      locker.stdin.end('\n');
      await new Promise<void>(resolve => { if (locker.exitCode !== null) resolve(); else locker.on('close', () => resolve()); });
    }
    expect(readdirSync(resources).sort()).toEqual(['pdfium', 'pdfium-win-x64.tgz']);
    expect(readdirSync(join(resources, 'pdfium')).sort()).toEqual(['bin', 'leftover.txt']);
    expect(readFileSync(join(resources, 'pdfium', 'bin', 'pdfium.dll'), 'utf8')).toBe('stale unverified binary');
    expect(readFileSync(locked, 'utf8')).toBe('from an older archive');
  });
}, 120_000);

it('keeps PDFium staging and backup folders out of git', () => {
  const ignore = readFileSync('.gitignore', 'utf8').split(/\r?\n/);
  expect(ignore).toContain('src-tauri/resources/.pdfium-staging-*/');
  expect(ignore).toContain('src-tauri/resources/.pdfium-backup-*/');
});

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
