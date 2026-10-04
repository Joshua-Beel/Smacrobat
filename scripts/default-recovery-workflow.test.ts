import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const workflowPath = '.github/workflows/default-recovery-verification.yml';
const verifierPath = 'scripts/verify-default-recovery.ps1';

function retainedPowerShell(body: string) {
  const root = join('target', 'default-recovery-contract-' + randomUUID());
  mkdirSync(root, { recursive: true });
  const path = join(root, 'contract.ps1');
  writeFileSync(path, body, 'utf8');
  try {
    return spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], { encoding: 'utf8', timeout: 60_000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function extractFunction(name: string, body: string) {
  const path = process.cwd().replaceAll("'", "''") + '\\' + verifierPath.replaceAll('/', '\\');
  return [
    "$ErrorActionPreference='Stop';Set-StrictMode -Version Latest",
    "$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile('" + path + "',[ref]$t,[ref]$e);if($e.Count){throw 'parse'}",
    "$n=$a.Find({param($x)$x-is[Management.Automation.Language.FunctionDefinitionAst]-and$x.Name-ceq'" + name + "'},$true);if(-not$n){throw 'missing'};Invoke-Expression $n.Extent.Text",
    body,
  ].join('\n');
}

it('is manual, candidate-bound, immutable-action pinned, and read-only to the repository', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  expect(workflow).toContain('name: Manual default installed recovery verification');
  expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m);
  for (const input of ['target_source_revision','target_release_id','installer_asset_id','installer_sha256','signature_asset_id','manifest_asset_id','draft_proof_run_id','draft_proof_workflow_id','draft_proof_artifact_id','draft_proof_workflow_revision','draft_proof_receipt_sha256']) expect(workflow).toContain(input + ':');
  expect(workflow.match(/contents:\s*read/g)?.length).toBe(1);
  expect(workflow).not.toMatch(/contents:\s*write|actions:\s*write|id-token:\s*write|secrets\.|AZURE_|TAURI_SIGNING|gh release|git push/);
  expect(workflow.match(/actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/g)?.length).toBe(2);
  expect(workflow).toContain('actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093');
  expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
});

it('parses and binds exact recovery sources, draft proof, candidate, token clearing, and retained roots', () => {
  const source = readFileSync(verifierPath, 'utf8');
  const command = "$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile('" + process.cwd().replaceAll("'", "''") + "\\scripts\\verify-default-recovery.ps1',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|% ToString;exit 1}";
  const parsed = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  expect(parsed.status, parsed.stderr || parsed.stdout).toBe(0);
  for (const path of ['src/App.tsx','src/RecoveryOfferDialog.tsx','src/recoveryErrors.ts','src/bridge.ts','src/Organizer.tsx','src-tauri/src/recovery_journal.rs','src-tauri/src/recovery_store.rs','src-tauri/src/recovery_commands.rs','src-tauri/src/service.rs','src-tauri/src/main.rs','src-tauri/tauri.conf.json','src-tauri/resources/welcome.pdf']) expect(source).toContain("'" + path + "'");
  for (const marker of ['Assert-Step1ArtifactMetadata','Assert-DefaultDraftReceipt','Assert-IndependentReceiptParity','Invoke-BoundedSilentInstaller','Assert-InstallFacts','Assert-InstalledDefaultResources','$env:GITHUB_TOKEN=$null','$env:GH_TOKEN=$null']) expect(source).toContain(marker);
  expect(source).not.toMatch(/Remove-Item|rmSync|Invoke-OwnedCleanup|silentUninstall|sessionDeleted=\$true/);
  expect(source).toContain('retained=[ordered]@{profiles=$true;settings=$true;fixtures=$true;results=$true}');
  expect(source).toContain("[IO.FileMode]::CreateNew");
  expect(source).toContain('$stream.Flush($true)');
});

it('requires acknowledged A, exact B recovery and rendered rotation, then clean C', () => {
  const source = readFileSync(verifierPath, 'utf8');
  for (const marker of ['Invoke-RecoveryPhaseA','Invoke-RecoveryPhaseB','Invoke-RecoveryPhaseC','Recovered edits are available','unsaved revision 1','Recovered edits are open. The source PDF was not changed.','renderedRotationVerified=$true','undoToClean=$true','staleOfferAbsent=$true']) expect(source).toContain(marker);
  expect(source).toContain('[int]$v.w-eq[int]$PhaseA.originalHeight');
  expect(source).toContain('[int]$v.h-eq[int]$PhaseA.originalWidth');
  for (const profile of ['profile-a','profile-b','profile-c']) expect(source).toContain("Join-Path $Work '" + profile + "'");
});

it('rejects tampered lifecycle receipts', () => {
  const body = [
    "function Good{[pscustomobject]@{a=[pscustomobject]@{editAcknowledged=$true;revision=1;currentPage=2;abruptTermination=$true;closeActionInvoked=$false};b=[pscustomobject]@{offerRevision=1;keepChosen=$true;recoveredCurrentPage=2;renderedRotationVerified=$true;undoToClean=$true;cleanTabClosed=$true};c=[pscustomobject]@{staleOfferAbsent=$true;cleanOriginal=$true;cleanTabClosed=$true};profilesRetained=$true}}",
    '$null=Assert-RecoveryRuntimeReceipt (Good)',
    "function Reject($v){$failed=$false;try{Assert-RecoveryRuntimeReceipt $v}catch{$failed=$true};if(-not$failed){throw 'tamper accepted'}}",
    '$v=Good;$v.a.closeActionInvoked=$true;Reject $v',
    '$v=Good;$v.a.revision=0;Reject $v',
    '$v=Good;$v.b.renderedRotationVerified=$false;Reject $v',
    '$v=Good;$v.c.staleOfferAbsent=$false;Reject $v',
    'Write-Output PASS',
  ].join('\n');
  const result = retainedPowerShell(extractFunction('Assert-RecoveryRuntimeReceipt', body));
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout).toContain('PASS');
});

it('force-terminates only a revalidated PID, creation time, and executable path', () => {
  const source = readFileSync(verifierPath, 'utf8');
  const fn = source.slice(source.indexOf('function Stop-ExactRecoveryApplication'), source.indexOf('function Open-RecoveryFixture'));
  expect(fn).toContain('Get-Process -Id $ProcessId');
  expect(fn).toContain('$p.StartTime.ToUniversalTime().Ticks-ne$ProcessStartUtcTicks');
  expect(fn).toContain('[IO.Path]::GetFullPath($p.Path)-cne[IO.Path]::GetFullPath($ApplicationPath)');
  expect(fn).toContain('$p.Kill($true)');
  expect(fn).not.toMatch(/Get-Process\s+-Name|taskkill|Stop-Process/);
});

it('emits only bounded controlled-fixture claims and retains all owned data', () => {
  const source = readFileSync(verifierPath, 'utf8');
  expect(source).toContain('[Text.Encoding]::UTF8.GetByteCount($json)-gt65536');
  for (const marker of ['powerLoss=$false','parentDirectorySync=$false','rollbackAttackResistance=$false','arbitraryPdf=$false','controlledFixture=$true']) expect(source).toContain(marker);
  expect(source).toContain('\\.smacrec');
  expect(source).not.toMatch(/journalPath|sourcePath|password|rawRuntime/);
});
