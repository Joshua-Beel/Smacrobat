import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const scriptPath = 'scripts/default-comments-forms-native-evidence.ps1';

describe('comments and forms native evidence', () => {
  it('pins six exact native acceptance tests and keeps installed evidence explicit', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const names = [
      'comments::tests::comments_undo_redo_saved_baseline_noops_and_source_remain_consistent',
      'service::tests::comments_rotations_inherited_crop_pixels_unicode_reopen_and_print_snapshots_agree',
      'service::tests::highlights_all_rotations_inherited_crop_multiply_pixels_unicode_reopen_and_print_isolation',
      'service::tests::text_highlights_multiline_unicode_all_rotations_crops_pixels_reopen_and_print_isolation',
      'service::tests::forms_reportlab_engine_crops_rotations_values_print_and_source_preservation',
      'forms::tests::forms_reportlab_values_appearances_and_styles_round_trip_and_clear',
    ];
    for (const name of names) expect(source).toContain(`name='${name}'`);
    expect(source).toContain("@('test','--locked','--manifest-path',$manifest,$test.name,'--','--exact','--test-threads=1')");
    expect(source).toContain('if ($TestTimeoutMilliseconds -lt 1000 -or $TestTimeoutMilliseconds -gt 900000)');
    expect(source).toContain('Native test output exceeded its fixed cap.');
    expect(source).toContain("status --porcelain=v1 --untracked-files=all -- Cargo.lock src-tauri");
    expect(source).toContain("PDF_WORKSTATION_OCR_SETUP_ROOT");
    expect(source).toContain("trackedInputOverrides = $overrides");
    expect(source).toContain('Assert-NoReparseAncestors -Path $pdfiumPath -StopAt $resolvedRoot');
    expect(source).toContain("src-tauri\\resources\\pdfium\\bin\\pdfium.dll");
    expect(source).toContain('areaHighlights = [pscustomobject][ordered]@{ savedSemantic=$true; renderedAppearance=$true; reopen=$true; undo=$true; redo=$true;');
    expect(source).toContain('selectedTextHighlights = [pscustomobject][ordered]@{ savedSemantic=$true; renderedAppearance=$true; multilineUnicode=$true; reopen=$true; undo=$true; redo=$true;');
    expect(source).toContain('installedApplicationVerified=$false');
    expect(source).toContain('nativeDesktopInteractionVerified=$false');
    expect(source).toContain('arbitraryPdfCompatibilityVerified=$false');
  });

  it('requires an exact one-test Cargo success footer', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('test $Name ... ok');
    expect(source).toContain("test result: ok\\. 1 passed; 0 failed;");
    expect(source).not.toMatch(/Invoke-Expression|Start-Process|cargo build|cargo run|--release/);
  });

  it('parses as PowerShell', () => {
    const absolute = join(process.cwd(), scriptPath).replaceAll("'", "''");
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile('${absolute}',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|% ToString;exit 1}`], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects a non-exact fake Cargo footer and accepts the exact six-test sequence', () => {
    const root = join(process.cwd(), 'target', `smacrobat-native-evidence-${randomUUID()}`);
    const project = join(root, 'project'); const output = join(root, 'receipt.json');
    mkdirSync(join(project, 'src-tauri', 'src'), { recursive: true });
    mkdirSync(join(project, 'src-tauri', 'resources', 'pdfium', 'bin'), { recursive: true });
    writeFileSync(join(project, 'src-tauri', 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.0.0"\n', 'utf8');
    writeFileSync(join(project, 'Cargo.lock'), '# fixture\n', 'utf8');
    writeFileSync(join(project, 'src-tauri', 'build.rs'), 'fn main() {}\n', 'utf8');
    mkdirSync(join(project, 'src-tauri', 'tests', 'fixtures'), { recursive: true });
    writeFileSync(join(project, 'src-tauri', 'tests', 'fixtures', 'fixture.pdf'), 'fixture', 'utf8');
    writeFileSync(join(project, 'src-tauri', 'resources', 'welcome.pdf'), 'fixture-welcome', 'utf8');
    writeFileSync(join(project, 'src-tauri', 'resources', 'pdfium', 'bin', 'pdfium.dll'), 'fixture-engine', 'utf8');
    for (const name of ['comments.rs', 'forms.rs', 'service.rs']) writeFileSync(join(project, 'src-tauri', 'src', name), '', 'utf8');
    const fake = join(root, 'cargo.cmd');
    writeFileSync(fake, '@echo off\r\necho test %5 ... ok\r\nif "%SMACROBAT_BAD_FOOTER%"=="1" (echo test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s) else (echo test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s)\r\n', 'utf8');
    try {
      for (const args of [['init'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']]) {
        const result = spawnSync('git', args, { cwd: project, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
      }
      const command = ['-NoProfile', '-NonInteractive', '-File', join(process.cwd(), scriptPath), '-ProjectRoot', project, '-OutputPath', output, '-CargoPath', fake, '-TestTimeoutMilliseconds', '10000'];
      const rejected = spawnSync('pwsh.exe', command, { encoding: 'utf8', timeout: 90_000, env: { ...process.env, SMACROBAT_BAD_FOOTER:'1' } });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('exact native evidence test footer was missing');
      expect(existsSync(output)).toBe(false);
      const result = spawnSync('pwsh.exe', command, { encoding: 'utf8', timeout: 90_000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const receipt = JSON.parse(readFileSync(output, 'utf8'));
      expect(receipt.exactTestCount).toBe(6);
      expect(receipt.exactTestsPassed).toEqual(['comments-undo','sticky-render','area-highlight-render','selected-text-render','forms-engine','forms-round-trip']);
      expect(receipt.limitations).toEqual({ installedApplicationVerified:false, nativeDesktopInteractionVerified:false, arbitraryPdfCompatibilityVerified:false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 100_000);
});
