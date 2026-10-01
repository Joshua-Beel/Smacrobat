import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const source = readFileSync('scripts/installed-structural-page-tools.ps1', 'utf8');

function runPowerShell(sourceText: string) {
  const root = mkdtempSync(join(tmpdir(), 'smacrobat-structural-page-tools-'));
  const path = join(root, 'run.ps1');
  try {
    writeFileSync(path, sourceText, 'utf8');
    return spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('installed structural page-tools verifier', () => {
  it('parses and reuses the process-bound Open picker and exact native Save implementation', () => {
    const result = runPowerShell(String.raw`
      $tokens=$null;$errors=$null
      [Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-structural-page-tools.ps1',[ref]$tokens,[ref]$errors)|Out-Null
      if($errors.Count){throw ($errors|Out-String)}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(source).toContain("installed-reading-tools.ps1");
    expect(source).toContain("installed-print-dialog.ps1");
    expect(source).toContain('Open-ReadingUserFile');
    expect(source).toContain('Get-ProcessNativeWindowSnapshot');
    expect(source).toContain('Wait-NewProcessNativeWindowSurface');
    expect(source).toContain('Get-ValidatedBindingNativeRoles');
    expect(source).toContain('Set-BoundNativeSaveFileNameExact');
    expect(source).toContain('Invoke-BoundNativeSaveButtonExact');
    expect(source).toContain("-ActionTransport 'native-bm-click-delivered'");
    expect(source).toContain('SignedPdfiumStructuralProof');
    expect(source).toContain('Get-StructuralPdfiumProof');
    expect(source).toContain('Get-StructuralPdfiumProofInProcess');
    expect(source).toContain('installed-structural-pdfium-proof.ps1');
    expect(source).toContain('Wait-StructuralStableFile');
    const countGate = source.indexOf('if(pages!=expectedPages)');
    const firstPageAllocation = source.indexOf('var widths=new double[pages]');
    expect(countGate).toBeGreaterThan(-1);
    expect(firstPageAllocation).toBeGreaterThan(countGate);
    expect(source).not.toMatch(/SendKeys|SetCursorPos|mouse_event|keybd_event|pyautogui/i);
  });

  it('binds one new native Save surface and finishes its exact action before accepting the output', () => {
    const result = runPowerShell(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-structural-page-tools.ps1
      $script:events=[Collections.Generic.List[string]]::new();$script:output='';$script:deadline=0L
      function Get-ProcessNativeWindowSnapshot{param([int]$ProcessId,[datetime]$Deadline,[switch]$TopLevelOnly)$script:events.Add('baseline')|Out-Null;@([pscustomobject]@{runtimeIdentity='hwnd:100|baseline'})}
      function Invoke-WebDriverScript{param([string]$SessionId,[datetime]$Deadline,[string]$Script)$script:events.Add('submit')|Out-Null;$true}
      function Wait-NewProcessNativeWindowSurface{param([int]$ProcessId,[object[]]$Baseline,[string[]]$AnchorNames,[string[]]$AnchorControlTypes,[string]$Stage,[datetime]$Deadline)
        if($Baseline.Count-ne1-or$AnchorNames.Count-ne1-or$AnchorNames[0]-cne'Save'-or$Stage-cne'save-output-dialog'){throw 'Unexpected binding contract.'}
        $script:events.Add('bind')|Out-Null;[pscustomobject]@{surfaceRootIdentity='hwnd:500|native';surfaceElement=$null;baselineIdentities=@('hwnd:100|baseline');trackedIdentities=@('hwnd:500|native','hwnd:501|native','hwnd:502|native');anchorElement=$null;nativeRoles=[pscustomobject]@{cancel='hwnd:503|native';save='hwnd:501|native';filenameEdit='hwnd:502|native'}}
      }
      function Get-ValidatedBindingNativeRoles{param($Binding)$Binding.nativeRoles}
      function Set-BoundNativeSaveFileNameExact{param([int]$ProcessId,[long]$ProcessStartUtcTicks,$Binding,[string]$Value,[long]$DeadlineTickCount)
        if($ProcessId-ne7319-or$ProcessStartUtcTicks-ne638500000000000000L-or$DeadlineTickCount-le[Environment]::TickCount64){throw 'Identity/deadline contract changed.'}
        $script:output=$Value;$script:deadline=$DeadlineTickCount;$script:events.Add('set-name')|Out-Null
      }
      function Invoke-BoundNativeSaveButtonExact{param([int]$ProcessId,[long]$ProcessStartUtcTicks,$Binding,[long]$DeadlineTickCount)
        if($DeadlineTickCount-ne$script:deadline){throw 'Save actions did not share one deadline.'};$script:events.Add('save-click')|Out-Null
      }
      function Wait-BoundProcessUiSurfaceClosed{param([int]$ProcessId,$Binding,[string]$Stage,[datetime]$Deadline,[long]$ProcessStartUtcTicks,[string]$ExpectedNativeSaveFileName,[string]$ActionTransport)
        if($ExpectedNativeSaveFileName-cne$script:output-or$ActionTransport-cne'native-bm-click-delivered'){throw 'Save close proof preceded its exact action.'}
        $script:events.Add('closed')|Out-Null
      }
      function Wait-StructuralDocumentState{param([string]$SessionId,[string]$ExpectedName,[int]$ExpectedPages,[int]$ExpectedTabs,[datetime]$Deadline)
        if($ExpectedName-cne'combined-output.pdf'-or$ExpectedPages-ne12-or$ExpectedTabs-ne3){throw 'Output oracle changed.'};$script:events.Add('ui-output')|Out-Null;[pscustomobject]@{name=$ExpectedName}
      }
      $fingerprints=[string[]](1..12|ForEach-Object{$_.ToString('X64')})
      function Wait-StructuralStableFile{param($Path,$Deadline)$script:events.Add('stable')|Out-Null;[pscustomobject]@{bytes=[uint64]4;sha256=('A'*64)}}
      function Get-StructuralPdfiumProof{param($PdfiumPath,$PdfPath,$ExpectedPages,$ProofPath,$Deadline)$script:events.Add('pdfium')|Out-Null;[pscustomobject]@{Pages=12;PageFingerprintSha256=$fingerprints}}
      function Assert-StructuralFileReceipt{param($Path,$Receipt,$Kind)if($Receipt.bytes-ne4-or$Receipt.sha256-cne('A'*64)){throw 'Stable receipt changed.'};$script:events.Add('receipt-recheck')|Out-Null}
      $output=Join-Path $env:TEMP ('combined-output-'+[guid]::NewGuid().ToString('N')+'.pdf');$receipt=Invoke-StructuralNativeSave -SessionId session -ApplicationProcessId 7319 -ApplicationStartTicks 638500000000000000L -Tool 'Combine Files' -ConfirmLabel 'Combine PDFs' -OutputPath $output -ExpectedName 'combined-output.pdf' -ExpectedPages 12 -ExpectedTabs 3 -PdfiumPath 'C:\fixture\pdfium.dll' -PdfiumProofPath 'C:\fixture\combine.json' -ExpectedPageFingerprintSha256 $fingerprints -Deadline ([datetime]::UtcNow.AddSeconds(5))
      if(-not$receipt.saveDialogVerified-or$receipt.bytes-ne4-or$receipt.pages-ne12-or-not$receipt.pageFingerprintOrderVerified-or@($receipt.pageFingerprintSha256).Count-ne12-or-not$receipt.workspaceOpened-or$receipt.sha256-cnotmatch'^[A-F0-9]{64}$'){throw 'Output receipt was incomplete.'}
      $actual=[string]::Join(',',$script:events);if($actual-cne'baseline,submit,bind,set-name,save-click,closed,ui-output,stable,pdfium,receipt-recheck'){throw "Lifecycle order changed: $actual"}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('fails closed when native Save roles are incomplete and rejects weak or expanded result schemas', () => {
    const result = runPowerShell(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-structural-page-tools.ps1
      function Get-ProcessNativeWindowSnapshot{param([int]$ProcessId,[datetime]$Deadline,[switch]$TopLevelOnly)@([pscustomobject]@{runtimeIdentity='hwnd:1|baseline'})}
      function Invoke-WebDriverScript{param([string]$SessionId,[datetime]$Deadline,[string]$Script)$true}
      function Wait-NewProcessNativeWindowSurface{param([int]$ProcessId,[object[]]$Baseline,[string[]]$AnchorNames,[string[]]$AnchorControlTypes,[string]$Stage,[datetime]$Deadline)[pscustomobject]@{nativeRoles=$null}}
      function Get-ValidatedBindingNativeRoles{param($Binding)$null}
      $rejected=$false;try{Invoke-StructuralNativeSave -SessionId session -ApplicationProcessId 1 -ApplicationStartTicks 1 -Tool 'Combine Files' -ConfirmLabel 'Combine PDFs' -OutputPath (Join-Path $env:TEMP ('never-'+[guid]::NewGuid()+'.pdf')) -ExpectedName 'never.pdf' -ExpectedPages 12 -ExpectedTabs 3 -PdfiumPath 'C:\fixture\pdfium.dll' -PdfiumProofPath 'C:\fixture\never.json' -ExpectedPageFingerprintSha256 @('A'*64) -Deadline ([datetime]::UtcNow.AddSeconds(5))|Out-Null}catch{$rejected=$_.Exception.Message.Contains('exact native HWND role contract')}
      if(-not$rejected){throw 'Incomplete native Save roles were accepted.'}
      $first=[string[]](1..6|ForEach-Object{$_.ToString('X64')});$second=[string[]](7..12|ForEach-Object{$_.ToString('X64')})
      $combine=[string[]]@($first+$second);$insert=[string[]]@($first[0..1]+$second+$first[2..5]);$replace=[string[]]@(@($first[0])+$second+$first[3..5])
      function New-Output([string[]]$fingerprints,[int]$pages){[pscustomobject][ordered]@{saveDialogVerified=$true;bytes=[uint64]1;sha256=('A'*64);pages=$pages;pageFingerprintSha256=[string[]]$fingerprints;pageFingerprintOrderVerified=$true;workspaceOpened=$true}}
      $good=[pscustomobject][ordered]@{nativeDriverVersion='1.2.3.4';returnedRuntimeVersion='1.2.3.4';profileBinding='session-capability-requested-profile';processBoundOpenPickerVerified=$true;openFilenameControlCategories=@('edit-1001','edit-1148');firstSourcePageFingerprintSha256=$first;secondSourcePageFingerprintSha256=$second;combine=(New-Output -fingerprints $combine -pages 12);insert=(New-Output -fingerprints $insert -pages 12);replace=(New-Output -fingerprints $replace -pages 10);sourceTabsPreserved=$true;sessionDeleted=$true;ownedProcessTreeStopped=$true;relevantProcessesRemaining=0}
      Assert-StructuralResult $good
      $good.insert.pageFingerprintSha256[2]=$first[2];$rejected=$false;try{Assert-StructuralResult $good}catch{$rejected=$_.Exception.Message-like'*fingerprint order*'};if(-not$rejected){throw 'Wrong inserted page sequence was accepted.'};$good.insert.pageFingerprintSha256=$insert
      $good|Add-Member extra $true;$rejected=$false;try{Assert-StructuralResult $good}catch{$rejected=$true};if(-not$rejected){throw 'Expanded result schema was accepted.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('drives the exact signed labels and proves all output and source page counts', () => {
    for (const marker of [
      "-Tool combine", "-Tool insert", "-Tool replace", "'Combine PDFs'", "'Insert pages'", "'Replace pages'",
      "-Label 'Insertion boundary' -Value '2'", "-Label 'First target page' -Value '2'", "-Label 'Target pages to replace' -Value '2'",
      '-ExpectedPages 12 -ExpectedTabs 3', '-ExpectedPages 12 -ExpectedTabs 4', '-ExpectedPages 10 -ExpectedTabs 5',
      'sourceTabsPreserved=$true', 'Assert-StructuralFileReceipt -Path $FirstFixturePath', 'Assert-StructuralFileReceipt -Path $SecondFixturePath',
      'FirstPageFingerprintSha256', 'CombinePageFingerprintSha256', 'pageFingerprintOrderVerified=$true', '-Environment (Get-MinimalWindowsProcessEnvironment)', 'PdfiumProofRoot', 'PdfiumProofTimeoutMilliseconds',
    ]) expect(source).toContain(marker);
  });

  it('requires three stable positive bounded snapshots and handles a refused status endpoint cleanly', () => {
    const result = runPowerShell(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-structural-page-tools.ps1
      $script:StructuralPins.OutputBytesMaximum=16;$script:now=[datetime]::UtcNow;$clock={$script:now};$sleep={param($milliseconds)$script:now=$script:now.AddMilliseconds($milliseconds)}
      $script:snapshots=[Collections.Generic.Queue[object]]::new();$script:snapshots.Enqueue([pscustomobject]@{exists=$true;reparse=$false;bytes=[uint64]0;sha256=('A'*64)});1..3|ForEach-Object{$script:snapshots.Enqueue([pscustomobject]@{exists=$true;reparse=$false;bytes=[uint64]4;sha256=('B'*64)})}
      $receipt=Wait-StructuralStableFile -Path 'unused.pdf' -Deadline $script:now.AddSeconds(2) -SnapshotProvider {param($path)$script:snapshots.Dequeue()} -SleepProvider $sleep -UtcNowProvider $clock
      if($receipt.bytes-ne4-or$receipt.sha256-cne('B'*64)-or$script:snapshots.Count-ne0){throw 'Stable-file gate did not require three exact positive snapshots.'}
      $script:now=[datetime]::UtcNow;$calls=0;$refused=$false;$statusSleep={param($milliseconds)$script:now=$script:now.AddSeconds(3)}
      try{Wait-StructuralDriverReady -Driver ([pscustomobject]@{HasExited=$false}) -Deadline $script:now.AddSeconds(2) -StatusProvider {param($deadline)$script:calls++;throw 'connection refused'} -SleepProvider $statusSleep -UtcNowProvider $clock|Out-Null}catch{$refused=$_.Exception.Message-ceq'Pinned tauri-driver did not become ready for structural page tools.'}
      if(-not$refused-or$calls-ne1){throw 'Refused status endpoint caused an uninitialized status or unbounded retry.'}
      Initialize-StructuralPdfiumProof;if($null-eq('SignedPdfiumStructuralProof'-as[type])){throw 'Structural PDFium proof type did not compile.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(source).toContain('$status = $null');
  });

  it('accepts only bounded child-process PDFium proof records and kills a stalled native proof', () => {
    const result = runPowerShell(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-structural-page-tools.ps1
      $root=Split-Path -Parent $PSCommandPath;$pdfium=Join-Path $root 'pdfium.dll';$pdf=Join-Path $root 'source.pdf';[IO.File]::WriteAllBytes($pdfium,[byte[]](1));[IO.File]::WriteAllBytes($pdf,[byte[]](2))
      $success=Join-Path $root 'success-helper.ps1';$successSource=@'
param([string]$PdfiumPath,[string]$PdfPath,[int]$ExpectedPages,[string]$OutputPath)
$hashes=[string[]](1..$ExpectedPages|ForEach-Object{$_.ToString('X64')});$record=[ordered]@{pages=$ExpectedPages;widthPoints=[double[]](1..$ExpectedPages|ForEach-Object{612});heightPoints=[double[]](1..$ExpectedPages|ForEach-Object{792});pageFingerprintSha256=$hashes};[IO.File]::WriteAllText($OutputPath,($record|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
'@;[IO.File]::WriteAllText($success,$successSource,[Text.UTF8Encoding]::new($false))
      $proof=Get-StructuralPdfiumProof -PdfiumPath $pdfium -PdfPath $pdf -ExpectedPages 2 -ProofPath (Join-Path $root 'success.json') -Deadline ([datetime]::UtcNow.AddSeconds(5)) -HelperPath $success
      if($proof.Pages-ne2-or@($proof.PageFingerprintSha256).Count-ne2-or$proof.WidthPoints[0]-ne612-or$proof.HeightPoints[1]-ne792){throw 'Bounded proof child result changed.'}
      $stall=Join-Path $root 'stall-helper.ps1';$stallSource=@'
param([string]$PdfiumPath,[string]$PdfPath,[int]$ExpectedPages,[string]$OutputPath)
Start-Sleep -Seconds 30
'@;[IO.File]::WriteAllText($stall,$stallSource,[Text.UTF8Encoding]::new($false))
      $watch=[Diagnostics.Stopwatch]::StartNew();$rejected=$false
      try{Get-StructuralPdfiumProof -PdfiumPath $pdfium -PdfPath $pdf -ExpectedPages 2 -ProofPath (Join-Path $root 'stall.json') -Deadline ([datetime]::UtcNow.AddMilliseconds(300)) -HelperPath $stall|Out-Null}catch{$rejected=$_.Exception.Message-like'Structural PDFium proof exceeded its killable deadline*'}
      if(-not$rejected-or$watch.ElapsedMilliseconds-gt7000){throw 'Stalled structural PDFium proof was not killed within its bounded deadline.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
