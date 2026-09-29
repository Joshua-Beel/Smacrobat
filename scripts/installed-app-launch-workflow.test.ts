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
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Assert-NativeDriverStatus', 'Wait-NativeDriverStatus', 'Get-OwnedProfileBinding', 'Assert-OwnedLaunchExecutables'], String.raw`
      $version='151.0.4129.78';$status=[pscustomobject]@{value=[pscustomobject]@{ready=$true;build=[pscustomobject]@{version=($version+' (trusted-build)')}}}
      if((Assert-NativeDriverStatus -Status $status -ExpectedVersion $version)-cne$version){throw 'Native status version was not bound.'}
      foreach($bad in @(
        [pscustomobject]@{value=[pscustomobject]@{ready=$true;build=[pscustomobject]@{version='150.0.1.1'}}},
        [pscustomobject]@{value=[pscustomobject]@{ready=$false;build=[pscustomobject]@{version=$version}}},
        [pscustomobject]@{value=[pscustomobject]@{ready=$true}}
      )){$rejected=$false;try{Assert-NativeDriverStatus -Status $bad -ExpectedVersion $version}catch{$rejected=$true};if(-not$rejected){throw 'Unsafe native status accepted.'}}
      $responses=[Collections.Generic.Queue[object]]::new();$responses.Enqueue('not-ready');$responses.Enqueue($status);$provider={param($deadline)$next=$responses.Dequeue();if($next-is[string]){throw $next};$next}.GetNewClosure()
      if((Wait-NativeDriverStatus -ExpectedVersion $version -Deadline ([datetime]::UtcNow.AddSeconds(2)) -TauriDriver ([pscustomobject]@{HasExited=$false}) -StatusProvider $provider)-cne$version-or$responses.Count-ne0){throw 'Native readiness retry changed.'}
      $profile=Join-Path (Resolve-Path target) ('profile-binding-'+[Guid]::NewGuid().ToString('N'))
      $owned=@([pscustomobject]@{Path='C:\Program Files (x86)\Microsoft\EdgeWebView\Application\msedgewebview2.exe';CommandLine=('msedgewebview2.exe --user-data-dir="'+$profile+'" --type=renderer')},[pscustomobject]@{Path='C:\Program Files (x86)\Microsoft\EdgeWebView\Application\msedgewebview2.exe';CommandLine='msedgewebview2.exe --type=gpu-process'})
      if((Get-OwnedProfileBinding -Owned $owned -ExpectedProfile $profile)-cne'owned-webview-command-line'){throw 'Owned profile was not bound.'}
      foreach($badOwned in @(@(),@([pscustomobject]@{Path='C:\msedgewebview2.exe';CommandLine='msedgewebview2.exe --type=renderer'}),@([pscustomobject]@{Path='C:\msedgewebview2.exe';CommandLine='msedgewebview2.exe --user-data-dir=C:\wrong'}),@([pscustomobject]@{Path='C:\msedgewebview2.exe';CommandLine=('msedgewebview2.exe --user-data-dir="'+$profile+'" --user-data-dir="'+$profile+'"')}))){$rejected=$false;try{Get-OwnedProfileBinding -Owned $badOwned -ExpectedProfile $profile}catch{$rejected=$true};if(-not$rejected){throw 'Missing, wrong, or duplicate owned profile evidence accepted.'}}
      $app=Join-Path $profile 'pdf-workstation.exe';$edge=Join-Path $profile 'msedgedriver.exe';$executables=@([pscustomobject]@{Path=$app},[pscustomobject]@{Path=$edge})
      Assert-OwnedLaunchExecutables -Owned $executables -ApplicationPath $app -EdgeDriverPath $edge
      foreach($badExecutables in @(@([pscustomobject]@{Path=$app},[pscustomobject]@{Path='C:\wrong\msedgedriver.exe'}),@([pscustomobject]@{Path=$app},[pscustomobject]@{Path=$edge},[pscustomobject]@{Path=$edge}))){$rejected=$false;try{Assert-OwnedLaunchExecutables -Owned $badExecutables -ApplicationPath $app -EdgeDriverPath $edge}catch{$rejected=$true};if(-not$rejected){throw 'Wrong or duplicate owned EdgeDriver accepted.'}}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('validates exact UI/runtime/cleanup results before producing sanitized launch evidence', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Assert-LaunchExactProperties', 'Assert-LaunchReceiptValue', 'Assert-WebDriverReceipt', 'Invoke-InstalledAppLaunchSmoke'], String.raw`
      function Assert-NoReparseAncestors{param([string]$Path)};function Assert-FileReceipt{param([string]$Path,[uint64]$Bytes,[string]$Sha256,[string]$Kind)};function Assert-TrustedWindowsSignature{param([string]$Path,[string]$ExpectedPublisher);[pscustomobject]@{}};function Get-LaunchProcessSnapshot{return @()}
      $script:LaunchPins=[ordered]@{TauriDriverVersion='2.0.6';TauriDriverPackageSha256='24DC39BD26A65361C1C8E067636BBFF1D9DD7E2FC58FF874EDFBA33ACAB0E6D0';EdgePublisher='Microsoft Corporation'}
      $root=Join-Path (Resolve-Path target) ('launch-wrapper-'+[Guid]::NewGuid().ToString('N'));$drivers=Join-Path $root 'drivers';[IO.Directory]::CreateDirectory((Join-Path $drivers 'tauri-driver-install/bin'))|Out-Null;[IO.Directory]::CreateDirectory((Join-Path $drivers 'edge-driver'))|Out-Null
      $receipt=[ordered]@{schemaVersion=1;tauriDriverSource=[ordered]@{version='2.0.6';origin='static.crates.io';bytes=[uint64]1;sha256=$script:LaunchPins.TauriDriverPackageSha256};tauriDriver=[ordered]@{version='2.0.6';cargoVersion='cargo 1.91.0 (abc 2026-01-01)';rustcVersion='rustc 1.91.0 (abc 2026-01-01)';bytes=[uint64]2;sha256=('A'*64)};webView2RuntimeVersion='151.0.4129.50';edgeDriverArchive=[ordered]@{origin='msedgedriver.microsoft.com';bytes=[uint64]3;sha256=('B'*64)};edgeDriver=[ordered]@{version='151.0.4129.78';bytes=[uint64]4;sha256=('C'*64);signatureStatus='Valid';publisher='Microsoft Corporation';hasTimestamp=$true}}
      [IO.File]::WriteAllText((Join-Path $drivers 'webdriver-receipt.json'),($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
      $provider={param($app,$tauri,$edge,$profile,$expectedVersion)[pscustomobject]@{nativeDriverVersion=$expectedVersion;driverVersionBinding='native-status';returnedRuntimeVersion='151.0.4129.50';profileBindingMethod='owned-webview-command-line';sessionCapabilityKeys=@('browserName','browserVersion');title='PDF Workstation';homeButton=$true;ocrCapabilityStatus='Available';sampleName='welcome.pdf';samplePages=6;renderedPageWidth=800;renderedPageHeight=1000;renderedPageBlob=$true;sessionDeleted=$true;ownedProcessTreeStopped=$true;relevantProcessesRemaining=0}}
      $result=Invoke-InstalledAppLaunchSmoke -ApplicationPath (Join-Path $root 'app.exe') -ApplicationReceipt ([pscustomobject]@{bytes=[uint64]5;sha256=('D'*64)}) -WebDriverRoot $drivers -ProfileRoot (Join-Path $root 'profile-good') -RunnerTemp $root -ExpectedPublisher 'Joshua Beel' -ProcessProvider $provider
      if($result.profile.state-cne'fresh-runner-owned'-or$result.profile.binding-cne'owned-webview-command-line'-or$result.drivers.edgeDriver.versionBinding-cne'native-status'-or$result.sample.pages-ne6-or-not$result.cleanup.sessionDeleted){throw 'Sanitized launch result changed.'}
      foreach($mutation in @('runtime','native-version','profile')){$bad={param($app,$tauri,$edge,$profile,$expectedVersion)$value=[pscustomobject]@{nativeDriverVersion=$expectedVersion;driverVersionBinding='native-status';returnedRuntimeVersion='151.0.4129.50';profileBindingMethod='session-capability';sessionCapabilityKeys=@('browserVersion');title='PDF Workstation';homeButton=$true;ocrCapabilityStatus='Available';sampleName='welcome.pdf';samplePages=6;renderedPageWidth=800;renderedPageHeight=1000;renderedPageBlob=$true;sessionDeleted=$true;ownedProcessTreeStopped=$true;relevantProcessesRemaining=0};if($mutation-ceq'runtime'){$value.returnedRuntimeVersion='150.0.1.1'}elseif($mutation-ceq'native-version'){$value.nativeDriverVersion='150.0.1.1'}else{$value.profileBindingMethod='missing'};$value}.GetNewClosure();$rejected=$false;try{Invoke-InstalledAppLaunchSmoke -ApplicationPath (Join-Path $root 'app.exe') -ApplicationReceipt ([pscustomobject]@{bytes=[uint64]5;sha256=('D'*64)}) -WebDriverRoot $drivers -ProfileRoot (Join-Path $root ('profile-bad-'+$mutation)) -RunnerTemp $root -ExpectedPublisher 'Joshua Beel' -ProcessProvider $bad}catch{$rejected=$true};if(-not$rejected){throw ('Unsafe launch result accepted: '+$mutation)}}
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
    expect(launch).toContain("x.textContent.trim()==='Scan & OCR'");
    expect(launch).toContain("o?.nextElementSibling");
    expect(launch).toContain("img[alt=\"Page 1\"]");
    expect(launch).toContain("i.src.startsWith('blob:')");
    expect(launch).toContain('BeginOutputReadLine');
    expect(launch).toContain('BeginErrorReadLine');
    expect(launch).toContain("$null -eq $delete.value");
    expect(launch).toContain('Get-OwnedLaunchProcesses');
    expect(launch).toContain('relevantProcessesRemaining -ne 0');
    expect(launch).not.toMatch(/Start-Process|Remove-Item|\.Delete\(/);
  });

  it('rejects occupied ports, over-deep JSON, and every native endpoint except fixed GET status', () => {
    const source = extractFunctions('scripts/installed-app-launch.ps1', ['Assert-BoundedJsonShape', 'Get-LaunchRemainingMilliseconds', 'Invoke-BoundedLoopbackJson', 'Assert-FixedWebDriverPortsFree'], String.raw`
      $script:LaunchPins=[ordered]@{WebDriverPort=4444;NativeDriverPort=4445;JsonDepthMaximum=2;JsonNodesMaximum=8;RequestBytesMaximum=1MB}
      $nodes=0;$rejected=$false;try{Assert-BoundedJsonShape -Value ([pscustomobject]@{a=[pscustomobject]@{b=[pscustomobject]@{c=1}}}) -Nodes ([ref]$nodes)}catch{$rejected=$true};if(-not$rejected){throw 'Deep JSON accepted.'}
      foreach($request in @([pscustomobject]@{method='POST';path='/status';port=4445},[pscustomobject]@{method='GET';path='/session';port=4445},[pscustomobject]@{method='GET';path='/status';port=4446})){$rejected=$false;try{Invoke-BoundedLoopbackJson -Method $request.method -Path $request.path -Port $request.port -Deadline ([datetime]::UtcNow.AddSeconds(1))}catch{if($_.Exception.Message -ceq'WebDriver requests are restricted to the fixed loopback endpoint and command allowlist.'){$rejected=$true}};if(-not$rejected){throw 'Unsafe native endpoint escaped its allowlist.'}}
      $allowed=$false;try{Invoke-BoundedLoopbackJson -Method GET -Path '/status' -Port 4445 -Deadline ([datetime]::UtcNow.AddSeconds(1))}catch{if($_.Exception.Message -cne'WebDriver requests are restricted to the fixed loopback endpoint and command allowlist.'){$allowed=$true}};if(-not$allowed){throw 'Exact native status endpoint was not allowed.'}
      $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,4444);$listener.Start();try{$rejected=$false;try{Assert-FixedWebDriverPortsFree}catch{$rejected=$true};if(-not$rejected){throw 'Occupied fixed port accepted.'}}finally{$listener.Stop()}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
