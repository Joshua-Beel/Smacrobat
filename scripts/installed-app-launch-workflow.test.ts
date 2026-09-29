import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function runPowerShell(source: string) {
  const root = `target/installed-launch-test-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  const path = `${root}/run.ps1`;
  writeFileSync(path, source, 'utf8');
  return spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], {
    encoding: 'utf8', timeout: 60_000,
  });
}

function extractFunctions(script: string, names: string[], body: string) {
  return String.raw`
    $ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
    Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
    . ./scripts/ocr/installer-package.ps1
    . ./scripts/ocr/windows-signing.ps1
    foreach($pair in @(${script.split(',').map((path) => `'${path}'`).join(',')})) {
      $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $pair),[ref]$tokens,[ref]$errors)
      if($errors.Count){throw ('Script did not parse: '+$pair)}
      foreach($name in @(${names.map((name) => `'${name}'`).join(',')})) {
        $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq$name},$true)
        if($function){Invoke-Expression $function.Extent.Text}
      }
    }
    ${body}
  `;
}

describe('hosted installed signed application launch proof', () => {
  it('keeps the workflow manual, runner-only, token-scoped, and clean after driver preparation', () => {
    const workflow = readFileSync('.github/workflows/ocr-installer-upgrade.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('runs-on: windows-2022');
    expect(workflow).toContain('timeout-minutes: 45');
    expect(workflow).toContain('./scripts/setup-installed-app-webdriver.ps1 -OutputRoot $env:WEBDRIVER_ROOT');
    const setup = workflow.slice(workflow.indexOf('- name: Prepare exact hosted WebDriver inputs'), workflow.indexOf('- name: Recheck clean source after driver preparation'));
    expect(setup).not.toMatch(/GITHUB_TOKEN|github\.token|secrets\./);
    const recheck = workflow.slice(workflow.indexOf('- name: Recheck clean source after driver preparation'), workflow.indexOf('- name: Download the exact published'));
    expect(recheck).toContain('git rev-parse HEAD');
    expect(recheck).toContain('git diff --quiet --');
    expect(recheck).toContain('git diff --cached --quiet --');
    expect(workflow.indexOf('- name: Recheck clean source after driver preparation')).toBeLessThan(workflow.indexOf('GITHUB_TOKEN: ${{ github.token }}'));
    expect(workflow).not.toMatch(/secrets\.|AZURE_|TAURI_SIGNING|gh release|create.*release/i);
  });

  it('pins official driver supply chain, archive bounds, isolated Cargo state, and signatures', () => {
    const setup = readFileSync('scripts/setup-installed-app-webdriver.ps1', 'utf8');
    expect(setup).toContain("TauriDriverVersion = '2.0.6'");
    expect(setup).toContain("TauriDriverPackageSha256 = '24DC39BD26A65361C1C8E067636BBFF1D9DD7E2FC58FF874EDFBA33ACAB0E6D0'");
    expect(setup).toContain("TauriDriverPackageOrigin = 'static.crates.io'");
    expect(setup).toContain("EdgeDriverDownloadOrigins = @('msedgedriver.microsoft.com','msedgewebdriverstorage.blob.core.windows.net')");
    expect(setup).toContain('$response.RequestMessage.RequestUri');
    expect(setup).toContain('Assert-SafeCrateEntries');
    expect(setup).toContain("$_[0] -notin @('-','d')");
    expect(setup).toContain('[IO.FileAttributes]::ReparsePoint');
    expect(setup).toContain("$shape -match '/\\.cargo/config(?:\\.toml)?$'");
    expect(setup).toContain("Push-Location -LiteralPath $Source");
    expect(setup).toContain("@('install','--path','.','--locked','--root',$InstallRoot)");
    expect(setup).toContain("EdgePublisher = 'Microsoft Corporation'");
    expect(setup).not.toMatch(/Remove-Item|\.Delete\(|Start-Process/);
  });

  it('rejects unsafe crate paths, extracted reparses, and repository Cargo configuration inheritance', () => {
    const source = extractFunctions(
      'scripts/setup-installed-app-webdriver.ps1',
      ['Assert-SafeCrateEntries', 'Assert-ExtractedCrateTree', 'Invoke-IsolatedCargoInstall'],
      String.raw`
        $script:DriverPins=[ordered]@{TauriDriverVersion='2.0.6'}
        Assert-SafeCrateEntries -Entries @('tauri-driver-2.0.6/Cargo.toml','tauri-driver-2.0.6/Cargo.lock','tauri-driver-2.0.6/src/main.rs')
        foreach($bad in @(
          @('tauri-driver-2.0.6/Cargo.toml','tauri-driver-2.0.6/Cargo.lock','tauri-driver-2.0.6/../escape'),
          @('tauri-driver-2.0.6/Cargo.toml','tauri-driver-2.0.6/Cargo.lock','tauri-driver-2.0.6/src/main.rs','tauri-driver-2.0.6/.cargo/config.toml')
        )){$rejected=$false;try{Assert-SafeCrateEntries -Entries $bad}catch{$rejected=$true};if(-not$rejected){throw 'Unsafe crate entry accepted.'}}
        $root=Join-Path (Resolve-Path target) ('crate-tree-'+[Guid]::NewGuid().ToString('N'));$source=Join-Path $root 'source';$outside=Join-Path $root 'outside'
        [IO.Directory]::CreateDirectory($source)|Out-Null;[IO.Directory]::CreateDirectory($outside)|Out-Null
        New-Item -ItemType Junction -Path (Join-Path $source 'link') -Target $outside|Out-Null
        $rejected=$false;try{Assert-ExtractedCrateTree -Source $source}catch{$rejected=$true};if(-not$rejected){throw 'Extracted reparse point accepted.'}
        $hostile=Join-Path $root 'hostile-repo';$cargoFolder=Join-Path $hostile '.cargo';[IO.Directory]::CreateDirectory($cargoFolder)|Out-Null
        [IO.File]::WriteAllText((Join-Path $cargoFolder 'config.toml'),'[source.crates-io] replace-with="hostile"',[Text.UTF8Encoding]::new($false))
        $cleanSource=Join-Path $root 'clean-source';[IO.Directory]::CreateDirectory($cleanSource)|Out-Null
        $cargoHome=Join-Path $root 'cargo-home';$install=Join-Path $root 'install';$marker=Join-Path $root 'cargo-provider-called'
        Push-Location $hostile
        try{Invoke-IsolatedCargoInstall -Cargo 'cargo.exe' -Source $cleanSource -InstallRoot $install -CargoHome $cargoHome -ProcessProvider {param($cargo,$arguments)[IO.File]::WriteAllText($marker,'called');if(-not(Get-Location).Path.Equals($cleanSource,[StringComparison]::OrdinalIgnoreCase)-or$env:CARGO_HOME-cne$cargoHome-or($arguments-join ' ')-cne'install --path . --locked --root '+$install){throw 'Cargo isolation contract changed.'};0}.GetNewClosure()}finally{Pop-Location}
        if(-not(Test-Path -LiteralPath $marker -PathType Leaf)){throw 'Isolated Cargo provider was not invoked.'}
      `,
    );
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects EdgeDriver archive traversal and duplicate canonical executables', () => {
    const source = extractFunctions('scripts/setup-installed-app-webdriver.ps1', ['Expand-ExactEdgeDriver'], String.raw`
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $script:DriverPins=[ordered]@{MaximumEdgeEntries=16;MaximumEdgeArchiveBytes=32MB;MaximumEdgeExpandedBytes=64MB}
      $root=Join-Path (Resolve-Path target) ('edge-archive-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($root)|Out-Null
      function New-TestArchive([string]$path,[string[]]$names){$zip=[IO.Compression.ZipFile]::Open($path,[IO.Compression.ZipArchiveMode]::Create);try{foreach($name in $names){$entry=$zip.CreateEntry($name);$stream=$entry.Open();try{$stream.WriteByte(1)}finally{$stream.Dispose()}}}finally{$zip.Dispose()}}
      foreach($case in @(
        [pscustomobject]@{name='traversal';entries=@('../msedgedriver.exe')},
        [pscustomobject]@{name='duplicate';entries=@('msedgedriver.exe','msedgedriver.exe')}
      )){$archive=Join-Path $root ($case.name+'.zip');New-TestArchive $archive $case.entries;$rejected=$false;try{Expand-ExactEdgeDriver -Archive $archive -Destination (Join-Path $root $case.name)|Out-Null}catch{$rejected=$true};if(-not$rejected){throw ('Unsafe EdgeDriver archive accepted: '+$case.name)}}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('requires exact driver receipt origins, toolchain versions, runtime matching, and Microsoft trust', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Assert-LaunchExactProperties', 'Assert-LaunchReceiptValue', 'Assert-WebDriverReceipt'], String.raw`
      $script:LaunchPins=[ordered]@{TauriDriverVersion='2.0.6';TauriDriverPackageSha256='24DC39BD26A65361C1C8E067636BBFF1D9DD7E2FC58FF874EDFBA33ACAB0E6D0';EdgePublisher='Microsoft Corporation'}
      $receipt=[pscustomobject]@{schemaVersion=1;tauriDriverSource=[pscustomobject]@{version='2.0.6';origin='static.crates.io';bytes=[uint64]1;sha256=$script:LaunchPins.TauriDriverPackageSha256};tauriDriver=[pscustomobject]@{version='2.0.6';cargoVersion='cargo 1.91.0 (abc 2026-01-01)';rustcVersion='rustc 1.91.0 (abc 2026-01-01)';bytes=[uint64]2;sha256=('A'*64)};webView2RuntimeVersion='151.0.4129.50';edgeDriverArchive=[pscustomobject]@{origin='msedgedriver.microsoft.com';bytes=[uint64]3;sha256=('B'*64)};edgeDriver=[pscustomobject]@{version='151.0.4129.78';bytes=[uint64]4;sha256=('C'*64);signatureStatus='Valid';publisher='Microsoft Corporation';hasTimestamp=$true}}
      Assert-WebDriverReceipt $receipt
      foreach($mutation in @('origin','runtime','publisher')){$copy=$receipt|ConvertTo-Json -Depth 8|ConvertFrom-Json;if($mutation-eq'origin'){$copy.edgeDriverArchive.origin='example.invalid'}elseif($mutation-eq'runtime'){$copy.edgeDriver.version='150.0.1.1'}else{$copy.edgeDriver.publisher='Someone'};$rejected=$false;try{Assert-WebDriverReceipt $copy}catch{$rejected=$true};if(-not$rejected){throw ('Unsafe receipt accepted: '+$mutation)}}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('binds the live native-driver status and fresh profile when vendor capabilities are absent', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Assert-NativeDriverStatus', 'Wait-NativeDriverStatus', 'Get-ExactProfileBinding', 'Get-OwnedProfileBinding', 'Assert-OwnedLaunchExecutables'], String.raw`
      $version='151.0.4129.78';$status=[pscustomobject]@{value=[pscustomobject]@{ready=$true;build=[pscustomobject]@{version=($version+' (trusted-build)')}}}
      if((Assert-NativeDriverStatus -Status $status -ExpectedVersion $version)-cne$version){throw 'Native status version was not bound.'}
      foreach($bad in @(
        [pscustomobject]@{value=[pscustomobject]@{ready=$true;build=[pscustomobject]@{version='150.0.1.1'}}},
        [pscustomobject]@{value=[pscustomobject]@{ready=$false;build=[pscustomobject]@{version=$version}}},
        [pscustomobject]@{value=[pscustomobject]@{ready=$true}}
      )){$rejected=$false;try{Assert-NativeDriverStatus -Status $bad -ExpectedVersion $version}catch{$rejected=$true};if(-not$rejected){throw 'Unsafe native status accepted.'}}
      $responses=[Collections.Generic.Queue[object]]::new();$responses.Enqueue('not-ready');$responses.Enqueue($status);$provider={param($deadline)$next=$responses.Dequeue();if($next-is[string]){throw $next};$next}.GetNewClosure()
      if((Wait-NativeDriverStatus -ExpectedVersion $version -Deadline ([datetime]::UtcNow.AddSeconds(2)) -TauriDriver ([pscustomobject]@{HasExited=$false}) -StatusProvider $provider)-cne$version-or$responses.Count-ne0){throw 'Native readiness retry changed.'}
      $profile=Join-Path (Resolve-Path target) ('profile-binding-'+[Guid]::NewGuid().ToString('N'));$settings=Join-Path (Resolve-Path target) ('settings-binding-'+[Guid]::NewGuid().ToString('N'));$applicationProfile=Join-Path $settings 'EBWebView'
      if((Get-ExactProfileBinding -Candidate $profile -RequestedProfile $profile -SettingsRoot $settings)-cne'requested-profile'){throw 'Exact requested profile was not bound.'}
      if((Get-ExactProfileBinding -Candidate $applicationProfile -RequestedProfile $profile -SettingsRoot $settings)-cne'tauri-app-settings-ebwebview'){throw 'Exact Tauri application profile was not bound.'}
      $requestedWebView=Join-Path $profile 'EBWebView';if((Get-ExactProfileBinding -Candidate $requestedWebView -RequestedProfile $profile -SettingsRoot $settings)-cne'requested-ebwebview'){throw 'Exact evidence-backed requested EBWebView profile was not bound.'}
      foreach($otherRequested in @((Join-Path $profile 'Other'),(Join-Path $profile 'Nested/Child'),(Join-Path $profile 'ebwebview'))){$rejected=$false;try{Get-ExactProfileBinding -Candidate $otherRequested -RequestedProfile $profile -SettingsRoot $settings}catch{$rejected=$true;if($_.Exception.Message-cnotmatch "relation 'requested-root-other'"-or$_.Exception.Message-match[regex]::Escape($otherRequested)){throw 'Generic requested-root relation diagnostic changed or leaked a path.'}};if(-not$rejected){throw 'Sibling, nested, or wrong-case requested-root descendant was accepted.'}}
      foreach($badProfile in @($settings,(Join-Path $settings 'Other'),'C:\wrong')){$rejected=$false;try{Get-ExactProfileBinding -Candidate $badProfile -RequestedProfile $profile -SettingsRoot $settings}catch{$rejected=$true;if($_.Exception.Message-match[regex]::Escape($badProfile)){throw 'Profile mismatch diagnostic leaked a path.'}};if(-not$rejected){throw 'Inexact controlled profile was accepted.'}}
      $owned=@([pscustomobject]@{Path='C:\Program Files (x86)\Microsoft\EdgeWebView\Application\msedgewebview2.exe';CommandLine=('msedgewebview2.exe --user-data-dir="'+$applicationProfile+'" --type=renderer')},[pscustomobject]@{Path='C:\Program Files (x86)\Microsoft\EdgeWebView\Application\msedgewebview2.exe';CommandLine='msedgewebview2.exe --type=gpu-process'})
      if((Get-OwnedProfileBinding -Owned $owned -RequestedProfile $profile -SettingsRoot $settings)-cne'owned-webview-tauri-app-settings-ebwebview'){throw 'Owned Tauri profile was not bound.'}
      foreach($badOwned in @(@(),@([pscustomobject]@{Path='C:\msedgewebview2.exe';CommandLine='msedgewebview2.exe --type=renderer'}),@([pscustomobject]@{Path='C:\msedgewebview2.exe';CommandLine='msedgewebview2.exe --user-data-dir=C:\wrong'}),@([pscustomobject]@{Path='C:\msedgewebview2.exe';CommandLine=('msedgewebview2.exe --user-data-dir="'+$profile+'" --user-data-dir="'+$profile+'"')}),@([pscustomobject]@{Path='C:\msedgewebview2.exe';CommandLine=('msedgewebview2.exe --user-data-dir="'+$profile+'"')},[pscustomobject]@{Path='C:\msedgewebview2.exe';CommandLine=('msedgewebview2.exe --user-data-dir="'+$applicationProfile+'"')}))){$rejected=$false;try{Get-OwnedProfileBinding -Owned $badOwned -RequestedProfile $profile -SettingsRoot $settings}catch{$rejected=$true};if(-not$rejected){throw 'Missing, wrong, duplicate, or inconsistent owned profile evidence accepted.'}}
      $app=Join-Path $profile 'pdf-workstation.exe';$edge=Join-Path $profile 'msedgedriver.exe';$executables=@([pscustomobject]@{Path=$app},[pscustomobject]@{Path=$edge})
      Assert-OwnedLaunchExecutables -Owned $executables -ApplicationPath $app -EdgeDriverPath $edge
      foreach($badExecutables in @(@([pscustomobject]@{Path=$app},[pscustomobject]@{Path='C:\wrong\msedgedriver.exe'}),@([pscustomobject]@{Path=$app},[pscustomobject]@{Path=$edge},[pscustomobject]@{Path=$edge}))){$rejected=$false;try{Assert-OwnedLaunchExecutables -Owned $badExecutables -ApplicationPath $app -EdgeDriverPath $edge}catch{$rejected=$true};if(-not$rejected){throw 'Wrong or duplicate owned EdgeDriver accepted.'}}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('validates exact UI/runtime/cleanup results before producing sanitized launch evidence', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Assert-LaunchExactProperties', 'Assert-LaunchReceiptValue', 'Assert-WebDriverReceipt', 'Invoke-InstalledAppLaunchSmoke'], String.raw`
      function Assert-FileReceipt{param([string]$Path,[uint64]$Bytes,[string]$Sha256,[string]$Kind)};function Assert-TrustedWindowsSignature{param([string]$Path,[string]$ExpectedPublisher);[pscustomobject]@{}};function Get-LaunchProcessSnapshot{return @()}
      $script:LaunchPins=[ordered]@{TauriDriverVersion='2.0.6';TauriDriverPackageSha256='24DC39BD26A65361C1C8E067636BBFF1D9DD7E2FC58FF874EDFBA33ACAB0E6D0';EdgePublisher='Microsoft Corporation'}
      $root=Join-Path (Resolve-Path target) ('launch-wrapper-'+[Guid]::NewGuid().ToString('N'));$drivers=Join-Path $root 'drivers';[IO.Directory]::CreateDirectory((Join-Path $drivers 'tauri-driver-install/bin'))|Out-Null;[IO.Directory]::CreateDirectory((Join-Path $drivers 'edge-driver'))|Out-Null
      $receipt=[ordered]@{schemaVersion=1;tauriDriverSource=[ordered]@{version='2.0.6';origin='static.crates.io';bytes=[uint64]1;sha256=$script:LaunchPins.TauriDriverPackageSha256};tauriDriver=[ordered]@{version='2.0.6';cargoVersion='cargo 1.91.0 (abc 2026-01-01)';rustcVersion='rustc 1.91.0 (abc 2026-01-01)';bytes=[uint64]2;sha256=('A'*64)};webView2RuntimeVersion='151.0.4129.50';edgeDriverArchive=[ordered]@{origin='msedgedriver.microsoft.com';bytes=[uint64]3;sha256=('B'*64)};edgeDriver=[ordered]@{version='151.0.4129.78';bytes=[uint64]4;sha256=('C'*64);signatureStatus='Valid';publisher='Microsoft Corporation';hasTimestamp=$true}}
      [IO.File]::WriteAllText((Join-Path $drivers 'webdriver-receipt.json'),($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
      function Invoke-TestLaunch([string]$label,[scriptblock]$provider,[bool]$extraSettings=$false,[bool]$preexistingChild=$false,[bool]$reparseAncestor=$false){
        $env:LOCALAPPDATA=Join-Path $root ('local-'+$label);if($reparseAncestor){$outside=Join-Path $root ('outside-'+$label);[IO.Directory]::CreateDirectory($outside)|Out-Null;New-Item -ItemType Junction -Path $env:LOCALAPPDATA -Target $outside|Out-Null}
        $settings=Join-Path $env:LOCALAPPDATA 'local.pdfworkstation.desktop';[IO.Directory]::CreateDirectory($settings)|Out-Null
        $sentinel=Join-Path $settings 'upgrade-sentinel.json';[IO.File]::WriteAllText($sentinel,'sentinel',[Text.UTF8Encoding]::new($false));if($extraSettings){$extra=Join-Path $settings '.hidden-extra';[IO.File]::WriteAllText($extra,'extra',[Text.UTF8Encoding]::new($false));[IO.File]::SetAttributes($extra,[IO.FileAttributes]::Hidden)};if($preexistingChild){$child=Join-Path (Join-Path $root ('profile-'+$label)) 'EBWebView';[IO.Directory]::CreateDirectory($child)|Out-Null;[IO.File]::SetAttributes($child,[IO.FileAttributes]::Directory-bor[IO.FileAttributes]::Hidden)}
        Invoke-InstalledAppLaunchSmoke -ApplicationPath (Join-Path $root 'app.exe') -ApplicationReceipt ([pscustomobject]@{bytes=[uint64]5;sha256=('D'*64)}) -WebDriverRoot $drivers -ProfileRoot (Join-Path $root ('profile-'+$label)) -ApplicationSettingsRoot $settings -SettingsSentinelPath $sentinel -SettingsSentinelBytes ([uint64]8) -SettingsSentinelSha256 ('E'*64) -RunnerTemp $root -ExpectedPublisher 'Joshua Beel' -ProcessProvider $provider
      }
      function New-TestLaunchResult([string]$binding,[string]$expectedVersion){[pscustomobject]@{nativeDriverVersion=$expectedVersion;driverVersionBinding='native-status';returnedRuntimeVersion='151.0.4129.50';profileBindingMethod=$binding;sessionCapabilityKeys=@('browserName','browserVersion');title='PDF Workstation';homeButton=$true;ocrCapabilityStatus='Available';sampleName='welcome.pdf';samplePages=6;renderedPageWidth=800;renderedPageHeight=1000;renderedPageBlob=$true;sessionDeleted=$true;ownedProcessTreeStopped=$true;relevantProcessesRemaining=0}}
      $provider={param($app,$tauri,$edge,$profile,$settings,$applicationProfile,$expectedVersion)[IO.Directory]::CreateDirectory($applicationProfile)|Out-Null;[IO.File]::WriteAllText((Join-Path $applicationProfile 'state'),'active',[Text.UTF8Encoding]::new($false));[pscustomobject]@{nativeDriverVersion=$expectedVersion;driverVersionBinding='native-status';returnedRuntimeVersion='151.0.4129.50';profileBindingMethod='owned-webview-tauri-app-settings-ebwebview';sessionCapabilityKeys=@('browserName','browserVersion');title='PDF Workstation';homeButton=$true;ocrCapabilityStatus='Available';sampleName='welcome.pdf';samplePages=6;renderedPageWidth=800;renderedPageHeight=1000;renderedPageBlob=$true;sessionDeleted=$true;ownedProcessTreeStopped=$true;relevantProcessesRemaining=0}}
      $result=Invoke-TestLaunch -label 'good' -provider $provider
      if($result.profile.state-cne'controlled-runner-owned'-or$result.profile.binding-cne'owned-webview-tauri-app-settings-ebwebview'-or$result.profile.prelaunchSettingsEntries-ne1-or-not$result.profile.sentinelPreserved-or$result.drivers.edgeDriver.versionBinding-cne'native-status'-or$result.sample.pages-ne6-or-not$result.cleanup.sessionDeleted){throw 'Sanitized launch result changed.'}
      $requestedProvider={param($app,$tauri,$edge,$profile,$settings,$applicationProfile,$expectedVersion)$child=Join-Path $profile 'EBWebView';[IO.Directory]::CreateDirectory($child)|Out-Null;[IO.File]::WriteAllText((Join-Path $child 'state'),'active',[Text.UTF8Encoding]::new($false));New-TestLaunchResult 'owned-webview-requested-ebwebview' $expectedVersion}
      $requestedResult=Invoke-TestLaunch -label 'requested-good' -provider $requestedProvider
      if($requestedResult.profile.binding-cne'owned-webview-requested-ebwebview'-or$requestedResult.profile.state-cne'controlled-runner-owned'){throw 'Evidence-backed requested EBWebView result changed.'}
      $rejected=$false;try{Invoke-TestLaunch -label 'extra' -provider $provider -extraSettings $true}catch{$rejected=$true};if(-not$rejected){throw 'Unexpected hidden settings asset was accepted.'}
      $rejected=$false;try{Invoke-TestLaunch -label 'preexisting-child' -provider $requestedProvider -preexistingChild $true}catch{$rejected=$true};if(-not$rejected){throw 'Preexisting hidden requested EBWebView child was accepted.'}
      $hiddenSiblingProvider={param($app,$tauri,$edge,$profile,$settings,$applicationProfile,$expectedVersion)$child=Join-Path $profile 'EBWebView';[IO.Directory]::CreateDirectory($child)|Out-Null;[IO.File]::WriteAllText((Join-Path $child 'state'),'active',[Text.UTF8Encoding]::new($false));$extra=Join-Path $profile '.hidden-extra';[IO.File]::WriteAllText($extra,'extra',[Text.UTF8Encoding]::new($false));[IO.File]::SetAttributes($extra,[IO.FileAttributes]::Hidden);New-TestLaunchResult 'owned-webview-requested-ebwebview' $expectedVersion}
      $emptyChildProvider={param($app,$tauri,$edge,$profile,$settings,$applicationProfile,$expectedVersion)[IO.Directory]::CreateDirectory((Join-Path $profile 'EBWebView'))|Out-Null;New-TestLaunchResult 'owned-webview-requested-ebwebview' $expectedVersion}
      $reparseChildProvider={param($app,$tauri,$edge,$profile,$settings,$applicationProfile,$expectedVersion)$outside=Join-Path $root 'reparse-child-outside';[IO.Directory]::CreateDirectory($outside)|Out-Null;[IO.File]::WriteAllText((Join-Path $outside 'state'),'active',[Text.UTF8Encoding]::new($false));New-Item -ItemType Junction -Path (Join-Path $profile 'EBWebView') -Target $outside|Out-Null;New-TestLaunchResult 'owned-webview-requested-ebwebview' $expectedVersion}
      $settingsExtraProvider={param($app,$tauri,$edge,$profile,$settings,$applicationProfile,$expectedVersion)$child=Join-Path $profile 'EBWebView';[IO.Directory]::CreateDirectory($child)|Out-Null;[IO.File]::WriteAllText((Join-Path $child 'state'),'active',[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $settings 'unexpected'),'extra',[Text.UTF8Encoding]::new($false));New-TestLaunchResult 'owned-webview-requested-ebwebview' $expectedVersion}
      foreach($negative in @([pscustomobject]@{label='hidden-sibling';provider=$hiddenSiblingProvider},[pscustomobject]@{label='empty-child';provider=$emptyChildProvider},[pscustomobject]@{label='reparse-child';provider=$reparseChildProvider},[pscustomobject]@{label='settings-extra';provider=$settingsExtraProvider})){$rejected=$false;try{Invoke-TestLaunch -label $negative.label -provider $negative.provider}catch{$rejected=$true};if(-not$rejected){throw ('Unsafe requested EBWebView state was accepted: '+$negative.label)}}
      $rejected=$false;try{Invoke-TestLaunch -label 'reparse-ancestor' -provider $requestedProvider -reparseAncestor $true}catch{$rejected=$true};if(-not$rejected){throw 'Reparse-backed settings ancestor was accepted.'}
      foreach($mutation in @('runtime','native-version','profile')){$bad={param($app,$tauri,$edge,$profile,$settings,$applicationProfile,$expectedVersion)[IO.Directory]::CreateDirectory($applicationProfile)|Out-Null;[IO.File]::WriteAllText((Join-Path $applicationProfile 'state'),'active',[Text.UTF8Encoding]::new($false));$value=[pscustomobject]@{nativeDriverVersion=$expectedVersion;driverVersionBinding='native-status';returnedRuntimeVersion='151.0.4129.50';profileBindingMethod='owned-webview-tauri-app-settings-ebwebview';sessionCapabilityKeys=@('browserVersion');title='PDF Workstation';homeButton=$true;ocrCapabilityStatus='Available';sampleName='welcome.pdf';samplePages=6;renderedPageWidth=800;renderedPageHeight=1000;renderedPageBlob=$true;sessionDeleted=$true;ownedProcessTreeStopped=$true;relevantProcessesRemaining=0};if($mutation-ceq'runtime'){$value.returnedRuntimeVersion='150.0.1.1'}elseif($mutation-ceq'native-version'){$value.nativeDriverVersion='150.0.1.1'}else{$value.profileBindingMethod='missing'};$value}.GetNewClosure();$rejected=$false;try{Invoke-TestLaunch -label ('bad-'+$mutation) -provider $bad}catch{$rejected=$true};if(-not$rejected){throw ('Unsafe launch result accepted: '+$mutation)}}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('keeps the real WebDriver client loopback-only, bounded, exact-oracle, and truth-bound on cleanup', () => {
    const launch = readFileSync('scripts/installed-app-launch.ps1', 'utf8');
    expect(launch).toContain('Assert-FixedWebDriverPortsFree');
    expect(launch).toContain("--native-driver=$EdgeDriverPath");
    expect(launch).toContain("webviewOptions = [ordered]@{ userDataFolder = $ProfileRoot }");
    expect(launch).toContain("-Port $script:LaunchPins.NativeDriverPort");
    expect(launch).toContain('Assert-NativeDriverStatus');
    expect(launch).toContain("$capabilities.browserVersion");
    expect(launch).toContain("$capabilities.PSObject.Properties['msedge.userDataDir']");
    expect(launch).toContain('Get-OwnedProfileBinding');
    expect(launch).toContain('$homeOracle = Wait-WebDriverOracle');
    expect(launch).toContain('title = [string]$homeOracle.title');
    expect(launch).toContain('homeButton = [bool]$homeOracle.home');
    expect(launch).not.toMatch(/\$home\b/i);
    expect(launch).toContain("x.textContent.trim()==='Scan & OCR'");
    expect(launch).toContain("o?.nextElementSibling");
    expect(launch).toContain("img[alt=\"Page 1\"]");
    expect(launch).toContain("i.src.startsWith('blob:')");
    expect(launch).toContain('BeginOutputReadLine');
    expect(launch).toContain('BeginErrorReadLine');
    expect(launch).toContain("$null -eq $delete.value");
    expect(launch).toContain('Get-OwnedLaunchProcesses');
    expect(launch).toContain('relevantProcessesRemaining -ne 0');
    expect(launch.match(/Invoke-BoundedLoopbackJson -Method POST -Path '\/session'/g)).toHaveLength(1);
    expect(launch).not.toMatch(/Start-Process|Remove-Item|\.Delete\(/);
  });

  it('does not assign to PowerShell automatic or read-only variables in the real launch path', () => {
    const source = String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\\scripts\\installed-app-launch.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Launch helper did not parse.'}
      $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq'Invoke-RealInstalledAppLaunch'},$true)
      if($null-eq$function){throw 'Real launch function was not found.'}
      $forbidden=@('args','error','executioncontext','foreach','home','host','input','lastexitcode','matches','myinvocation','nestedpromptlevel','ofs','pid','pscommandpath','psscriptroot','psversiontable','pwd','shellid','stacktrace','this')
      $assigned=@($function.FindAll({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left-is[Management.Automation.Language.VariableExpressionAst]},$true)|ForEach-Object{$_.Left.VariablePath.UserPath.ToLowerInvariant()})
      $collisions=@($assigned|Where-Object{$forbidden-contains$_})
      if($collisions.Count){throw ('Real launch assigns automatic/read-only variables: '+($collisions-join','))}
    `;
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('reports only fixed cleanup outcomes and booleans while keeping every failure rejected', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Invoke-SessionDeleteOutcome', 'Assert-LaunchCleanupState'], String.raw`
      $verified=Invoke-SessionDeleteOutcome -SessionId 'session-id' -Deadline ([datetime]::UtcNow.AddSeconds(1)) -RequestProvider {param($id,$deadline)[pscustomobject]@{value=$null}}
      $requestFailed=Invoke-SessionDeleteOutcome -SessionId 'session-id' -Deadline ([datetime]::UtcNow.AddSeconds(1)) -RequestProvider {throw 'private failure detail'}
      $invalidResponse=Invoke-SessionDeleteOutcome -SessionId 'session-id' -Deadline ([datetime]::UtcNow.AddSeconds(1)) -RequestProvider {param($id,$deadline)[pscustomobject]@{value='unexpected private body'}}
      if($verified-cne'verified'-or$requestFailed-cne'requestfailed'-or$invalidResponse-cne'invalidresponse'){throw 'Session delete outcome classification changed.'}
      $result=[pscustomobject]@{complete=$true};Assert-LaunchCleanupState -Result $result -SessionDeleteOutcome verified -DriverExited $true -RelevantProcessesClear $true -DriverStopOutcome tree-kill-exited -ResidualCategory none
      $cases=@(
        [pscustomobject]@{result=$result;outcome='requestfailed';driver=$true;clear=$true;stop='tree-kill-exited';residual='none';expected='sessionDeleteOutcome=requestfailed;driverExited=true;relevantProcessesClear=true;resultComplete=true;driverStopOutcome=tree-kill-exited;residualCategory=none.'},
        [pscustomobject]@{result=$result;outcome='invalidresponse';driver=$true;clear=$true;stop='fallback-exited';residual='none';expected='sessionDeleteOutcome=invalidresponse;driverExited=true;relevantProcessesClear=true;resultComplete=true;driverStopOutcome=fallback-exited;residualCategory=none.'},
        [pscustomobject]@{result=$result;outcome='verified';driver=$false;clear=$true;stop='wait-failed';residual='none';expected='sessionDeleteOutcome=verified;driverExited=false;relevantProcessesClear=true;resultComplete=true;driverStopOutcome=wait-failed;residualCategory=none.'},
        [pscustomobject]@{result=$result;outcome='verified';driver=$true;clear=$false;stop='tree-kill-exited';residual='webview';expected='sessionDeleteOutcome=verified;driverExited=true;relevantProcessesClear=false;resultComplete=true;driverStopOutcome=tree-kill-exited;residualCategory=webview.'},
        [pscustomobject]@{result=$null;outcome='verified';driver=$true;clear=$true;stop='not-invoked';residual='multiple';expected='sessionDeleteOutcome=verified;driverExited=true;relevantProcessesClear=true;resultComplete=false;driverStopOutcome=not-invoked;residualCategory=multiple.'}
      )
      foreach($case in $cases){$rejected=$false;try{Assert-LaunchCleanupState -Result $case.result -SessionDeleteOutcome $case.outcome -DriverExited $case.driver -RelevantProcessesClear $case.clear -DriverStopOutcome $case.stop -ResidualCategory $case.residual}catch{$rejected=$true;$expected='Installed application launch cleanup state is unverified: '+$case.expected;if($_.Exception.Message-cne$expected-or$_.Exception.Message-match'private|session-id|unexpected'){throw 'Cleanup diagnostic leaked or changed.'}};if(-not$rejected){throw 'Unverified cleanup state was accepted.'}}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('waits boundedly for an inert owned process tree and never kills mismatched identities', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Wait-BoundedOwnedProcessExit', 'Stop-OwnedLaunchProcesses'], String.raw`
      $root=Join-Path (Resolve-Path target) ('owned-cleanup-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($root)|Out-Null
      $pidPath=Join-Path $root 'child.pid';$rootScript=Join-Path $root 'root.ps1';$pwsh=(Get-Process -Id $PID).Path
      $rootSource=@'
param([string]$ChildPidPath,[string]$PwshPath)
$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$PwshPath;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.ArgumentList.Add('-NoProfile');$info.ArgumentList.Add('-NonInteractive');$info.ArgumentList.Add('-Command');$info.ArgumentList.Add('Start-Sleep -Seconds 30')
$child=[Diagnostics.Process]::Start($info);[IO.File]::WriteAllText($ChildPidPath,[string]$child.Id,[Text.UTF8Encoding]::new($false));Start-Sleep -Seconds 30
'@
      [IO.File]::WriteAllText($rootScript,$rootSource,[Text.UTF8Encoding]::new($false))
      $rootInfo=[Diagnostics.ProcessStartInfo]::new();$rootInfo.FileName=$pwsh;$rootInfo.UseShellExecute=$false;$rootInfo.CreateNoWindow=$true;foreach($argument in @('-NoProfile','-NonInteractive','-File',$rootScript,$pidPath,$pwsh)){$rootInfo.ArgumentList.Add($argument)}
      $rootProcess=[Diagnostics.Process]::Start($rootInfo);$childProcess=$null
      try{
        $ready=[datetime]::UtcNow.AddSeconds(5);while(-not(Test-Path -LiteralPath $pidPath) -and [datetime]::UtcNow -lt $ready){Start-Sleep -Milliseconds 50};if(-not(Test-Path -LiteralPath $pidPath)){throw 'Inert child PID receipt was not created.'}
        $childProcess=Get-Process -Id ([int](Get-Content -LiteralPath $pidPath -Raw));$captured=@([pscustomobject]@{ProcessId=$childProcess.Id;Path=[string]$childProcess.Path;StartTicks=$childProcess.StartTime.ToUniversalTime().Ticks})
        $rootOutcome=Stop-OwnedLaunchProcesses -TauriDriver $rootProcess -Captured $captured -Deadline ([datetime]::UtcNow.AddSeconds(8))
        if($rootOutcome-cne'tree-kill-exited'){throw 'Owned root stop outcome was not exact.'}
        if(-not$rootProcess.HasExited){throw 'Owned root did not exit within its bounded cleanup deadline.'};$childAlive=$true;try{$null=Get-Process -Id $childProcess.Id -ErrorAction Stop}catch{$childAlive=$false};if($childAlive){throw 'Inert owned child remained alive.'}
      }finally{try{if(-not$rootProcess.HasExited){$rootProcess.Kill($true);$rootProcess.WaitForExit(5000)|Out-Null}}catch{};try{if($childProcess -and -not $childProcess.HasExited){$childProcess.Kill();$childProcess.WaitForExit(5000)|Out-Null}}catch{}}
      $script:fakeKills=0;$started=[datetime]::UtcNow;$fake=[pscustomobject]@{HasExited=$false;Path='C:\fixture\owned.exe';StartTime=$started};$fake|Add-Member ScriptMethod Kill {param([bool]$tree)$script:fakeKills++};$fake|Add-Member ScriptMethod WaitForExit {param([int]$milliseconds)$false}
      $provider={param($id)$fake}.GetNewClosure();$deadline=[datetime]::UtcNow.AddSeconds(1)
      Stop-OwnedLaunchProcesses -TauriDriver $null -Captured @([pscustomobject]@{ProcessId=77;Path='C:\fixture\other.exe';StartTicks=$started.ToUniversalTime().Ticks}) -Deadline $deadline -ProcessProvider $provider
      Stop-OwnedLaunchProcesses -TauriDriver $null -Captured @([pscustomobject]@{ProcessId=77;Path='C:\fixture\owned.exe';StartTicks=($started.ToUniversalTime().Ticks+1)}) -Deadline $deadline -ProcessProvider $provider
      if($script:fakeKills-ne0){throw 'A path/start identity mismatch was killed.'}
      if((Wait-BoundedOwnedProcessExit -Process $fake -Deadline ([datetime]::UtcNow.AddMilliseconds(-1)))-cne'deadline'-or$script:fakeKills-ne0){throw 'Expired cleanup deadline killed or accepted a live process.'}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('snapshots real driver exit before disposing its bounded capture', () => {
    const launchSource = readFileSync('scripts/installed-app-launch.ps1', 'utf8');
    const snapshotOffset = launchSource.indexOf('$driverExited = [bool]$driver.HasExited');
    const disposeOffset = launchSource.indexOf('$driverCapture.Dispose()', snapshotOffset);
    expect(snapshotOffset).toBeGreaterThan(0);
    expect(disposeOffset).toBeGreaterThan(snapshotOffset);
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Start-BoundedDiscardProcess', 'Wait-BoundedOwnedProcessExit', 'Stop-OwnedLaunchProcesses'], String.raw`
      $pwsh=(Get-Process -Id $PID).Path;$capture=Start-BoundedDiscardProcess -Path $pwsh -Arguments @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30');$process=$capture.Process
      try{$capture.Start();$outcome=Stop-OwnedLaunchProcesses -TauriDriver $process -Captured @() -Deadline ([datetime]::UtcNow.AddSeconds(5));$driverExited=[bool]$process.HasExited;if(-not$driverExited-or$outcome-cne'tree-kill-exited'){throw 'Exact bounded capture did not stop before disposal.'};$capture.Dispose();$capture=$null;if($null-ne$process.HasExited){throw 'Disposed Process unexpectedly retained a reliable HasExited value.'};if(-not$driverExited){throw 'The pre-disposal exit snapshot was lost.'}}finally{try{if($capture){$capture.Dispose()}}catch{}}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('classifies only fixed residual process categories and fails closed for unknown or multiple entries', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Get-LaunchResidualCategory'], String.raw`
      $cases=@(
        [pscustomobject]@{items=@();expected='none'},
        [pscustomobject]@{items=@([pscustomobject]@{ProcessName='pdf-workstation'});expected='application'},
        [pscustomobject]@{items=@([pscustomobject]@{ProcessName='tauri-driver'});expected='tauri-driver'},
        [pscustomobject]@{items=@([pscustomobject]@{ProcessName='msedgedriver'});expected='edge-driver'},
        [pscustomobject]@{items=@([pscustomobject]@{ProcessName='msedgewebview2'});expected='webview'},
        [pscustomobject]@{items=@([pscustomobject]@{ProcessName='private-name'});expected='multiple'},
        [pscustomobject]@{items=@([pscustomobject]@{ProcessName='tauri-driver'},[pscustomobject]@{ProcessName='msedgewebview2'});expected='multiple'}
      );foreach($case in $cases){$actual=Get-LaunchResidualCategory -Processes $case.items;if($actual-cne$case.expected-or$actual-match'private'){throw 'Residual category escaped its fixed allowlist.'}}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('does not retry a timed-out session POST and still stops the owned process tree', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Invoke-RealInstalledAppLaunch'], String.raw`
      $script:LaunchPins=[ordered]@{TotalTimeoutMilliseconds=60000;CleanupProcessTimeoutMilliseconds=10000;WebDriverPort=4444;NativeDriverPort=4445}
      $script:sessionPosts=0;$script:deleteRequests=0;$script:driverStopped=$false
      $driver=[pscustomobject]@{HasExited=$false;Id=1234}
      $capture=[pscustomobject]@{Process=$driver;Exceeded=$false};$capture|Add-Member ScriptMethod Start {};$capture|Add-Member ScriptMethod Dispose {}
      function Assert-FixedWebDriverPortsFree{}
      function Start-BoundedDiscardProcess{param([string]$Path,[object[]]$Arguments);$capture}
      function Invoke-BoundedLoopbackJson{param([string]$Method,[string]$Path,$Body,[datetime]$Deadline,[int]$Port=4444);if($Method-ceq'GET'-and$Path-ceq'/status'){return [pscustomobject]@{value=[pscustomobject]@{ready=$true}}};if($Method-ceq'POST'-and$Path-ceq'/session'){$script:sessionPosts++;throw 'session-timeout'};if($Method-ceq'DELETE'){$script:deleteRequests++};throw 'unexpected-loopback-request'}
      function Wait-NativeDriverStatus{param([string]$ExpectedVersion,[datetime]$Deadline,$TauriDriver);$ExpectedVersion}
      function Get-OwnedLaunchProcesses{param([int]$RootProcessId,[datetime]$StartedAfter);@()}
      function Stop-OwnedLaunchProcesses{param($TauriDriver,[object[]]$Captured,[datetime]$Deadline);$script:driverStopped=$true;$TauriDriver.HasExited=$true}
      function Get-LaunchProcessSnapshot{@()}
      function Get-LaunchResidualCategory{param([object[]]$Processes);'none'}
      $rejected=$false;try{Invoke-RealInstalledAppLaunch -ApplicationPath 'app.exe' -TauriDriverPath 'tauri-driver.exe' -EdgeDriverPath 'msedgedriver.exe' -ProfileRoot 'profile' -SettingsRoot 'settings' -ExpectedEdgeDriverVersion '151.0.1.2'}catch{if($_.Exception.Message-ceq'session-timeout'){$rejected=$true}else{throw}}
      if(-not$rejected-or$script:sessionPosts-ne1-or$script:deleteRequests-ne0-or-not$script:driverStopped-or-not$driver.HasExited){throw 'Session-timeout cleanup or no-retry contract changed.'}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects occupied ports, over-deep JSON, and every native endpoint except fixed GET status', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Assert-BoundedJsonShape', 'Get-LaunchRemainingMilliseconds', 'Get-LoopbackRequestTimeoutMilliseconds', 'Invoke-BoundedLoopbackJson', 'Assert-FixedWebDriverPortsFree'], String.raw`
      $script:LaunchPins=[ordered]@{WebDriverPort=4444;NativeDriverPort=4445;JsonDepthMaximum=2;JsonNodesMaximum=8;RequestBytesMaximum=1MB;RequestTimeoutMilliseconds=10000;SessionCreationTimeoutMilliseconds=30000}
      $nodes=0;$rejected=$false;try{Assert-BoundedJsonShape -Value ([pscustomobject]@{a=[pscustomobject]@{b=[pscustomobject]@{c=1}}}) -Nodes ([ref]$nodes)}catch{$rejected=$true};if(-not$rejected){throw 'Deep JSON accepted.'}
      $farDeadline=[datetime]::UtcNow.AddSeconds(45)
      if((Get-LoopbackRequestTimeoutMilliseconds -Method POST -Path '/session' -Port 4444 -Deadline $farDeadline)-ne30000){throw 'Exact session creation did not receive its bounded cold-start allowance.'}
      foreach($ordinary in @([pscustomobject]@{method='GET';path='/status';port=4444},[pscustomobject]@{method='GET';path='/status';port=4445},[pscustomobject]@{method='POST';path='/session/id/execute/sync';port=4444},[pscustomobject]@{method='DELETE';path='/session/id';port=4444})){if((Get-LoopbackRequestTimeoutMilliseconds -Method $ordinary.method -Path $ordinary.path -Port $ordinary.port -Deadline $farDeadline)-ne10000){throw 'An ordinary loopback operation escaped the 10-second cap.'}}
      $nearDeadline=[datetime]::UtcNow.AddMilliseconds(750);$clamped=Get-LoopbackRequestTimeoutMilliseconds -Method POST -Path '/session' -Port 4444 -Deadline $nearDeadline;if($clamped-le0-or$clamped-gt750){throw 'Shared remaining deadline did not clamp session creation.'}
      foreach($request in @([pscustomobject]@{method='POST';path='/status';port=4445},[pscustomobject]@{method='GET';path='/session';port=4445},[pscustomobject]@{method='GET';path='/status';port=4446})){$rejected=$false;try{Invoke-BoundedLoopbackJson -Method $request.method -Path $request.path -Port $request.port -Deadline ([datetime]::UtcNow.AddSeconds(1))}catch{if($_.Exception.Message -ceq'WebDriver requests are restricted to the fixed loopback endpoint and command allowlist.'){$rejected=$true}};if(-not$rejected){throw 'Unsafe native endpoint escaped its allowlist.'}}
      $allowed=$false;try{Invoke-BoundedLoopbackJson -Method GET -Path '/status' -Port 4445 -Deadline ([datetime]::UtcNow.AddSeconds(1))}catch{if($_.Exception.Message -cne'WebDriver requests are restricted to the fixed loopback endpoint and command allowlist.'){$allowed=$true}};if(-not$allowed){throw 'Exact native status endpoint was not allowed.'}
      $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,4444);$listener.Start();try{$rejected=$false;try{Assert-FixedWebDriverPortsFree}catch{$rejected=$true};if(-not$rejected){throw 'Occupied fixed port accepted.'}}finally{$listener.Stop()}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
