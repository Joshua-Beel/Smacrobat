import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

describe('release workflow contract', () => {
  it('pins every action to an immutable full commit SHA', () => {
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)\s*$/gm)].map(match => match[1]);
    expect(uses).toEqual([
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87',
      'actions/setup-dotnet@67a3573c9a986a3f9c594539f4ab511d57bb3ce9',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    ]);
    for (const use of uses) expect(use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    expect(workflow).not.toMatch(/uses:\s*[^\s]+@(?:v\d+|stable|main|master)\b/);
  });

  it('binds an exact stable tag, every version source, checkout, and draft target to one commit', () => {
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain("'^v(?<version>\\d+\\.\\d+\\.\\d+)$'");
    for (const source of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
      expect(workflow).toContain(source);
    }
    expect(workflow).toContain('git rev-parse HEAD');
    expect(workflow).toContain('git rev-parse "$($env:GITHUB_REF_NAME)^{commit}"');
    expect(workflow).toContain('$head -cne $env:GITHUB_SHA -or $tagCommit -cne $env:GITHUB_SHA');
    expect(workflow).toContain('--verify-tag --draft --target $env:GITHUB_SHA');
    expect(workflow).toContain('-not $release.isDraft');
    expect(workflow).toContain('$release.targetCommitish -cne $env:GITHUB_SHA');
    expect(workflow).not.toMatch(/gh release (?:edit|upload).*--latest|gh release edit.*--draft=false/);
  });

  it('resolves the package-lock root with its empty-string key in PowerShell 7', () => {
    expect(workflow).toContain('ConvertFrom-Json -AsHashtable');
    expect(workflow).toContain("$lockRoot = $packageLock['packages']['']");
    const command = String.raw`
      $packageLock = Get-Content package-lock.json -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
      $lockRoot = $packageLock['packages']['']
      if ($packageLock.version -cne '0.2.8' -or $lockRoot.version -cne '0.2.8') { throw 'Wrong package-lock versions.' }
    `;
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }, 15_000);

  it('fails closed on signing and publishes only the explicit three-asset draft inventory', () => {
    for (const secret of [
      'TAURI_SIGNING_PRIVATE_KEY',
      'AZURE_TENANT_ID',
      'AZURE_CLIENT_ID',
      'AZURE_CLIENT_SECRET',
      'AZURE_SIGNING_ENDPOINT',
      'AZURE_SIGNING_ACCOUNT',
      'AZURE_SIGNING_PROFILE',
    ]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).toContain('./scripts/build-installer.ps1 -AzureSigning');
    expect(workflow).toContain("$expected = @($installerName, \"$installerName.sig\", 'latest.json')");
    expect(workflow).toContain('$actual.Count -ne 3');
    expect(workflow).toContain('Updater manifest is not bound to the exact version, installer, detached signature, and release notes.');
    expect(workflow).toContain('src-tauri/target/release/bundle/nsis/PDF Workstation_${{ env.RELEASE_VERSION }}_x64-setup.exe');
    expect(workflow).toContain('src-tauri/target/release/bundle/nsis/PDF Workstation_${{ env.RELEASE_VERSION }}_x64-setup.exe.sig');
    expect(workflow).toContain('src-tauri/target/release/bundle/nsis/latest.json');
    expect(workflow).not.toMatch(/bundle\/nsis\/\*|Get-ChildItem[^\n]+Where-Object[^\n]+\.(?:exe|sig|json)/);
  });

  it('keeps version metadata, updater trust, and release limitations exact', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const npmLock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"$/m)?.[1];
    const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8').match(/\[\[package\]\]\r?\nname = "pdf-workstation"\r?\nversion = "([^"]+)"/)?.[1];
    expect([pkg.version, npmLock.version, npmLock.packages[''].version, tauri.version, cargo, cargoLock]).toEqual(Array(6).fill('0.2.8'));
    expect(tauri.plugins.updater).toEqual({
      pubkey: 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg1OTcwQzM0QUVBQkQ3NzUKUldSMTE2dXVOQXlYaFdZN0k1Mk1CcSt2NS81bzNRTERRbU16ejYxTDNiS3V6b1RTZ0tuTlRjZVEK',
      endpoints: ['https://github.com/Joshua-Beel/Smacrobat/releases/latest/download/latest.json'],
      windows: { installMode: 'passive' },
    });
    const notes = readFileSync('docs/release-notes.md', 'utf8');
    expect(notes).toMatch(/^## 0\.2\.8 \(draft candidate\)/);
    expect(notes).toContain('Hardens update recovery.');
    expect(notes).toContain('does not bundle OCR');
    expect(notes).toContain('does not create searchable/document OCR');
    expect(notes).toContain('makes no redaction, PDF-signing, certificate-signing, or signature-validation claim');
  });
});
