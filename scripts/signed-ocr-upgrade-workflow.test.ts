import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

function runPowerShell(source: string) {
  const root = `target/ocr-upgrade-test-script-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  const path = `${root}/run.ps1`;
  writeFileSync(path, source, 'utf8');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path], {
    encoding: 'utf8',
    timeout: 45_000,
  });
}

function workflowRunBlock(workflow: string, stepName: string) {
  const lines = workflow.split(/\r?\n/);
  const step = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (step < 0) throw new Error(`Missing workflow step: ${stepName}`);
  const run = lines.findIndex((line, index) => index > step && line.trim() === 'run: |');
  if (run < 0) throw new Error(`Missing run block: ${stepName}`);
  const body: string[] = [];
  for (let index = run + 1; index < lines.length; index += 1) {
    if (/^ {6}- (name:|uses:)/.test(lines[index])) break;
    if (lines[index] === '') break;
    if (!lines[index].startsWith('          ')) throw new Error(`Unexpected workflow indentation in ${stepName}`);
    body.push(lines[index].slice(10));
  }
  return `${body.join('\n')}\n`;
}

function functionHarness(names: string[], body: string) {
  return String.raw`
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
    . ./scripts/ocr/installer-package.ps1
    . ./scripts/ocr/windows-signing.ps1
    $scriptPath = (Resolve-Path ./scripts/verify-signed-ocr-upgrade.ps1).Path
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'Upgrade verifier did not parse.' }
    foreach ($name in @(${names.map((name) => `'${name}'`).join(',')})) {
      $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true)
      if (-not $function) { throw ('Missing verifier function: ' + $name) }
      Invoke-Expression $function.Extent.Text
    }
    $script:Pins = [ordered]@{
      Repository = 'Joshua-Beel/Smacrobat'
      BaselineName = 'PDF.Workstation_0.2.0_x64-setup.exe'
      BaselineBytes = [uint64]6418229
      BaselineSha256 = '17788CB82BB42DEAC35EA197A385A9BAFC8CD331422446A2B834E115A90C4D2E'
      SignedSourceRevision = '67d238218f4796ba7b8505d072868da0f397174a'
      SignedInstallerName = 'PDF Workstation_0.2.6_x64-setup.exe'
      SignedInstallerBytes = [uint64]10456616
      SignedInstallerSha256 = '8F7A167D1AED369D1A28B7C91692BAD8770E774FE9D8AFBBED970654144E428C'
      ExpectedPublisher = 'Joshua Beel'
    }
    ${body}
  `;
}

describe('manual signed OCR installer upgrade workflow', () => {
  it('uses an exact manual hosted-runner contract with step-scoped download credentials', () => {
    const workflow = readFileSync('.github/workflows/ocr-installer-upgrade.yml', 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m);
    expect(workflow).toContain('runs-on: windows-2022');
    expect(workflow).toContain('timeout-minutes: 45');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('actions: read');
    const jobHeader = workflow.slice(workflow.indexOf('jobs:'), workflow.indexOf('    steps:'));
    expect(jobHeader).not.toContain('${{ runner.temp }}');
    expect(jobHeader).not.toMatch(/^\s{4}env:/m);
    expect(workflow).toContain('- name: Initialize fresh runner paths');
    expect(workflow).toContain('$env:RUNNER_TEMP');
    expect(workflow).toContain('[IO.StreamWriter]::new($env:GITHUB_ENV, $true, [Text.UTF8Encoding]::new($false))');
    const initStep = workflow.slice(workflow.indexOf('- name: Initialize fresh runner paths'), workflow.indexOf('- uses: actions/checkout@v4'));
    expect(initStep).toContain('IsNullOrWhiteSpace($env:RUNNER_TEMP)');
    expect(initStep).toContain('IsNullOrWhiteSpace($env:GITHUB_ENV)');
    expect(initStep.match(/^[ ]{12}"(BASELINE_ROOT|SIGNED_ARTIFACT_ROOT|UPGRADE_WORK_ROOT|UPGRADE_OUTPUT_ROOT)=/gm)).toHaveLength(4);
    expect(workflow).toContain("$env:GITHUB_REPOSITORY -cne 'Joshua-Beel/Smacrobat'");
    expect(workflow).toContain("$env:GITHUB_REF -cne 'refs/heads/master'");
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('git diff --quiet --');
    expect(workflow).toContain('git diff --cached --quiet --');
    expect(workflow).toContain("Test-Path -LiteralPath $env:SIGNED_ARTIFACT_ROOT");
    expect(workflow).toContain('artifact-ids: \'11005152678\'');
    expect(workflow).toContain('run-id: \'36499724415\'');
    expect(workflow).toContain('merge-multiple: true');
    expect(workflow).toContain('[uint64]$artifact.size_in_bytes -ne 10437483');
    expect(workflow).toContain("digest -cne 'sha256:c0e89b5ae821d5875c31855c6596a7d47b7ca052468a026745a5d638e50ca569'");
    expect(workflow).toContain("head_sha -cne '67d238218f4796ba7b8505d072868da0f397174a'");
    expect(workflow).toContain("digest -cne 'sha256:17788cb82bb42deac35ea197a385a9bafc8cd331422446a2b834e115a90c4d2e'");
    expect(workflow).toContain("[uint64]$asset.size -ne 6418229");
    expect(workflow).not.toMatch(/secrets\.|AZURE_|TAURI_SIGNING|gh release|create.*release/i);

    const verifyStep = workflow.slice(workflow.indexOf('- name: Verify isolated silent install'), workflow.indexOf('- name: Upload only'));
    expect(verifyStep).not.toMatch(/github\.token|GITHUB_TOKEN|GH_TOKEN/);
    const uploadStep = workflow.slice(workflow.indexOf('- name: Upload only'));
    expect(uploadStep).toContain('/upgrade-verification.json');
    expect(uploadStep).not.toMatch(/\.exe|SIGNED_ARTIFACT_ROOT|BASELINE_ROOT|UPGRADE_WORK_ROOT/);
  });

  it('executes the exact path initialization block under PowerShell 7', () => {
    const workflow = readFileSync('.github/workflows/ocr-installer-upgrade.yml', 'utf8');
    const block = workflowRunBlock(workflow, 'Initialize fresh runner paths');
    const root = resolve(`target/ocr-upgrade-init-${randomUUID()}`);
    const runnerTemp = resolve(root, 'runner-temp');
    const githubEnv = resolve(root, 'github-env');
    mkdirSync(runnerTemp, { recursive: true });
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(block, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const bytes = readFileSync(githubEnv);
    expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8').trimEnd().split(/\r?\n/)).toEqual([
      `BASELINE_ROOT=${runnerTemp}\\pdf-workstation-baseline`,
      `SIGNED_ARTIFACT_ROOT=${runnerTemp}\\pdf-workstation-signed-artifact`,
      `UPGRADE_WORK_ROOT=${runnerTemp}\\pdf-workstation-upgrade-work`,
      `UPGRADE_OUTPUT_ROOT=${runnerTemp}\\pdf-workstation-upgrade-output`,
    ]);
  });

  it('keeps installer execution bounded, hidden, silent, and runner-only', () => {
    const script = readFileSync('scripts/verify-signed-ocr-upgrade.ps1', 'utf8');
    expect(script).toContain("runnerEnvironment -cne 'github-hosted'");
    expect(script).toContain("repository -cne $script:Pins.Repository");
    expect(script).toContain("imageOs -cne 'win22'");
    expect(script).toContain("ArgumentList.Add('/S')");
    expect(script).toContain('CreateNoWindow = $true');
    expect(script).toContain('WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden');
    expect(script).toContain('WaitForExit($TimeoutMilliseconds)');
    expect(script).toContain('Kill($true)');
    expect(script).toContain("Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PDF Workstation");
    expect(script).toContain("Join-Path $env:LOCALAPPDATA 'PDF Workstation'");
    expect(script).not.toMatch(/Start-Process|Remove-Item|\.Delete\(|uninstall\.exe['\"]?\s+\/S/i);
    expect(script).toContain('applicationProcessStarted = $false');
    expect(script).toContain('guiVerified = $false');
    expect(script).toContain('realPreferencesVerified = $false');
    expect(script).toContain('ocrExecutionVerified = $false');
    expect(script).toContain('inAppUpdaterVerified = $false');
  });

  it('rejects untrusted runner state, ambient credentials, and nonfresh machines', () => {
    const check = functionHarness(
      ['Assert-ExactProperties', 'Assert-HostedRunnerFacts', 'Assert-FreshInstallFacts'],
      String.raw`
        $facts = [pscustomobject]@{
          githubActions='true'; runnerEnvironment='github-hosted'; runnerOs='Windows'; imageOs='win22'
          eventName='workflow_dispatch'; ref='refs/heads/master'; repository='Joshua-Beel/Smacrobat'
          githubSha=('a' * 40); headSha=('a' * 40); trackedClean=$true; indexClean=$true
          githubTokenPresent=$false; ghTokenPresent=$false; ambientSigningConfigurationPresent=$false
        }
        Assert-HostedRunnerFacts -Facts $facts
        foreach ($mutation in @(
          @{name='repository';value='someone/fork'}, @{name='runnerEnvironment';value='self-hosted'},
          @{name='trackedClean';value=$false}, @{name='indexClean';value=$false},
          @{name='githubTokenPresent';value=$true}, @{name='ambientSigningConfigurationPresent';value=$true}
        )) {
          $copy = $facts.PSObject.Copy(); $copy.($mutation.name) = $mutation.value
          $rejected=$false; try { Assert-HostedRunnerFacts -Facts $copy } catch { $rejected=$true }
          if (-not $rejected) { throw ('Unsafe runner mutation was accepted: ' + $mutation.name) }
        }
        $fresh=[pscustomobject]@{registryPresent=$false;installRootPresent=$false;settingsRootPresent=$false;applicationProcessPresent=$false;installerProcessPresent=$false}
        Assert-FreshInstallFacts -Facts $fresh
        foreach($name in $fresh.PSObject.Properties.Name) {
          $copy=$fresh.PSObject.Copy(); $copy.$name=$true
          $rejected=$false; try { Assert-FreshInstallFacts -Facts $copy } catch { $rejected=$true }
          if(-not $rejected){throw ('Nonfresh machine state was accepted: '+$name)}
        }
      `,
    );
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects malformed signed receipts and validates the exact five OCR roles', () => {
    const check = functionHarness(
      ['Assert-ExactProperties', 'Assert-ReceiptValue', 'Assert-SignedArtifactReceipt'],
      String.raw`
        function New-Value { param([string]$Sha=('A'*64)); [pscustomobject]@{bytes=[uint64]1;sha256=$Sha} }
        $base=@()
        for($i=0;$i -lt 25;$i++){$base += [pscustomobject]@{target=('resources/base/file-'+$i+'.txt');bytes=[uint64]1;sha256=('A'*64)}}
        $base += [pscustomobject]@{target='resources/pdfium/bin/pdfium.dll';bytes=[uint64]2;sha256=('B'*64);unsignedBytes=[uint64]1;unsignedSha256=('C'*64)}
        $ocr=@(
          [pscustomobject]@{suffix='bin/tesseract.exe';role='engine';bytes=[uint64]1;sha256=('D'*64)},
          [pscustomobject]@{suffix='tessdata/eng.traineddata';role='model';bytes=[uint64]1;sha256=('E'*64)},
          [pscustomobject]@{suffix='licenses/Tesseract-Apache-2.0.txt';role='license';bytes=[uint64]1;sha256=('F'*64)},
          [pscustomobject]@{suffix='licenses/Leptonica-BSD-2-Clause.txt';role='license';bytes=[uint64]1;sha256=('1'*64)},
          [pscustomobject]@{suffix='licenses/eng-fast-Apache-2.0.txt';role='license';bytes=[uint64]1;sha256=('2'*64)}
        )
        $receipt=[pscustomobject]@{
          schemaVersion=1;scope='Manual artifact-only signed OCR installer verification; no installation, launch, update, or release behavior is established.'
          mode='azure-signed-artifact-only-ocr';sourceRevision=$script:Pins.SignedSourceRevision
          installer=[pscustomobject]@{fileName=$script:Pins.SignedInstallerName;bytes=$script:Pins.SignedInstallerBytes;sha256=$script:Pins.SignedInstallerSha256}
          packagedApplication=(New-Value);baseResources=$base
          ocr=[pscustomobject]@{originalEngine=(New-Value);packagedResources=$ocr;licensesArePackagedSidecarsNotNoticeDialogContent=$true}
          signatures=[pscustomobject]@{expectedPublisher=$script:Pins.ExpectedPublisher;installer='Valid';application='Valid';engine='Valid';pdfium='Valid';originalEngine='NotSigned';trustedTimestampsRequired=$true}
          verification=[pscustomobject]@{archiveInventory=(New-Value);extractedResourcesMatched=$true;bundleContainsOnlyInstaller=$true;updaterArtifacts=@();ephemeralSigningConfigurationRetained=$false}
        }
        $sets=Assert-SignedArtifactReceipt -Receipt $receipt
        if($sets.Base.Count -ne 26 -or $sets.Ocr.Count -ne 5){throw 'Valid exact receipt failed.'}
        $wrong=$receipt.PSObject.Copy();$wrong.sourceRevision=('9'*40)
        $rejected=$false;try{Assert-SignedArtifactReceipt -Receipt $wrong}catch{$rejected=$true};if(-not $rejected){throw 'Wrong source revision accepted.'}
        $wrong=$receipt.PSObject.Copy();$wrong.ocr=$receipt.ocr.PSObject.Copy();$wrong.ocr.packagedResources=@($ocr[0..3])
        $rejected=$false;try{Assert-SignedArtifactReceipt -Receipt $wrong}catch{$rejected=$true};if(-not $rejected){throw 'Incomplete OCR receipt accepted.'}
        $wrong=$receipt.PSObject.Copy();$wrong.signatures=$receipt.signatures.PSObject.Copy();$wrong.signatures.expectedPublisher='Wrong Publisher'
        $rejected=$false;try{Assert-SignedArtifactReceipt -Receipt $wrong}catch{$rejected=$true};if(-not $rejected){throw 'Wrong publisher accepted.'}
        $wrong=$receipt.PSObject.Copy();$wrong.verification=$receipt.verification.PSObject.Copy();$wrong.verification.bundleContainsOnlyInstaller='true'
        $rejected=$false;try{Assert-SignedArtifactReceipt -Receipt $wrong}catch{$rejected=$true};if(-not $rejected){throw 'Malformed Boolean accepted.'}
      `,
    );
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('accepts only the receipt-bound payload and proven 7-Zip 24 or 26 NSIS inventory', () => {
    const check = functionHarness(
      ['Assert-ExtractedInstallerInventory'],
      String.raw`
        $target=(Resolve-Path target).Path
        $identity=('B'*64).ToLowerInvariant()
        $receipt=[pscustomobject]@{ocr=[pscustomobject]@{originalEngine=[pscustomobject]@{sha256=('A'*64)}}}
        $sets=[pscustomobject]@{
          Base=@([pscustomobject]@{target='resources/base/a.txt'},[pscustomobject]@{target='resources/base/b.txt'})
          Ocr=@([pscustomobject]@{suffix='bin/tesseract.exe'},[pscustomobject]@{suffix='tessdata/eng.traineddata'})
          Engine=[pscustomobject]@{sha256=('B'*64)}
        }
        $required=@(
          'pdf-workstation.exe','resources/base/a.txt','resources/base/b.txt',
          ('resources/ocr/'+$identity+'/bin/tesseract.exe'),('resources/ocr/'+$identity+'/tessdata/eng.traineddata'),
          '$PLUGINSDIR/modern-wizard.bmp','$PLUGINSDIR/nsDialogs.dll','$PLUGINSDIR/nsis_tauri_utils.dll',
          '$PLUGINSDIR/NSISdl.dll','$PLUGINSDIR/StartMenu.dll','$PLUGINSDIR/System.dll'
        )
        function New-Inventory {
          param([string]$Name,[bool]$IncludeUninstaller=$false,[string]$Extra,[string]$Omit)
          $root=Join-Path $target ($Name+'-'+[Guid]::NewGuid().ToString('N'))
          [IO.Directory]::CreateDirectory($root)|Out-Null
          foreach($relative in $required){
            if($relative -ceq $Omit){continue}
            $path=Join-Path $root $relative
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null
            [IO.File]::WriteAllText($path,'fixture',[Text.UTF8Encoding]::new($false))
          }
          if($IncludeUninstaller){[IO.File]::WriteAllText((Join-Path $root 'uninstall.exe'),'fixture',[Text.UTF8Encoding]::new($false))}
          if($Extra){
            $path=Join-Path $root $Extra
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null
            [IO.File]::WriteAllText($path,'fixture',[Text.UTF8Encoding]::new($false))
          }
          return [pscustomobject]@{Root=$root;Files=@(Get-ChildItem -LiteralPath $root -Recurse -File -Force)}
        }
        $v24=New-Inventory -Name 'v24'
        Assert-ExtractedInstallerInventory -Files $v24.Files -ExtractionRoot $v24.Root -Receipt $receipt -ReceiptSets $sets
        $v26=New-Inventory -Name 'v26' -IncludeUninstaller $true
        Assert-ExtractedInstallerInventory -Files $v26.Files -ExtractionRoot $v26.Root -Receipt $receipt -ReceiptSets $sets
        foreach($case in @(
          (New-Inventory -Name 'extra-root' -Extra 'surprise.exe'),
          (New-Inventory -Name 'extra-plugin' -Extra '$PLUGINSDIR/surprise.dll'),
          (New-Inventory -Name 'updater-json' -Extra 'latest.json'),
          (New-Inventory -Name 'updater-signature' -Extra 'setup.SIG'),
          (New-Inventory -Name 'missing' -Omit '$PLUGINSDIR/System.dll')
        )){
          $rejected=$false;try{Assert-ExtractedInstallerInventory -Files $case.Files -ExtractionRoot $case.Root -Receipt $receipt -ReceiptSets $sets}catch{$rejected=$true}
          if(-not $rejected){throw 'Unsafe or incomplete extracted inventory was accepted.'}
        }
      `,
    );
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('enforces bounded process and installed-registry facts and writes one sanitized record', () => {
    const check = functionHarness(
      ['Assert-ExactProperties', 'Invoke-BoundedSilentInstaller', 'Assert-InstallFacts', 'Write-SanitizedUpgradeRecord'],
      String.raw`
        $called=$false
        $provider={param($path,$arguments,$timeout)$script:called=$true;if($arguments -cne '/S' -or $timeout -ne 1234){throw 'Process provider contract changed.'};[pscustomobject]@{TimedOut=$false;ExitCode=[int]0}}
        Invoke-BoundedSilentInstaller -Path 'fixture.exe' -TimeoutMilliseconds 1234 -ProcessProvider $provider
        if(-not $called){throw 'Bounded provider was not invoked.'}
        foreach($bad in @([pscustomobject]@{TimedOut=$true;ExitCode=[int]0},[pscustomobject]@{TimedOut=$false;ExitCode=[int]1})){
          $rejected=$false;try{Invoke-BoundedSilentInstaller -Path 'fixture.exe' -ProcessProvider {param($p,$a,$t)$bad}.GetNewClosure()}catch{$rejected=$true};if(-not $rejected){throw 'Unsafe process result accepted.'}
        }
        $root=[IO.Path]::GetFullPath((Join-Path (Resolve-Path target) 'mock-install'))
        $facts=[pscustomobject]@{displayName='PDF Workstation';displayVersion='0.2.6';installLocation=$root;uninstallPath=(Join-Path $root 'uninstall.exe');appBytes=[uint64]10;appSha256=('A'*64);fileVersion='0.2.6';productVersion='0.2.6';signatureStatus='Valid';publisher='Joshua Beel';hasTimestamp=$true}
        $app=[pscustomobject]@{bytes=[uint64]10;sha256=('A'*64)}
        Assert-InstallFacts -Facts $facts -ExpectedVersion '0.2.6' -ExpectedInstallRoot $root -ExpectedApplication $app -ExpectedSignatureStatus 'Valid' -ExpectedPublisher 'Joshua Beel' -ExpectedTimestamp $true
        $wrong=$facts.PSObject.Copy();$wrong.uninstallPath=(Join-Path $root 'other.exe')
        $rejected=$false;try{Assert-InstallFacts -Facts $wrong -ExpectedVersion '0.2.6' -ExpectedInstallRoot $root -ExpectedApplication $app -ExpectedSignatureStatus 'Valid' -ExpectedPublisher 'Joshua Beel' -ExpectedTimestamp $true}catch{$rejected=$true};if(-not $rejected){throw 'Wrong uninstall registry value accepted.'}
        $output=Join-Path (Resolve-Path target) ('ocr-upgrade-output-'+[Guid]::NewGuid().ToString('N'))
        $receipt=[pscustomobject]@{packagedApplication=$app}
        $path=Write-SanitizedUpgradeRecord -OutputRoot $output -WorkflowSourceRevision ('b'*40) -Receipt $receipt
        $json=Get-Content -LiteralPath $path -Raw -Encoding UTF8
        $value=$json|ConvertFrom-Json
        if(@(Get-ChildItem -LiteralPath $output -File -Force).Count -ne 1 -or $value.verification.guiVerified -ne $false -or $value.verification.realPreferencesVerified -ne $false -or $value.verification.ocrExecutionVerified -ne $false -or $value.verification.inAppUpdaterVerified -ne $false){throw 'Sanitized output contract failed.'}
        if($json -match '(?i)([A-Z]:\\|\\Users\\|11005152678|36499724415|569181842|GITHUB_TOKEN|AZURE_)'){throw 'Sanitized output leaked restricted evidence.'}
      `,
    );
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
