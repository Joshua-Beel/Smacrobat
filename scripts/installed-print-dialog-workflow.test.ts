import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function runPowerShell7(source: string) {
  const root = `target/print-dialog-test-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  const path = `${root}/run.ps1`;
  writeFileSync(path, source, 'utf8');
  return spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], { encoding: 'utf8', timeout: 30_000 });
}

describe('installed native print dialog verifier', () => {
  it('uses process-bound inbox UI Automation without coordinate or blind-key input', () => {
    const source = readFileSync('scripts/installed-print-dialog.ps1', 'utf8');
    expect(source).toContain('Add-Type -AssemblyName UIAutomationClient');
    expect(source).toContain('[Windows.Automation.AutomationElement]::ProcessIdProperty');
    expect(source).toContain('Assert-ProcessUiElement');
    expect(source).toContain('[Windows.Automation.InvokePattern]::Pattern');
    expect(source).toContain('[Windows.Automation.SelectionItemPattern]::Pattern');
    expect(source).toContain('[Windows.Automation.ValuePattern]::Pattern');
    expect(source).not.toMatch(/SendKeys|mouse_event|SetCursorPos|ClickInput|pyautogui/i);
    expect(source).not.toMatch(/Enable-WindowsOptionalFeature|Add-WindowsCapability|dism(?:\.exe)?/i);
  });

  it('binds cancel transport, reopen, conditional PDF output, parsing, correlation, and cleanup', () => {
    const source = readFileSync('scripts/installed-print-dialog.ps1', 'utf8');
    expect(source).toContain("-Prefix 'Printing canceled.'");
    expect(source.match(/Open-NativePrintDialogFromWebView -SessionId/g)).toHaveLength(2);
    expect(source).toContain('if ([bool]$PrinterFacts.microsoftPrintToPdfAvailable)');
    expect(source).toContain("-Prefix '1 page submitted to the printer.'");
    expect(source).toContain('FPDF_LoadMemDocument64');
    expect(source).toContain('Compare-PdfiumPrintProof');
    expect(source).toContain('$Output.Pages -ne 1');
    expect(source).toContain('Invoke-SessionDeleteOutcome');
    expect(source).toContain('Stop-OwnedLaunchProcesses');
    expect(source).toContain('relevantProcessesRemaining 0');
  });

  it('classifies printer capability exactly and never claims feature installation', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      $none=Get-PrintCapabilityFacts -PrinterProvider { @() };Assert-PrintCapabilityFacts $none
      if($none.printerCount-ne0-or$none.anyPrinterAvailable-or$none.microsoftPrintToPdfAvailable-or$none.featureInstallationAttempted){throw 'Empty printer classification changed.'}
      $pdf=Get-PrintCapabilityFacts -PrinterProvider { @([pscustomobject]@{Name='Microsoft Print to PDF'}) };Assert-PrintCapabilityFacts $pdf
      if($pdf.printerCount-ne1-or-not$pdf.anyPrinterAvailable-or-not$pdf.microsoftPrintToPdfAvailable-or$pdf.featureInstallationAttempted){throw 'PDF printer classification changed.'}
      $other=Get-PrintCapabilityFacts -PrinterProvider { @([pscustomobject]@{Name='Fixture printer'}) };Assert-PrintCapabilityFacts $other
      if(-not$other.anyPrinterAvailable-or$other.microsoftPrintToPdfAvailable){throw 'Non-PDF printer classification changed.'}
      $rejected=$false;try{Get-PrintCapabilityFacts -PrinterProvider { @([pscustomobject]@{Name='x'},[pscustomobject]@{Name='X'}) }}catch{$rejected=$true};if(-not$rejected){throw 'Duplicate printer identity accepted.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('keeps PDF proof inputs bounded and compiles the pinned PDFium proof bridge', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      Initialize-PdfiumPrintProof
      if(-not('SignedPdfiumPrintProof' -as [type])){throw 'PDFium proof bridge did not compile.'}
      $same=[byte[]](1,2,3,4);$corr=[SignedPdfiumPrintProof]::Correlation($same,$same);$diff=[SignedPdfiumPrintProof]::MeanAbsoluteDifference($same,$same)
      if([Math]::Abs($corr-1)-gt0.000001-or$diff-ne0){throw 'Fingerprint comparison changed.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('does not assign to PowerShell automatic or read-only variables', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-print-dialog.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Print helper did not parse.'}
      $forbidden=@('args','error','executioncontext','foreach','home','host','input','lastexitcode','matches','myinvocation','nestedpromptlevel','ofs','pid','pscommandpath','psscriptroot','psversiontable','pwd','shellid','stacktrace','this')
      $assigned=@($ast.FindAll({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left-is[Management.Automation.Language.VariableExpressionAst]},$true)|ForEach-Object{$_.Left.VariablePath.UserPath.ToLowerInvariant()})
      $collisions=@($assigned|Where-Object{$forbidden-contains$_});if($collisions.Count){throw ('Print helper assigns automatic/read-only variables: '+($collisions-join','))}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('labels native timeout stages and emits only bounded process-owned UI structure counts', () => {
    const source = readFileSync('scripts/installed-print-dialog.ps1', 'utf8');
    for (const stage of ['first-print-dialog', 'second-print-dialog', 'current-page-control', 'save-output-dialog', 'final-native-cleanup']) {
      expect(source).toContain(`'${stage}'`);
    }
    expect(source).toContain('uiStructure=$structure');
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      function New-UiFixture([int]$ownedProcessId,[string]$type){
        [pscustomobject]@{Current=[pscustomobject]@{ProcessId=$ownedProcessId;ControlType=[pscustomobject]@{ProgrammaticName=$type};Name='Secret C:\Users\runneradmin\document.pdf';BoundingRectangle='10,20,30,40'}}
      }
      $ownedProcessId=7319
      $script:fixtureElements=@(
        (New-UiFixture $ownedProcessId 'ControlType.Window'),(New-UiFixture $ownedProcessId 'ControlType.Button'),
        (New-UiFixture $ownedProcessId 'ControlType.RadioButton'),(New-UiFixture $ownedProcessId 'ControlType.Edit'),
        (New-UiFixture $ownedProcessId 'ControlType.Custom')
      )
      $provider={param($requestedProcessId,$windowsOnly)if($requestedProcessId-ne$ownedProcessId){throw 'wrong owner'};if($windowsOnly){@($script:fixtureElements[0])}else{@($script:fixtureElements)}}
      $receipt=Get-SanitizedProcessUiStructureReceipt -ProcessId $ownedProcessId -ElementProvider $provider
      Assert-PrintExactProperties -Value $receipt -Expected @('inventoryStatus','topLevelWindowCount','processElementCount','windowCount','paneCount','buttonCount','radioButtonCount','comboBoxCount','editCount','listCount','listItemCount','otherCount') -Kind 'Sanitized UI structure receipt'
      if($receipt.inventoryStatus-cne'available'-or$receipt.topLevelWindowCount-ne1-or$receipt.processElementCount-ne5-or$receipt.windowCount-ne1-or$receipt.buttonCount-ne1-or$receipt.radioButtonCount-ne1-or$receipt.editCount-ne1-or$receipt.otherCount-ne1){throw 'Sanitized UI structure counts changed.'}
      $json=Get-SanitizedProcessUiStructureJson -ProcessId $ownedProcessId -ElementProvider $provider
      if($json-match'(?i)(secret|users|document\.pdf|7319|bounding|rectangle|caption|"name"|"text"|"path"|"processid")'){throw 'Sanitized UI structure leaked private UI data.'}
      $unavailable=Get-SanitizedProcessUiStructureJson -ProcessId $ownedProcessId -ElementProvider {throw 'Secret C:\Users\runneradmin\document.pdf'}
      if($unavailable-cnotmatch'"inventoryStatus":"unavailable"'-or$unavailable-match'(?i)(secret|users|document\.pdf|7319)'){throw 'Unavailable UI diagnostics leaked raw failure data.'}
      $script:expiredProviderInvoked=$false
      $expired=Get-SanitizedProcessUiStructureJson -ProcessId $ownedProcessId -DeadlineExpired -ElementProvider {$script:expiredProviderInvoked=$true;throw 'Secret C:\Users\runneradmin\document.pdf'}
      if($script:expiredProviderInvoked-or$expired-cnotmatch'"inventoryStatus":"unavailable"'-or$expired-match'(?i)(secret|users|document\.pdf|7319)'){throw 'Expired UI diagnostics called a provider or leaked raw data.'}
      $observed=Get-SanitizedObservedUiStructureJson -ProcessId $ownedProcessId -Elements @($script:fixtureElements[0],$script:fixtureElements[1]) -Scope 'top-level'
      if($observed-cnotmatch'"inventoryStatus":"top-level-observed"'-or$observed-cnotmatch'"topLevelWindowCount":2'-or$observed-cnotmatch'"processElementCount":-1'-or$observed-match'(?i)(secret|users|document\.pdf|7319|bounding|rectangle|caption|"name"|"text"|"path"|"processid")'){throw 'Observed UI diagnostics were not bounded and sanitized.'}
      $foreign={param($requestedProcessId,$windowsOnly)@((New-UiFixture 7320 'ControlType.Window'))}
      $rejected=$false;try{Get-SanitizedProcessUiStructureReceipt -ProcessId $ownedProcessId -ElementProvider $foreign|Out-Null}catch{$rejected=$true};if(-not$rejected){throw 'Foreign UI diagnostic element was accepted.'}
      $script:PrintPins.UiElementMaximum=2
      $oversized={param($requestedProcessId,$windowsOnly)@((New-UiFixture $ownedProcessId 'ControlType.Window'),(New-UiFixture $ownedProcessId 'ControlType.Button'),(New-UiFixture $ownedProcessId 'ControlType.Edit'))}
      $rejected=$false;try{Get-SanitizedProcessUiStructureReceipt -ProcessId $ownedProcessId -ElementProvider $oversized|Out-Null}catch{$rejected=$true};if(-not$rejected){throw 'Oversized UI diagnostic inventory was accepted.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('does not start a UI Automation inventory when a native deadline is already expired', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      $script:postDeadlineCalls=0
      function Get-ProcessUiElements {$script:postDeadlineCalls++;throw 'UI Automation inventory started after expiry.'}
      foreach($kind in @('element','closed')){
        $rejected=$false
        try{
          if($kind-ceq'element'){Wait-ProcessUiElement -ProcessId 7319 -Names @('Print') -WindowsOnly -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddSeconds(-1))|Out-Null}
          else{Wait-ProcessUiWindowClosed -ProcessId 7319 -Names @('Print') -Stage 'final-native-cleanup' -Deadline ([datetime]::UtcNow.AddSeconds(-1))}
        }catch{$rejected=$true;if($_.Exception.Message-cnotmatch'"inventoryStatus":"unavailable"'){throw}}
        if(-not$rejected){throw 'Expired native wait did not fail closed.'}
      }
      if($script:postDeadlineCalls-ne0){throw 'Expired native wait started UI Automation.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('retains sanitized observed counts when an exact native match is ambiguous', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      function New-AmbiguousWindow {
        [pscustomobject]@{Current=[pscustomobject]@{ProcessId=7319;ControlType=[pscustomobject]@{ProgrammaticName='ControlType.Window'};Name='Print';BoundingRectangle='10,20,30,40'}}
      }
      function Get-ProcessUiElements {param([int]$ProcessId,[switch]$WindowsOnly)@((New-AmbiguousWindow),(New-AmbiguousWindow))}
      $message=''
      try{Wait-ProcessUiElement -ProcessId 7319 -Names @('Print') -ControlTypes @('ControlType.Window') -WindowsOnly -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(50))|Out-Null}catch{$message=$_.Exception.Message}
      if($message-cnotmatch'"inventoryStatus":"top-level-observed"'-or$message-cnotmatch'"topLevelWindowCount":2'-or$message-cnotmatch'"windowCount":2'){throw 'Ambiguous owned windows did not retain sanitized observed counts.'}
      if($message-match'(?i)(bounding|rectangle|caption|"name"|"text"|"path"|"processid"|7319)'){throw 'Ambiguous-match diagnostics leaked private UI data.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('maps every native wait callsite to its exact diagnostic stage', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\\scripts\\installed-print-dialog.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Installed print script did not parse.'}
      $calls=@($ast.FindAll({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-in@('Wait-ProcessUiElement','Wait-ProcessUiWindowClosed')},$true))
      $actual=@($calls|ForEach-Object{
        $elements=@($_.CommandElements);$stageIndex=-1
        for($index=0;$index-lt$elements.Count;$index++){if($elements[$index]-is[Management.Automation.Language.CommandParameterAst]-and$elements[$index].ParameterName-ceq'Stage'){$stageIndex=$index;break}}
        if($stageIndex-lt0-or$stageIndex+1-ge$elements.Count){throw ('Native wait is missing its stage: '+$_.Extent.Text)}
        $argument=$elements[$stageIndex+1]
        if($argument-is[Management.Automation.Language.StringConstantExpressionAst]){$stage=[string]$argument.Value}
        elseif($argument-is[Management.Automation.Language.VariableExpressionAst]){$stage='$'+$argument.VariablePath.UserPath}
        else{throw ('Native wait stage is not an exact literal or validated parameter: '+$_.Extent.Text)}
        ($_.GetCommandName()+':'+$stage)
      }|Sort-Object)
      $expected=@(
        'Wait-ProcessUiElement:$Stage','Wait-ProcessUiElement:current-page-control','Wait-ProcessUiElement:save-output-dialog','Wait-ProcessUiElement:second-print-dialog',
        'Wait-ProcessUiWindowClosed:$Stage','Wait-ProcessUiWindowClosed:final-native-cleanup','Wait-ProcessUiWindowClosed:save-output-dialog','Wait-ProcessUiWindowClosed:second-print-dialog'
      )|Sort-Object
      if(($actual-join'|')-cne($expected-join'|')){throw ('Native wait stage mapping changed: '+($actual-join','))}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('caps phases by one deadline and rejects rogue processes, foreign UIA, incomplete cleanup, and weak correlation', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      $total=[datetime]::UtcNow.AddSeconds(1);$phase=Get-PrintPhaseDeadline -TotalDeadline $total -MaximumMilliseconds 60000
      if($phase-gt$total){throw 'Phase deadline escaped total deadline.'}
      foreach($bad in @(0,-1)){$rejected=$false;try{Get-PrintPhaseDeadline -TotalDeadline $total -MaximumMilliseconds $bad}catch{$rejected=$true};if(-not$rejected){throw 'Invalid phase duration accepted.'}}
      $rejected=$false;try{Get-PrintPhaseDeadline -TotalDeadline ([datetime]::UtcNow.AddMilliseconds(-1)) -MaximumMilliseconds 1}catch{$rejected=$true};if(-not$rejected){throw 'Expired total deadline accepted.'}
      $app='C:\fixture\pdf-workstation.exe';$edge='C:\fixture\msedgedriver.exe';$owned=@([pscustomobject]@{Path=$app},[pscustomobject]@{Path=$edge},[pscustomobject]@{Path='C:\fixture\msedgewebview2.exe'})
      Assert-PrintOwnedExecutables -Owned $owned -ApplicationPath $app -EdgeDriverPath $edge
      $rejected=$false;try{Assert-PrintOwnedExecutables -Owned @($owned+[pscustomobject]@{Path='C:\fixture\rogue.exe'}) -ApplicationPath $app -EdgeDriverPath $edge}catch{$rejected=$true};if(-not$rejected){throw 'Unexpected descendant accepted.'}
      Assert-ProcessUiElement -Element ([pscustomobject]@{Current=[pscustomobject]@{ProcessId=42}}) -ProcessId 42
      $rejected=$false;try{Assert-ProcessUiElement -Element ([pscustomobject]@{Current=[pscustomobject]@{ProcessId=43}}) -ProcessId 42}catch{$rejected=$true};if(-not$rejected){throw 'Foreign UI Automation element accepted.'}
      $clean=[pscustomobject]@{sessionDeleted=$true;ownedProcessTreeStopped=$true;relevantProcessesRemaining=0};Assert-PrintCleanupResult $clean
      foreach($mutation in @('session','tree','residual')){$bad=$clean|Select-Object *;if($mutation-ceq'session'){$bad.sessionDeleted=$false}elseif($mutation-ceq'tree'){$bad.ownedProcessTreeStopped=$false}else{$bad.relevantProcessesRemaining=1};$rejected=$false;try{Assert-PrintCleanupResult $bad}catch{$rejected=$true};if(-not$rejected){throw ('Unsafe cleanup accepted: '+$mutation)}}
      Initialize-PdfiumPrintProof;$source=[pscustomobject]@{Fingerprint=[byte[]](1,40,100,220)};$good=[pscustomobject]@{Pages=1;Fingerprint=[byte[]](1,40,100,220)};Compare-PdfiumPrintProof $source $good|Out-Null
      foreach($bad in @([pscustomobject]@{Pages=2;Fingerprint=[byte[]](1,40,100,220)},[pscustomobject]@{Pages=1;Fingerprint=[byte[]](220,100,40,1)})){$rejected=$false;try{Compare-PdfiumPrintProof $source $bad}catch{$rejected=$true};if(-not$rejected){throw 'Unsafe PDF proof accepted.'}}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
