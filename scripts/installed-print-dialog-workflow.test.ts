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

  it('waits through the bounded fixed-port handoff before starting fresh print deadlines and the driver', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-app-launch.ps1
      . ./scripts/installed-print-dialog.ps1
      if($script:PrintPins.PortHandoffTimeoutMilliseconds-ne300000-or$script:PrintPins.TotalTimeoutMilliseconds-ne240000-or$script:PrintPins.NativeDialogTimeoutMilliseconds-ne120000){throw 'Print handoff, shared, or native timeout pin changed.'}
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-print-dialog.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Installed print script did not parse.'}
      $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq'Invoke-RealInstalledPrintDialog'},$true)
      $handoffDeadline=$function.Body.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$handoffDeadline'},$true)
      $handoff=$function.Body.Find({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-ceq'Wait-FixedWebDriverPortsFree'},$true)
      $deadline=$function.Body.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$deadline'},$true)
      $startedAfter=$function.Body.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$startedAfter'},$true)
      $startDriver=$function.Body.Find({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-ceq'Start-BoundedDiscardProcess'},$true)
      if($null-eq$handoffDeadline-or$null-eq$handoff-or$null-eq$deadline-or$null-eq$startedAfter-or$null-eq$startDriver-or
        $handoffDeadline.Extent.Text-cnotmatch'PortHandoffTimeoutMilliseconds'-or$deadline.Extent.Text-cnotmatch'TotalTimeoutMilliseconds'-or
        $handoffDeadline.Extent.StartOffset-ge$handoff.Extent.StartOffset-or$handoff.Extent.StartOffset-ge$deadline.Extent.StartOffset-or
        $deadline.Extent.StartOffset-ge$startedAfter.Extent.StartOffset-or$startedAfter.Extent.StartOffset-ge$startDriver.Extent.StartOffset){throw 'Print port handoff and fresh deadline ordering changed.'}
      if($function.Extent.Text-cmatch'Assert-FixedWebDriverPortsFree'){throw 'Print verification bypassed the bounded fixed-port handoff wait.'}
      $script:expiredProbeCalls=0
      $rejected=$false;try{Wait-FixedWebDriverPortsFree -Deadline ([datetime]::UtcNow.AddMilliseconds(-1)) -ProbeProvider {$script:expiredProbeCalls++}}catch{$rejected=$true}
      if(-not$rejected-or$script:expiredProbeCalls-ne0){throw 'Expired print port handoff performed a port probe.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
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

  it('enumerates only targeted descendants below validated owned roots and fails closed after a delayed query', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      function New-EnumerationElement([int]$ownedProcessId,[int]$runtimePart,[string]$type){
        $element=[pscustomobject]@{RuntimePart=$runtimePart;Current=[pscustomobject]@{ProcessId=$ownedProcessId;ControlType=[pscustomobject]@{ProgrammaticName=$type}}}
        $element|Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value {[int[]]@(91,$this.RuntimePart)}
        return $element
      }
      $desktop=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=0}}
      $top=New-EnumerationElement 7319 1 'ControlType.Pane'
      $child=New-EnumerationElement 7319 2 'ControlType.Button'
      $child2=New-EnumerationElement 7319 3 'ControlType.Edit'
      $finder={param($root,$scope,$condition)
        $script:enumerationCalls+=([pscustomobject]@{Root=$root;Scope=$scope;ConditionType=$condition.GetType().Name})
        if([object]::ReferenceEquals($root,$desktop)){
          if($scope-ne[Windows.Automation.TreeScope]::Children){throw 'Desktop-wide descendants were scanned.'}
          return @($top)
        }
        if(-not[object]::ReferenceEquals($root,$top)-or$scope-ne[Windows.Automation.TreeScope]::Descendants){throw 'Unexpected UIA enumeration root or scope.'}
        if($script:descendantCase-ceq'zero'){return @()}
        if($script:descendantCase-ceq'one'){return $child}
        return @($child,$child2,$child)
      }
      foreach($fixture in @([pscustomobject]@{Name='zero';Count=1},[pscustomobject]@{Name='one';Count=2},[pscustomobject]@{Name='many';Count=3})){
        $script:descendantCase=[string]$fixture.Name;$script:enumerationCalls=@()
        $items=@(Get-ProcessUiElements -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(1)) -DesktopProvider { $desktop } -FindAllProvider $finder)
        if($items.Count-ne[int]$fixture.Count-or-not[object]::ReferenceEquals($items[0],$top)){throw ('Rooted UIA '+$fixture.Name+' result did not retain array Count under strict mode.')}
        if($script:enumerationCalls.Count-ne2-or$script:enumerationCalls[0].Scope-ne[Windows.Automation.TreeScope]::Children-or$script:enumerationCalls[0].ConditionType-cne'PropertyCondition'-or$script:enumerationCalls[1].Scope-ne[Windows.Automation.TreeScope]::Descendants-or$script:enumerationCalls[1].ConditionType-cne'AndCondition'){throw 'UIA enumeration did not use process-owned roots then the native targeted condition.'}
      }
      if(-not[object]::ReferenceEquals($items[1],$child)-or-not[object]::ReferenceEquals($items[2],$child2)){throw 'Rooted UIA enumeration did not merge bounded unique runtime identities.'}
      $script:lateRootedCallReturned=$false
      $slowFinder={param($root,$scope,$condition)if([object]::ReferenceEquals($root,$desktop)){return @($top)};Start-Sleep -Milliseconds 80;$script:lateRootedCallReturned=$true;return @($child)}
      $rejected=$false;try{Get-ProcessUiElements -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddMilliseconds(20)) -DesktopProvider { $desktop } -FindAllProvider $slowFinder|Out-Null}catch{$rejected=$true}
      if(-not$rejected-or-not$script:lateRootedCallReturned){throw 'A rooted UIA call that returned after its deadline was accepted.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const source = readFileSync('scripts/installed-print-dialog.ps1', 'utf8');
    expect(source).toContain('$desktop.FindAll([Windows.Automation.TreeScope]::Children');
    expect(source).not.toContain('$desktop.FindAll([Windows.Automation.TreeScope]::Descendants');
    expect(source.match(/\.FindAll\(\[Windows\.Automation\.TreeScope\]::Descendants,/g)).toHaveLength(2);
    expect(source.match(/\.FindAll\(\[Windows\.Automation\.TreeScope\]::Descendants,\$descendantCondition\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/FindAll\(\[Windows\.Automation\.TreeScope\]::Descendants,\s*\[Windows\.Automation\.Condition\]::TrueCondition/);
    expect(source).toContain('function New-PrintTargetUiCondition');
    expect(source).toContain('function New-PrintSurfaceUiCondition');
    expect(source).toContain('[Windows.Automation.OrCondition]::new');
    expect(source).toContain('[Windows.Automation.AndCondition]::new');
    expect(source).toContain('$topLevel = @(if ($FindAllProvider)');
    expect(source).toContain('$descendants = @(if ($FindAllProvider)');
    expect(source).toContain('$elements = @(if ($ElementProvider)');
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

  it('preserves exact top-level cleanup baselines and rejects late runtime identity reads', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      function New-HostedTopLevel([int]$ownedProcessId,[int]$runtimePart,[string]$type,[string]$name,[int]$delayMilliseconds=0){
        $element=[pscustomobject]@{RuntimePart=$runtimePart;DelayMilliseconds=$delayMilliseconds;Current=[pscustomobject]@{ProcessId=$ownedProcessId;ControlType=[pscustomobject]@{ProgrammaticName=$type};Name=$name;BoundingRectangle='10,20,30,40'}}
        $element|Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value {if($this.DelayMilliseconds-gt0){Start-Sleep -Milliseconds $this.DelayMilliseconds};[int[]]@(42,$this.RuntimePart)}
        return $element
      }
      $main=New-HostedTopLevel 7319 1 'ControlType.Window' 'PDF Workstation'
      $replacement=New-HostedTopLevel 7319 3 'ControlType.Pane' ''
      $baseline=@(Get-ProcessTopLevelUiSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(1)) -ElementProvider {param($requestedProcessId,$windowsOnly)@($main)})
      $message='';try{Wait-ProcessTopLevelUiBaselineRestored -ProcessId 7319 -Baseline $baseline -Stage 'first-native-cleanup' -Deadline ([datetime]::UtcNow.AddMilliseconds(250)) -ElementProvider {param($requestedProcessId,$windowsOnly)@($main,$replacement)}}catch{$message=$_.Exception.Message}
      if($message-cnotmatch'exact top-level baseline'-or$message-cnotmatch'"topLevelWindowCount":2'-or$message-cnotmatch'"paneCount":1'){throw 'An extra replacement surface was accepted after first cancellation.'}
      $absorbedBaseline=@(Get-ProcessTopLevelUiSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(1)) -ElementProvider {param($requestedProcessId,$windowsOnly)@($main,$replacement)})
      $rejected=$false;try{Assert-ProcessTopLevelUiBaselineMatch -ProcessId 7319 -Expected $baseline -Actual $absorbedBaseline -Deadline ([datetime]::UtcNow.AddSeconds(1))}catch{$rejected=$true};if(-not$rejected){throw 'A replacement surface was absorbed into the second-attempt baseline.'}
      $foreign=New-HostedTopLevel 7320 4 'ControlType.Pane' ''
      $rejected=$false;try{Get-ProcessTopLevelUiSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(1)) -ElementProvider {param($requestedProcessId,$windowsOnly)@($foreign)}|Out-Null}catch{$rejected=$true};if(-not$rejected){throw 'Foreign top-level surface was accepted.'}
      $delayed=New-HostedTopLevel 7319 6 'ControlType.Pane' '' 80
      $rejected=$false;try{Get-ProcessTopLevelUiSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddMilliseconds(20)) -ElementProvider {param($requestedProcessId,$windowsOnly)@($delayed)}|Out-Null}catch{$rejected=$true};if(-not$rejected){throw 'A runtime identity read completed successfully after its deadline.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const source = readFileSync('scripts/installed-print-dialog.ps1', 'utf8');
    expect(source).toContain('$element.GetRuntimeId()');
    expect(source).toContain("-Baseline $originalNativeBaseline -Stage 'first-native-cleanup'");
    expect(source).toContain('-Expected $originalNativeBaseline -Actual $secondNativeBaseline');
    expect(source).toContain("-Baseline $originalNativeBaseline -Stage 'final-native-cleanup'");
    expect(source).not.toContain("-Baseline $secondNativeBaseline -Stage 'final-native-cleanup'");
  });

  it('binds a descendant delta inside an unchanged owned top-level surface and rejects other ancestry', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      function New-TreeElement([int]$ownedProcessId,[int]$runtimePart,[string]$type,[string]$name,$parent){
        $element=[pscustomobject]@{RuntimePart=$runtimePart;Parent=$parent;Clicked=$false;Current=[pscustomobject]@{ProcessId=$ownedProcessId;ControlType=[pscustomobject]@{ProgrammaticName=$type};Name=$name;AutomationId=''}}
        $element|Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value {[int[]]@(77,$this.RuntimePart)}
        return $element
      }
      $desktop=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=0}}
      $main=New-TreeElement 7319 1 'ControlType.Window' 'PDF Workstation' $desktop
      $pane=New-TreeElement 7319 2 'ControlType.Pane' '' $desktop
      $outside=New-TreeElement 7319 3 'ControlType.Button' 'Cancel' $main
      $existingSibling=New-TreeElement 7319 14 'ControlType.Pane' '' $pane
      $dialog=New-TreeElement 7319 4 'ControlType.Pane' '' $pane
      $inside=New-TreeElement 7319 5 'ControlType.Button' 'Cancel' $dialog
      $print=New-TreeElement 7319 6 'ControlType.Button' 'Print' $dialog
      $current=New-TreeElement 7319 12 'ControlType.RadioButton' 'Current Page' $dialog
      $combo=New-TreeElement 7319 13 'ControlType.ComboBox' '' $dialog
      $script:treeElements=@($main,$pane,$outside,$existingSibling)
      $provider={param($requestedProcessId,$windowsOnly,$kind)
        if($windowsOnly){return @($main,$pane)}
        if($kind-ceq'surfaces'){return @($script:treeElements|Where-Object{$_.Current.ControlType.ProgrammaticName-in@('ControlType.Window','ControlType.Pane')})}
        return @($script:treeElements|Where-Object{
          $type=[string]$_.Current.ControlType.ProgrammaticName;$name=[string]$_.Current.Name
          ($type-ceq'ControlType.Button'-and$name-in@('Cancel','Print','Save'))-or
          ($type-ceq'ControlType.RadioButton'-and$name-in@('Current Page','Current page'))-or$type-ceq'ControlType.ComboBox'
        })
      }
      $parents={param($element)$element.Parent}
      $baseline=@(Get-ProcessUiTreeSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(1)) -ElementProvider $provider -ParentProvider $parents)
      $script:treeElements=@($main,$pane,$outside,$existingSibling,$dialog,$inside,$print,$current,$combo)
      $binding=Wait-NewProcessUiSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddSeconds(1)) -ElementProvider $provider -ParentProvider $parents
      if([string]$binding.surfaceRootIdentity-cne'77:4'-or@($binding.trackedIdentities).Count-ne4){throw 'Descendant delta did not bind its exact independently observed surface and target set.'}
      $found=Find-BoundProcessUiElement -ProcessId 7319 -Binding $binding -Names @('Cancel') -ControlTypes @('ControlType.Button') -Deadline ([datetime]::UtcNow.AddSeconds(1)) -ElementProvider $provider -ParentProvider $parents
      if(-not[object]::ReferenceEquals($found,$inside)){throw 'A baseline matching control outside the descendant delta was accepted.'}
      $script:treeElements=@($main,$pane,$outside,$existingSibling,$dialog,$inside,$current,$combo)
      $message='';try{Wait-NewProcessUiSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(50)) -ElementProvider $provider -ParentProvider $parents|Out-Null}catch{$message=$_.Exception.Message}
      if($message-cnotmatch'one process-owned descendant surface'){throw 'A partial print-dialog target set without Print was accepted.'}
      $other=New-TreeElement 7319 7 'ControlType.Button' 'Save' $main
      $script:treeElements=@($main,$pane,$outside,$existingSibling,$dialog,$inside,$print,$current,$combo,$other)
      $message='';try{Wait-NewProcessUiSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(50)) -ElementProvider $provider -ParentProvider $parents|Out-Null}catch{$message=$_.Exception.Message}
      if($message-cnotmatch'one process-owned descendant surface'-or$message-cnotmatch'baselineUiStructure='-or$message-cnotmatch'postUiStructure='-or$message-cnotmatch'newUiStructure='){throw 'Mixed-root descendant delta did not fail with bounded evidence.'}
      if($message-match'(?i)(runtimeIdentity|77:|PDF Workstation|bounding|rectangle|caption|"name"|"text"|"path"|"processid"|7319)'){throw 'Descendant-delta diagnostics leaked private UI data.'}
      $outsidePrint=New-TreeElement 7319 9 'ControlType.Button' 'Print' $existingSibling
      $script:treeElements=@($main,$pane,$outside,$existingSibling,$dialog,$inside,$print,$current,$combo,$outsidePrint)
      $message='';try{Wait-NewProcessUiSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(50)) -ElementProvider $provider -ParentProvider $parents|Out-Null}catch{$message=$_.Exception.Message}
      if($message-cnotmatch'one process-owned descendant surface'-or$outsidePrint.Clicked){throw 'A same-top-level sibling Print widened the bound surface or was clicked.'}
      $outsideCancel=New-TreeElement 7319 10 'ControlType.Button' 'Cancel' $existingSibling
      $script:treeElements=@($main,$pane,$outside,$existingSibling,$dialog,$inside,$print,$current,$combo,$outsidePrint,$outsideCancel)
      $message='';try{Wait-NewProcessUiSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(50)) -ElementProvider $provider -ParentProvider $parents|Out-Null}catch{$message=$_.Exception.Message}
      if($message-cnotmatch'one process-owned descendant surface'-or$outsidePrint.Clicked-or$outsideCancel.Clicked){throw 'Matching controls in a sibling subtree were accepted or clicked.'}
      $script:treeElements=@($main,$pane,$outside,$existingSibling,$dialog)
      $message='';try{Wait-BoundProcessUiSurfaceClosed -ProcessId 7319 -Binding $binding -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(50)) -ElementProvider $provider -ParentProvider $parents}catch{$message=$_.Exception.Message}
      if($message-cnotmatch'retained'){throw 'Target disappearance falsely proved close while the bound surface remained.'}
      $replacement=New-TreeElement 7319 15 'ControlType.Pane' '' $pane
      $script:treeElements=@($main,$pane,$outside,$existingSibling,$replacement)
      $message='';try{Wait-BoundProcessUiSurfaceClosed -ProcessId 7319 -Binding $binding -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(50)) -ElementProvider $provider -ParentProvider $parents}catch{$message=$_.Exception.Message}
      if($message-cnotmatch'retained'){throw 'A replacement native surface falsely proved close.'}
      $script:treeElements=@($main,$pane,$outside,$existingSibling)
      Wait-BoundProcessUiSurfaceClosed -ProcessId 7319 -Binding $binding -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddSeconds(1)) -ElementProvider $provider -ParentProvider $parents
      $foreign=New-TreeElement 7320 11 'ControlType.Button' 'Cancel' $pane
      $script:treeElements=@($main,$pane,$outside,$existingSibling,$foreign)
      $rejected=$false;try{Get-ProcessUiTreeSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(1)) -ElementProvider $provider -ParentProvider $parents|Out-Null}catch{$rejected=$true};if(-not$rejected){throw 'A foreign descendant was accepted.'}
      $script:treeElements=@($main,$pane,$outside,$existingSibling,$dialog,$inside)
      $slowParents={param($element)Start-Sleep -Milliseconds 80;$element.Parent}
      $rejected=$false;try{Get-ProcessUiTreeSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddMilliseconds(20)) -ElementProvider $provider -ParentProvider $slowParents|Out-Null}catch{$rejected=$true};if(-not$rejected){throw 'A parent read completed successfully after its deadline.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const source = readFileSync('scripts/installed-print-dialog.ps1', 'utf8');
    expect(source.match(/Find-BoundProcessUiElement/g)?.length).toBeGreaterThanOrEqual(8);
    expect(source).toContain('TreeWalker]::RawViewWalker.GetParent');
    expect(source).toContain('-not $baselineIdentities.Contains($surfaceRootIdentity)');
    expect(source).not.toContain('$firstNativeControlBaseline = @(Get-ProcessUiTreeSnapshot');
    expect(source).not.toContain('$secondNativeControlBaseline = @(Get-ProcessUiTreeSnapshot');
  });

  it('uses an exact rooted target query after the hosted surface-only delta', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      function New-HostedElement([int]$runtimePart,[string]$type,[string]$name,$parent){
        $element=[pscustomobject]@{RuntimePart=$runtimePart;Parent=$parent;Current=[pscustomobject]@{ProcessId=7319;ControlType=[pscustomobject]@{ProgrammaticName=$type};Name=$name;AutomationId=''}}
        $element|Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value {[int[]]@(88,$this.RuntimePart)}
        return $element
      }
      $desktop=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=0}}
      $main=New-HostedElement 1 'ControlType.Window' '' $desktop
      $basePane1=New-HostedElement 2 'ControlType.Pane' '' $main
      $basePane2=New-HostedElement 3 'ControlType.Pane' '' $basePane1
      $basePane3=New-HostedElement 4 'ControlType.Pane' '' $basePane2
      $dialog=New-HostedElement 5 'ControlType.Window' '' $desktop
      $newPanes=@();$parent=$dialog
      foreach($index in 1..30){$pane=New-HostedElement (100+$index) 'ControlType.Pane' '' $parent;$newPanes+=$pane;$parent=$pane}
      $cancel=New-HostedElement 201 'ControlType.Button' 'Cancel' $parent
      $print=New-HostedElement 202 'ControlType.Button' 'Print' $parent
      $currentPage=New-HostedElement 203 'ControlType.RadioButton' 'Current Page' $parent
      $combo=New-HostedElement 204 'ControlType.ComboBox' '' $parent
      $script:hostedState='baseline';$script:rootedTargetQueries=0
      $provider={param($requestedProcessId,$windowsOnly,$kind,$root)
        if($windowsOnly){if($script:hostedState-ceq'baseline'){return @($main)};return @($main,$dialog)}
        if($null-ne$root){
          if(-not[object]::ReferenceEquals($root,$dialog)){throw 'Target query escaped the exact new hosted surface.'}
          if($kind-ceq'targets'){$script:rootedTargetQueries++;return @($cancel,$print,$currentPage,$combo)}
          return @($newPanes)
        }
        if($kind-ceq'targets'){return @()}
        if($script:hostedState-ceq'baseline'){return @($main,$basePane1,$basePane2,$basePane3)}
        return @($main,$basePane1,$basePane2,$basePane3,$dialog)+@($newPanes)
      }
      $parents={param($element)$element.Parent}
      $baseline=@(Get-ProcessUiTreeSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -ElementProvider $provider -ParentProvider $parents)
      $baselineReceipt=Get-SanitizedObservedUiStructureJson -ProcessId 7319 -Elements @($baseline|ForEach-Object{$_.element}) -Scope 'process-descendants'
      if($baselineReceipt-cnotmatch'"processElementCount":4'-or$baselineReceipt-cnotmatch'"windowCount":1'-or$baselineReceipt-cnotmatch'"paneCount":3'){throw 'Hosted baseline topology fixture changed.'}
      $script:hostedState='post'
      $post=@(Get-ProcessUiTreeSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -ElementProvider $provider -ParentProvider $parents)
      $postReceipt=Get-SanitizedObservedUiStructureJson -ProcessId 7319 -Elements @($post|ForEach-Object{$_.element}) -Scope 'process-descendants'
      if($postReceipt-cnotmatch'"processElementCount":35'-or$postReceipt-cnotmatch'"windowCount":2'-or$postReceipt-cnotmatch'"paneCount":33'-or@($post|Where-Object{$_.isTarget}).Count-ne0){throw 'Hosted surface-only post topology fixture changed.'}
      $baselineIds=Get-ProcessUiSnapshotIdentitySet -Snapshot $baseline -Kind 'Hosted baseline'
      $postBy=@{};foreach($entry in $post){$postBy.Add([string]$entry.runtimeIdentity,$entry)}
      $newSurfaces=@($post|Where-Object{$_.isSurface-and-not$baselineIds.Contains([string]$_.runtimeIdentity)})
      $common=Get-ProcessUiSnapshotCommonAncestorIdentity -Entries $newSurfaces -EntriesByIdentity $postBy -Deadline ([datetime]::UtcNow.AddSeconds(2))
      if($newSurfaces.Count-ne31-or[string]$common-cne'88:5'){throw 'Hosted surface-only ancestor fixture changed.'}
      $rootedPreview=@(Get-ProcessUiTreeSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -RootElement $dialog -ElementProvider $provider -ParentProvider $parents)
      if(@($rootedPreview|Where-Object{$_.isTarget}).Count-ne4){throw 'Exact rooted hosted target fixture changed.'}
      $binding=Wait-NewProcessUiSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddSeconds(5)) -ElementProvider $provider -ParentProvider $parents
      if([string]$binding.surfaceRootIdentity-cne'88:5'-or$script:rootedTargetQueries-lt2-or@($binding.trackedIdentities).Count-ne35){throw 'Hosted surface delta did not trigger the exact rooted target proof.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('uses exact owned HWND controls when the hosted UIA descendant provider stalls', () => {
    const source = readFileSync('scripts/installed-print-dialog.ps1', 'utf8');
    expect(source).toContain('$firstNativeWindowBaseline = @(Get-ProcessNativeWindowSnapshot');
    expect(source).toContain('-NativeBaseline $firstNativeWindowBaseline');
    expect(source).toContain('-NativeBaseline $secondNativeWindowBaseline');
    expect(source).toContain('Get-ProcessUiElements -ProcessId $ProcessId -RootElement $list.element -Deadline $Deadline');
    expect(source).toContain('[Smacrobat.PrintVerification.NativeWindows]::ComboContainsExact');
    expect(source).toContain('[Smacrobat.PrintVerification.NativeWindows]::SelectComboExact');
    expect(source).toContain('CB_FINDSTRINGEXACT');
    expect(source).toContain('CB_GETCURSEL');
    expect(source).not.toMatch(/CB_GETLBTEXT(?:LEN)?/);
    expect(source).toContain('GetWindowLong(hwnd, -16)');
    expect(source).toContain('GetWindowText(hwnd, label, label.Capacity)');
    expect(source).toContain('AccessKeyLabelEquals(labelValue, "Print")');
    expect(source).toContain('AccessKeyLabelEquals(labelValue, "Cancel")');
    expect(source).toContain('AccessKeyLabelEquals(labelValue, "Current page")');
    expect(source).toContain('AccessKeyLabelEquals(labelValue, "Microsoft Print to PDF")');
    expect(source.match(/ExactComboIndex\(processId, handleValue, value, deadline\)/g)?.length).toBeGreaterThanOrEqual(4);
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      Initialize-PrintNativeWindowInterop
      if(-not[Smacrobat.PrintVerification.NativeWindows]::IsUniqueExactIndex(3,1,1)-or[Smacrobat.PrintVerification.NativeWindows]::IsUniqueExactIndex(3,1,2)){throw 'Duplicate exact native combo indexes were not rejected.'}
      if(-not[Smacrobat.PrintVerification.NativeWindows]::AllEqualToIndex(1,[int[]]@(1,1,1))-or[Smacrobat.PrintVerification.NativeWindows]::AllEqualToIndex(1,[int[]]@(1,2,1))){throw 'Native combo mutation/recheck results were not rejected.'}
      function New-NativeHostedElement([int]$runtimePart,[long]$handle,[string]$type,[string]$name,[string]$automationId=''){
        $element=[pscustomobject]@{RuntimePart=$runtimePart;Current=[pscustomobject]@{ProcessId=7319;NativeWindowHandle=[int]$handle;ControlType=[pscustomobject]@{ProgrammaticName=$type};Name=$name;AutomationId=$automationId}}
        $element|Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value {[int[]]@(99,$this.RuntimePart)}
        return $element
      }
      function New-NativeProviderRecord([long]$handle,[long]$parentHandle,$element,[string]$className,[int]$controlId=0,[bool]$visible=$true,[bool]$enabled=$true){
        return [pscustomobject]@{HandleValue=$handle;ParentHandleValue=$parentHandle;ClassName=$className;ControlId=$controlId;IsVisible=$visible;IsEnabled=$enabled;Element=$element}
      }
      $main=New-NativeHostedElement 1 100 'ControlType.Window' ''
      $dialog=New-NativeHostedElement 2 200 'ControlType.Window' ''
      $cancel=New-NativeHostedElement 3 201 'ControlType.Button' 'Cancel'
      $print=New-NativeHostedElement 4 202 'ControlType.Button' 'Print'
      $currentPage=New-NativeHostedElement 5 203 'ControlType.RadioButton' 'Current Page'
      $printerList=New-NativeHostedElement 6 204 'ControlType.List' ''
      $printerCombo=New-NativeHostedElement 10 205 'ControlType.ComboBox' ''
      $printerItem=New-NativeHostedElement 8 0 'ControlType.ListItem' 'Microsoft Print to PDF'
      $replacement=New-NativeHostedElement 7 300 'ControlType.Window' ''
      $hostedBaseline=@($main)
      foreach($index in 1..3){$hostedBaseline+=New-NativeHostedElement (10+$index) (110+$index) 'ControlType.Pane' ''}
      $hostedPost=@($hostedBaseline)+@($dialog)
      foreach($index in 1..30){$hostedPost+=New-NativeHostedElement (40+$index) (240+$index) 'ControlType.Pane' ''}
      $baselineReceipt=Get-SanitizedObservedUiStructureJson -ProcessId 7319 -Elements $hostedBaseline -Scope 'process-descendants'
      $postReceipt=Get-SanitizedObservedUiStructureJson -ProcessId 7319 -Elements $hostedPost -Scope 'process-descendants'
      if($baselineReceipt-cnotmatch'"processElementCount":4'-or$baselineReceipt-cnotmatch'"windowCount":1'-or$baselineReceipt-cnotmatch'"paneCount":3'){throw 'Hosted HWND baseline topology fixture changed.'}
      if($postReceipt-cnotmatch'"processElementCount":35'-or$postReceipt-cnotmatch'"windowCount":2'-or$postReceipt-cnotmatch'"paneCount":33'){throw 'Hosted HWND post topology fixture changed.'}
      $script:nativeState='baseline';$script:uiaTreeCalls=0
      function Get-ProcessUiTreeSnapshot {$script:uiaTreeCalls++;throw 'The hosted rooted UIA provider stalled.'}
      $provider={param($requestedProcessId,[long]$rootHandle,[bool]$topLevelOnly)
        if($rootHandle-ne0){
          if($rootHandle-ne200){throw 'Native enumeration escaped the exact dialog HWND.'}
          $rootRuntimePart=if($script:nativeState-ceq'mismatch'){9}else{2}
          return @(
            (New-NativeProviderRecord 200 0 (New-NativeHostedElement $rootRuntimePart 200 'ControlType.Window' '') '#32770'),
            (New-NativeProviderRecord 201 200 $cancel 'Button' 2),
            (New-NativeProviderRecord 202 200 $print 'Button' 1),
            (New-NativeProviderRecord 203 200 $currentPage 'Button' 0x0420),
            (New-NativeProviderRecord 204 200 $printerList 'SysListView32' 0x0460),
            (New-NativeProviderRecord 205 200 $printerCombo 'ComboBox' 0x0470)
          )
        }
        if($script:nativeState-ceq'baseline'-or$script:nativeState-ceq'closed'){return @((New-NativeProviderRecord 100 0 $main 'Chrome_WidgetWin_1'))}
        if($script:nativeState-ceq'replacement'){return @((New-NativeProviderRecord 100 0 $main 'Chrome_WidgetWin_1'),(New-NativeProviderRecord 300 0 $replacement '#32770'))}
        return @((New-NativeProviderRecord 100 0 $main 'Chrome_WidgetWin_1'),(New-NativeProviderRecord 200 0 (New-NativeHostedElement 2 200 'ControlType.Window' '') '#32770'))
      }
      $baseline=@(Get-ProcessNativeWindowSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -TopLevelOnly -WindowProvider $provider)
      $script:nativeState='mismatch';$rejected=$false;$mismatchMessage=''
      try{Wait-NewProcessNativeWindowSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(250)) -WindowProvider $provider|Out-Null}catch{$rejected=$true;$mismatchMessage=$_.Exception.Message}
      if(-not$rejected){throw 'A replaced HWND runtime identity was accepted during binding.'}
      if($mismatchMessage-cnotmatch'"inventoryStatus":"native-window-observed"'-or$mismatchMessage-cnotmatch'"candidateSurfaceCount":1'-or$mismatchMessage-cmatch'hwnd:|Private|Secret|HandleValue|ParentHandleValue'){throw 'The HWND binding failure did not preserve only the sanitized observed topology.'}
      $script:nativeState='open'
      $binding=Wait-NewProcessNativeWindowSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddSeconds(2)) -WindowProvider $provider
      if([string]$binding.surfaceRootIdentity-cnotmatch'^hwnd:200\|'-or@($binding.trackedIdentities).Count-ne6-or$script:uiaTreeCalls-ne0){throw 'Exact HWND binding did not bypass the stalled UIA tree provider.'}
      $found=Find-BoundProcessUiElement -ProcessId 7319 -Binding $binding -Names @('Cancel') -ControlTypes @('ControlType.Button') -Deadline ([datetime]::UtcNow.AddSeconds(2)) -NativeWindowProvider $provider
      if(-not[object]::ReferenceEquals($found,$cancel)){throw 'The exact bound HWND control was not preserved.'}
      $targetProvider={param($requestedProcessId,$rootElement)if(-not[object]::ReferenceEquals($rootElement,$printerList)){throw 'Printer query escaped the exact list HWND.'};@($printerItem)}
      $foundPrinter=Find-BoundNativePrinterElement -ProcessId 7319 -Binding $binding -Deadline ([datetime]::UtcNow.AddSeconds(2)) -NativeWindowProvider $provider -TargetProvider $targetProvider
      if(-not[object]::ReferenceEquals($foundPrinter,$printerItem)){throw 'The exact printer item was not found below its bound list HWND.'}
      $script:comboSelectCalls=0
      $duplicateContains={param($requestedProcessId,$handleValue,$value,$remainingMilliseconds)$false}
      $selection={param($requestedProcessId,$handleValue,$value,$remainingMilliseconds)$script:comboSelectCalls++;$true}
      $selected=Select-BoundNativeComboItemExact -ProcessId 7319 -Binding $binding -Value 'Microsoft Print to PDF' -Deadline ([datetime]::UtcNow.AddSeconds(2)) -NativeWindowProvider $provider -ComboContainsProvider $duplicateContains -ComboSelectProvider $selection
      if($selected-or$script:comboSelectCalls-ne0){throw 'A duplicate exact combo result reached selection.'}
      $uniqueContains={param($requestedProcessId,$handleValue,$value,$remainingMilliseconds)$true}
      $mutationSelect={param($requestedProcessId,$handleValue,$value,$remainingMilliseconds)$script:comboSelectCalls++;$false}
      $rejected=$false;try{Select-BoundNativeComboItemExact -ProcessId 7319 -Binding $binding -Value 'Microsoft Print to PDF' -Deadline ([datetime]::UtcNow.AddSeconds(2)) -NativeWindowProvider $provider -ComboContainsProvider $uniqueContains -ComboSelectProvider $mutationSelect|Out-Null}catch{$rejected=$true}
      if(-not$rejected-or$script:comboSelectCalls-ne1){throw 'A combo mutation/recheck failure was accepted.'}
      $successSelect={param($requestedProcessId,$handleValue,$value,$remainingMilliseconds)$script:comboSelectCalls++;$true}
      $selected=Select-BoundNativeComboItemExact -ProcessId 7319 -Binding $binding -Value 'Microsoft Print to PDF' -Deadline ([datetime]::UtcNow.AddSeconds(2)) -NativeWindowProvider $provider -ComboContainsProvider $uniqueContains -ComboSelectProvider $successSelect
      if(-not$selected-or$script:comboSelectCalls-ne2){throw 'An exact stable combo selection was not accepted.'}
      $script:nativeState='replacement';$rejected=$false
      try{Wait-BoundProcessUiSurfaceClosed -ProcessId 7319 -Binding $binding -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(250)) -NativeWindowProvider $provider}catch{$rejected=$true}
      if(-not$rejected){throw 'A replacement HWND surface was accepted as close.'}
      $script:nativeState='closed'
      Wait-BoundProcessUiSurfaceClosed -ProcessId 7319 -Binding $binding -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddSeconds(2)) -NativeWindowProvider $provider
      $slowProvider={param($requestedProcessId,[long]$rootHandle,[bool]$topLevelOnly)Start-Sleep -Milliseconds 40;@((New-NativeProviderRecord 100 0 $main 'Chrome_WidgetWin_1'))}
      $rejected=$false;try{Get-ProcessNativeWindowSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddMilliseconds(20)) -TopLevelOnly -WindowProvider $slowProvider|Out-Null}catch{$rejected=$true}
      if(-not$rejected){throw 'A native HWND snapshot completed after its deadline.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('emits deterministic bounded privacy-safe HWND topology diagnostics', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      $top=@(
        [pscustomobject]@{HandleValue=100L;ParentHandleValue=0L;ClassName='SecretPrivateClass';ControlId=0;IsVisible=$true;IsEnabled=$true;Title='Private document title'},
        [pscustomobject]@{HandleValue=200L;ParentHandleValue=0L;ClassName='#32770';ControlId=0;IsVisible=$true;IsEnabled=$true;Path='C:\private\file.pdf'}
      )
      $candidate=@([pscustomobject][ordered]@{
        ClassName='#32770';ControlId=0;IsVisible=$true;IsEnabled=$true;UiControlType='ControlType.Pane';UiNameMatchesAvailable=$true
        UiNameMatches=[pscustomobject][ordered]@{cancel=$false;print=$true;save=$false;currentPage=$false;printerName=$false;fileName=$false}
      })
      $surface=@([pscustomobject]@{HandleValue=200L;ParentHandleValue=0L;ClassName='#32770';ControlId=0;IsVisible=$true})
      foreach($index in 1..2050){
        $class=if($index-in@(1,4,5)){'Button'}elseif($index-eq2){'ComboBox'}elseif($index-eq3){'SysListView32'}elseif($index-eq6){'Static'}else{'SecretPrivateClass'}
        $controlId=if($index-eq1){2}elseif($index-eq2){0x0470}elseif($index-eq3){0x0460}elseif($index-eq4){1}elseif($index-eq5){0x0420}elseif($index-eq7){0x0497}elseif($index-eq8){0x0498}elseif($index-eq9){70000}else{9000}
        $buttonStyle=if($index-eq1){0}elseif($index-eq4){1}elseif($index-eq5){9}else{-1}
        $parentHandle=if($index-eq6){201L}else{200L}
        $surface+=[pscustomobject]@{
          HandleValue=[long](200+$index);ParentHandleValue=$parentHandle;ClassName=$class;ControlId=$controlId;IsVisible=$true;IsEnabled=$true;ButtonStyle=$buttonStyle
          IsLabelPrint=($index-eq4);IsLabelCancel=($index-eq1);IsLabelCurrentPage=($index-eq5);IsLabelPrinterName=($index-eq6)
          Text='Secret caption';Coordinates='10,20,30,40'
        }
      }
      $roles=[pscustomobject][ordered]@{cancelButton=1;printButton=0;saveButton=0;currentPageRadio=0;namedPrinter=0;printerCombo=1;printerList=1;filenameEdit=0}
      $json=Get-SanitizedNativeWindowTopologyJson -TopLevelRecords $top -CandidateTopLevelRecords $candidate -SurfaceRecords $surface -RoleCounts $roles
      if($json.Length-gt20000-or$json-cmatch'Private|Secret|file\.pdf|10,20|HandleValue|ParentHandleValue|Title|Path|Text|Coordinates'){throw 'HWND topology diagnostic leaked sensitive or raw window data.'}
      $receipt=$json|ConvertFrom-Json
      Assert-PrintExactProperties -Value $receipt -Expected @('inventoryStatus','topLevelOwnedCount','topLevelOwnedVisibleCount','topLevelOwnedEnabledCount','topLevelCountCapped','candidateSurfaceCount','candidateSurfaceCountCapped','visibleDialogCandidateCount','visibleEnabledDialogCandidateCount','candidateTopLevels','childCount','childCountCapped','childDiagnosticsCapped','childDiagnostics','classHistogram','controlIdHistogram','requiredRoleMatchesAvailable','requiredRoleMatches') -Kind 'HWND topology receipt'
      Assert-PrintExactProperties -Value $receipt.candidateTopLevels[0] -Expected @('visible','enabled','classBucket','controlIdBucket','uiaControlTypeBucket','uiaNameMatchesAvailable','uiaNameMatches') -Kind 'HWND candidate receipt'
      Assert-PrintExactProperties -Value $receipt.candidateTopLevels[0].uiaNameMatches -Expected @('cancel','print','save','currentPage','printerName','fileName') -Kind 'HWND candidate name flags'
      Assert-PrintExactProperties -Value $receipt.classHistogram -Expected @('dialog32770','button','comboBox','comboBoxEx32','edit','sysListView32','directUiHwnd','static','sysTabControl32','other') -Kind 'HWND class histogram'
      Assert-PrintExactProperties -Value $receipt.controlIdHistogram -Expected @('idOk','idCancel','pushButtonRange','checkBoxRange','radioButtonRange','groupRange','staticRange','listRange','comboRange','editRange','scrollRange','otherPositive','none') -Kind 'HWND control-ID histogram'
      Assert-PrintExactProperties -Value $receipt.requiredRoleMatches -Expected @('cancelButton','printButton','saveButton','currentPageRadio','namedPrinter','printerCombo','printerList','filenameEdit') -Kind 'HWND role histogram'
      Assert-PrintExactProperties -Value $receipt.childDiagnostics[0] -Expected @('index','parentIndex','classBucket','controlId','visible','enabled','buttonStyleBucket','labelMatches') -Kind 'HWND child diagnostic'
      Assert-PrintExactProperties -Value $receipt.childDiagnostics[0].labelMatches -Expected @('print','cancel','currentPage','printerName') -Kind 'HWND child exact label flags'
      if($receipt.inventoryStatus-cne'native-window-observed'-or$receipt.topLevelOwnedCount-ne2-or$receipt.topLevelOwnedVisibleCount-ne2-or$receipt.topLevelOwnedEnabledCount-ne2-or$receipt.candidateSurfaceCount-ne1-or$receipt.visibleDialogCandidateCount-ne1-or$receipt.visibleEnabledDialogCandidateCount-ne1-or
        $receipt.candidateTopLevels.Count-ne1-or$receipt.candidateTopLevels[0].classBucket-cne'dialog32770'-or$receipt.candidateTopLevels[0].uiaControlTypeBucket-cne'pane'-or-not$receipt.candidateTopLevels[0].uiaNameMatches.print-or-not$receipt.childCountCapped-or$receipt.childCount-gt2048-or
        -not$receipt.childDiagnosticsCapped-or$receipt.childDiagnostics.Count-ne64-or$receipt.childDiagnostics[0].index-ne0-or$receipt.childDiagnostics[0].parentIndex-ne-1-or$receipt.childDiagnostics[0].classBucket-cne'button'-or$receipt.childDiagnostics[0].controlId-ne2-or$receipt.childDiagnostics[0].buttonStyleBucket-cne'pushButton'-or-not$receipt.childDiagnostics[0].labelMatches.cancel-or
        $receipt.childDiagnostics[3].controlId-ne1-or$receipt.childDiagnostics[3].buttonStyleBucket-cne'defaultPushButton'-or-not$receipt.childDiagnostics[3].labelMatches.print-or
        $receipt.childDiagnostics[4].buttonStyleBucket-cne'autoRadioButton'-or-not$receipt.childDiagnostics[4].labelMatches.currentPage-or$receipt.childDiagnostics[5].parentIndex-ne0-or-not$receipt.childDiagnostics[5].labelMatches.printerName-or$receipt.childDiagnostics[8].controlId-ne-1-or
        $receipt.classHistogram.dialog32770-ne1-or$receipt.classHistogram.button-ne3-or$receipt.classHistogram.comboBox-ne1-or$receipt.classHistogram.sysListView32-ne1-or$receipt.classHistogram.static-ne1-or
        $receipt.controlIdHistogram.idOk-ne1-or$receipt.controlIdHistogram.idCancel-ne1-or$receipt.controlIdHistogram.radioButtonRange-ne1-or$receipt.controlIdHistogram.comboRange-ne1-or$receipt.controlIdHistogram.listRange-ne1-or$receipt.controlIdHistogram.scrollRange-ne1-or$receipt.controlIdHistogram.otherPositive-ne2041-or
        -not$receipt.requiredRoleMatchesAvailable-or$receipt.requiredRoleMatches.cancelButton-ne1-or$receipt.requiredRoleMatches.printerCombo-ne1-or$receipt.requiredRoleMatches.printerList-ne1){throw "HWND topology diagnostic counts changed: $json"}
      $unavailable=(Get-SanitizedNativeWindowTopologyJson -Unavailable)|ConvertFrom-Json
      Assert-PrintExactProperties -Value $unavailable -Expected @('inventoryStatus','topLevelOwnedCount','topLevelOwnedVisibleCount','topLevelOwnedEnabledCount','topLevelCountCapped','candidateSurfaceCount','candidateSurfaceCountCapped','visibleDialogCandidateCount','visibleEnabledDialogCandidateCount','candidateTopLevels','childCount','childCountCapped','childDiagnosticsCapped','childDiagnostics','classHistogram','controlIdHistogram','requiredRoleMatchesAvailable','requiredRoleMatches') -Kind 'Unavailable HWND topology receipt'
      if($unavailable.inventoryStatus-cne'unavailable'-or$unavailable.childCount-ne-1-or$unavailable.requiredRoleMatchesAvailable){throw 'Unavailable HWND topology diagnostic changed.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('binds the evidenced native print roles and revalidates them before exact actions', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      Initialize-PrintNativeWindowInterop
      if(-not[Smacrobat.PrintVerification.NativeWindows]::AccessKeyLabelEquals('&Print','Print')-or
        -not[Smacrobat.PrintVerification.NativeWindows]::AccessKeyLabelEquals('Current &page','Current page')-or
        -not[Smacrobat.PrintVerification.NativeWindows]::AccessKeyLabelEquals('Microsoft Print to &PDF','Microsoft Print to PDF')-or
        [Smacrobat.PrintVerification.NativeWindows]::AccessKeyLabelEquals('&&Print','Print')-or
        [Smacrobat.PrintVerification.NativeWindows]::AccessKeyLabelEquals('Print&','Print')-or
        [Smacrobat.PrintVerification.NativeWindows]::AccessKeyLabelEquals('Print ','Print')-or
        [Smacrobat.PrintVerification.NativeWindows]::AccessKeyLabelEquals('X&Print','Print')){throw 'Access-key normalization was broader than fixed exact label equality.'}
      function New-RoleElement([int]$runtimePart,[long]$handle,[string]$type='ControlType.Pane',[string]$name=''){
        $element=[pscustomobject]@{RuntimePart=$runtimePart;Current=[pscustomobject]@{ProcessId=7319;NativeWindowHandle=[int]$handle;ControlType=[pscustomobject]@{ProgrammaticName=$type};Name=$name;AutomationId=''}}
        $element|Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value {[int[]]@(129,$this.RuntimePart)}
        return $element
      }
      function New-RoleRecord([long]$handle,[long]$parent,[string]$className,[int]$controlId,[int]$style,[bool]$visible,[bool]$enabled,$element,[bool]$print=$false,[bool]$cancel=$false,[bool]$currentPage=$false,[bool]$printerName=$false){
        [pscustomobject]@{HandleValue=$handle;ParentHandleValue=$parent;ClassName=$className;ControlId=$controlId;ButtonStyle=$style;IsVisible=$visible;IsEnabled=$enabled;IsLabelPrint=$print;IsLabelCancel=$cancel;IsLabelCurrentPage=$currentPage;IsLabelPrinterName=$printerName;Element=$element}
      }
      $root=New-RoleElement 1 202
      $printerDialog=New-RoleElement 2 300
      $printerContainer=New-RoleElement 3 301
      $printerList=New-RoleElement 4 302
      $pageDialog=New-RoleElement 5 317
      $radio1056=New-RoleElement 6 319;$radio1057=New-RoleElement 7 320;$currentPage=New-RoleElement 8 321;$radio1059=New-RoleElement 9 322
      $print=New-RoleElement 10 333;$cancel=New-RoleElement 11 334
      $outsidePrint=New-RoleElement 12 335;$outsideList=New-RoleElement 13 336
      $records=@(
        (New-RoleRecord 202 0 '#32770' 0 -1 $true $true $root),
        (New-RoleRecord 300 202 '#32770' 0 -1 $true $true $printerDialog),
        (New-RoleRecord 301 300 'PrintHostContainer' 0 -1 $true $true $printerContainer),
        (New-RoleRecord 302 301 'SysListView32' 1 -1 $true $true $printerList),
        (New-RoleRecord 317 300 '#32770' 0 -1 $true $true $pageDialog),
        (New-RoleRecord 319 317 'Button' 1056 4 $true $true $radio1056),
        (New-RoleRecord 320 317 'Button' 1057 4 $true $false $radio1057),
        (New-RoleRecord 321 317 'Button' 1058 4 $true $true $currentPage $false $false $true),
        (New-RoleRecord 322 317 'Button' 1059 4 $true $true $radio1059),
        (New-RoleRecord 333 202 'Button' 1 1 $true $true $print $true),
        (New-RoleRecord 334 202 'Button' 2 0 $true $true $cancel $false $true),
        (New-RoleRecord 335 317 'Button' 1 1 $true $true $outsidePrint $true),
        (New-RoleRecord 336 202 'SysListView32' 1 -1 $true $true $outsideList)
      )
      $provider={param($requestedProcessId,[long]$rootHandle,[bool]$topLevelOnly)if($rootHandle-ne202){throw 'Native role query escaped the bound root.'};$records}
      $observed=@();$snapshot=@(Get-ProcessNativeWindowSnapshot -ProcessId 7319 -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -WindowProvider $provider -ObservedRecords ([ref]$observed))
      $roles=Get-ExactNativePrintDialogRoles -SurfaceRecords $observed -Snapshot $snapshot -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2))
      if($null-eq$roles-or(Get-NativeSurfaceHandleValue $roles.cancel)-ne334-or(Get-NativeSurfaceHandleValue $roles.print)-ne333-or(Get-NativeSurfaceHandleValue $roles.currentPage)-ne321-or(Get-NativeSurfaceHandleValue $roles.printerList)-ne302){throw 'Evidenced native print roles were not bound exactly.'}
      $rootEntries=@($snapshot|Where-Object{(Get-NativeSurfaceHandleValue -Identity ([string]$_.runtimeIdentity))-eq202});if($rootEntries.Count-ne1){throw 'Native role root fixture changed.'}
      $binding=[pscustomobject][ordered]@{surfaceRootIdentity=[string]$rootEntries[0].runtimeIdentity;surfaceElement=$root;baselineIdentities=@('baseline:1');trackedIdentities=[string[]]@($snapshot|ForEach-Object{[string]$_.runtimeIdentity});anchorElement=$cancel;nativeRoles=$roles}
      $printerItem=New-RoleElement 30 0 'ControlType.ListItem' 'Microsoft Print to PDF'
      $script:printerRoots=0
      $targetProvider={param($requestedProcessId,$rootElement)$script:printerRoots++;if(-not[object]::ReferenceEquals($rootElement,$printerList)){throw 'Printer lookup escaped the exact evidenced SysListView32 HWND.'};@($printerItem)}
      $found=Find-BoundNativePrinterElement -ProcessId 7319 -Binding $binding -Deadline ([datetime]::UtcNow.AddSeconds(2)) -NativeWindowProvider $provider -TargetProvider $targetProvider
      if(-not[object]::ReferenceEquals($found,$printerItem)-or$script:printerRoots-ne1){throw 'Exact native printer-list binding changed.'}
      $script:clicks=@()
      $clickProvider={param($requestedProcessId,$handleValue,$requireChecked,$remainingMilliseconds)$script:clicks+=([pscustomobject]@{Handle=[long]$handleValue;Checked=[bool]$requireChecked});$true}
      foreach($role in @('cancel','currentPage','print')){$null=Invoke-BoundNativeButtonRole -ProcessId 7319 -Binding $binding -Role $role -Deadline ([datetime]::UtcNow.AddSeconds(2)) -NativeWindowProvider $provider -ClickProvider $clickProvider}
      if($script:clicks.Count-ne3-or$script:clicks[0].Handle-ne334-or$script:clicks[0].Checked-or$script:clicks[1].Handle-ne321-or-not$script:clicks[1].Checked-or$script:clicks[2].Handle-ne333-or$script:clicks[2].Checked){throw 'Native role actions did not use the exact bound HWNDs and radio verification flag.'}
      $records[9].IsLabelPrint=$false;$clickCount=$script:clicks.Count;$rejected=$false
      try{Invoke-BoundNativeButtonRole -ProcessId 7319 -Binding $binding -Role print -Deadline ([datetime]::UtcNow.AddSeconds(1)) -NativeWindowProvider $provider -ClickProvider $clickProvider|Out-Null}catch{$rejected=$true}
      if(-not$rejected-or$script:clicks.Count-ne$clickCount){throw 'A changed native role reached its action.'}
      $records[9].IsLabelPrint=$true
      $duplicatePrint=New-RoleRecord 337 202 'Button' 1 1 $true $true (New-RoleElement 14 337) $true
      $duplicateRecords=@($records)+@($duplicatePrint);$duplicateProvider={param($requestedProcessId,[long]$rootHandle,[bool]$topLevelOnly)$duplicateRecords}
      $duplicateObserved=@();$duplicateSnapshot=@(Get-ProcessNativeWindowSnapshot -ProcessId 7319 -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -WindowProvider $duplicateProvider -ObservedRecords ([ref]$duplicateObserved))
      $rejected=$false;try{Get-ExactNativePrintDialogRoles -SurfaceRecords $duplicateObserved -Snapshot $duplicateSnapshot -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2))|Out-Null}catch{$rejected=$true}
      if(-not$rejected){throw 'Ambiguous exact native print buttons were accepted.'}
      $records[4].ParentHandleValue=0
      $wrongObserved=@();$wrongSnapshot=@(Get-ProcessNativeWindowSnapshot -ProcessId 7319 -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -WindowProvider $provider -ObservedRecords ([ref]$wrongObserved))
      if($null-ne(Get-ExactNativePrintDialogRoles -SurfaceRecords $wrongObserved -Snapshot $wrongSnapshot -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2)))){throw 'A radio group outside the bound root ancestry was accepted.'}
      $records[4].ParentHandleValue=318
      $cycleDialog=New-RoleRecord 318 317 '#32770' 0 -1 $true $true (New-RoleElement 15 318)
      $cycleRecords=@($records)+@($cycleDialog);$cycleProvider={param($requestedProcessId,[long]$rootHandle,[bool]$topLevelOnly)$cycleRecords}
      $cycleObserved=@();$cycleSnapshot=@(Get-ProcessNativeWindowSnapshot -ProcessId 7319 -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -WindowProvider $cycleProvider -ObservedRecords ([ref]$cycleObserved))
      $rejected=$false;try{Get-ExactNativePrintDialogRoles -SurfaceRecords $cycleObserved -Snapshot $cycleSnapshot -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2))|Out-Null}catch{$rejected=$true}
      if(-not$rejected){throw 'Cyclic native print role ancestry was accepted.'}
      $records[4].ParentHandleValue=300
      $secondDialog=New-RoleElement 16 418
      $ambiguousRecords=@($records)+@(
        (New-RoleRecord 418 300 '#32770' 0 -1 $true $true $secondDialog),
        (New-RoleRecord 419 418 'Button' 1056 4 $true $true (New-RoleElement 17 419)),
        (New-RoleRecord 420 418 'Button' 1057 4 $true $false (New-RoleElement 18 420)),
        (New-RoleRecord 421 418 'Button' 1058 4 $true $true (New-RoleElement 19 421) $false $false $true),
        (New-RoleRecord 422 418 'Button' 1059 4 $true $true (New-RoleElement 20 422))
      )
      $ambiguousProvider={param($requestedProcessId,[long]$rootHandle,[bool]$topLevelOnly)$ambiguousRecords}
      $ambiguousObserved=@();$ambiguousSnapshot=@(Get-ProcessNativeWindowSnapshot -ProcessId 7319 -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -WindowProvider $ambiguousProvider -ObservedRecords ([ref]$ambiguousObserved))
      $rejected=$false;try{Get-ExactNativePrintDialogRoles -SurfaceRecords $ambiguousObserved -Snapshot $ambiguousSnapshot -RootHandleValue 202 -Deadline ([datetime]::UtcNow.AddSeconds(2))|Out-Null}catch{$rejected=$true}
      if(-not$rejected){throw 'Ambiguous complete descendant radio groups were accepted.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('routes a null UIA printer result through the exact native list and propagates lookup errors', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      $surface=[pscustomobject]@{surfaceRootIdentity='hwnd:202|runtime:1'}
      $script:expectedPrinter=[pscustomobject]@{Marker=[object]::new();Current=[pscustomobject]@{ProcessId=7319}}
      $script:mode='missing';$script:nativeLookups=0
      $uiFinder={param($requestedProcessId,$bindingValue,$name,$deadline)
        if($name-cne'Microsoft Print to PDF'){throw 'UIA printer lookup changed its exact name.'}
        if($script:mode-ceq'ambiguous'){throw 'Native process UI bound target was ambiguous.'}
        if($script:mode-ceq'provider-error'){throw 'Native process UI provider failed.'}
        return $null
      }
      $nativeFinder={param($requestedProcessId,$bindingValue,$deadline)$script:nativeLookups=$script:nativeLookups+1;return $script:expectedPrinter}
      $found=Find-BoundPdfPrinterElement -ProcessId 7319 -Binding $surface -Deadline ([datetime]::UtcNow.AddSeconds(2)) -UiFinder $uiFinder -NativeFinder $nativeFinder
      if(@($found).Count-ne1-or-not[object]::ReferenceEquals($found.Marker,$script:expectedPrinter.Marker)-or$script:nativeLookups-ne1){throw 'A null UIA result did not return the exact rooted native printer item.'}
      foreach($failureMode in @('ambiguous','provider-error')){
        $script:mode=$failureMode;$beforeNative=$script:nativeLookups;$rejected=$false
        try{Find-BoundPdfPrinterElement -ProcessId 7319 -Binding $surface -Deadline ([datetime]::UtcNow.AddSeconds(2)) -UiFinder $uiFinder -NativeFinder $nativeFinder|Out-Null}catch{$rejected=$true}
        if(-not$rejected-or$script:nativeLookups-ne$beforeNative){throw 'A UIA ambiguity or provider error was swallowed by native printer fallback.'}
      }
      $script:mode='missing'
      $ambiguousNativeFinder={param($requestedProcessId,$bindingValue,$deadline)throw 'Exact native printer list was ambiguous.'}
      $rejected=$false;try{Find-BoundPdfPrinterElement -ProcessId 7319 -Binding $surface -Deadline ([datetime]::UtcNow.AddSeconds(2)) -UiFinder $uiFinder -NativeFinder $ambiguousNativeFinder|Out-Null}catch{$rejected=$true}
      if(-not$rejected){throw 'An exact native-list ambiguity reached printer selection.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('emits only bounded privacy-safe facts below the exact native printer list', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      Initialize-PrintUiAutomation
      function New-DiagnosticElement([int]$owner,[string]$type,[string]$name,[bool]$selection,[bool]$invoke){
        $element=[pscustomobject]@{Selection=$selection;Invoke=$invoke;PatternCall=0;Current=[pscustomobject]@{ProcessId=$owner;ControlType=[pscustomobject]@{ProgrammaticName=$type};Name=$name}}
        $element|Add-Member -MemberType ScriptMethod -Name TryGetCurrentPattern -Value {
          param($pattern,[ref]$value)$this.PatternCall++
          $available=if(($this.PatternCall%2)-eq1){[bool]$this.Selection}else{[bool]$this.Invoke}
          if($available){$value.Value=[pscustomobject]@{}};return $available
        }
        return $element
      }
      $printerList=New-DiagnosticElement 7319 'ControlType.List' 'Private list' $false $false
      $descendants=@()
      foreach($index in 0..64){
        $owner=if($index-eq0){9999}else{7319};$type=if($index-eq0){'ControlType.Pane'}else{'ControlType.ListItem'};$name=if($index-eq0){'Microsoft Print to PDF'}else{"Private printer $index"}
        $descendants+=New-DiagnosticElement $owner $type $name ($index%2-eq0) ($index%3-eq0)
      }
      function Get-BoundNativeRoleElement { param($ProcessId,$Binding,$Role,$Deadline,$NativeWindowProvider)if($Role-cne'printerList'){throw 'Diagnostic escaped the bound printer list role.'};return $printerList }
      $provider={param($root,$maximum,$deadline)if(-not[object]::ReferenceEquals($root,$printerList)-or$maximum-ne64){throw 'Diagnostic traversal escaped its exact bounded root.'};$descendants}
      $json=Get-BoundNativePrinterListDiagnosticJson -ProcessId 7319 -Binding ([pscustomobject]@{}) -Deadline ([datetime]::UtcNow.AddSeconds(2)) -TraversalProvider $provider
      $receipt=$json|ConvertFrom-Json
      Assert-PrintExactProperties -Value $receipt -Expected @('inventoryStatus','descendantCount','countCapped','facts') -Kind 'Native printer-list diagnostic receipt'
      if($receipt.inventoryStatus-cne'available'-or$receipt.descendantCount-ne64-or-not$receipt.countCapped-or@($receipt.facts).Count-ne64){throw 'Native printer-list diagnostic bounds changed.'}
      foreach($fact in @($receipt.facts)){Assert-PrintExactProperties -Value $fact -Expected @('controlTypeBucket','processIdMatches','exactPrinterName','selectionPatternAvailable','invokePatternAvailable') -Kind 'Native printer-list diagnostic fact'}
      if($receipt.facts[0].controlTypeBucket-cne'pane'-or$receipt.facts[0].processIdMatches-or-not$receipt.facts[0].exactPrinterName-or-not$receipt.facts[0].selectionPatternAvailable-or-not$receipt.facts[0].invokePatternAvailable){throw 'Native printer-list diagnostic facts changed.'}
      if($json-cmatch'7319|9999|Microsoft Print to PDF|Private printer|Private list|handle|automationId|coordinates|bounds'){throw 'Native printer-list diagnostic leaked a sensitive value or field.'}
      $slowProvider={param($root,$maximum,$deadline)Start-Sleep -Milliseconds 40;@($descendants[0])}
      $unavailable=Get-BoundNativePrinterListDiagnosticJson -ProcessId 7319 -Binding ([pscustomobject]@{}) -Deadline ([datetime]::UtcNow.AddMilliseconds(20)) -TraversalProvider $slowProvider
      if($unavailable-cne'{"inventoryStatus":"unavailable","descendantCount":-1,"countCapped":false,"facts":[]}'){throw 'Expired printer-list diagnostics did not fail closed.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('selects one visible dialog-class HWND from the hosted 11-owned 5-candidate topology', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'
      . ./scripts/installed-print-dialog.ps1
      function New-HostedTopElement([int]$runtimePart,[long]$handle,[string]$type,[string]$name){
        $element=[pscustomobject]@{RuntimePart=$runtimePart;Current=[pscustomobject]@{ProcessId=7319;NativeWindowHandle=[int]$handle;ControlType=[pscustomobject]@{ProgrammaticName=$type};Name=$name;AutomationId=''}}
        $element|Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value {[int[]]@(119,$this.RuntimePart)}
        return $element
      }
      function New-HostedTopRecord([long]$handle,$element,[string]$className,[bool]$visible,[bool]$enabled){
        return [pscustomobject]@{HandleValue=$handle;ParentHandleValue=0L;ClassName=$className;ControlId=0;IsVisible=$visible;IsEnabled=$enabled;Element=$element}
      }
      $baselineRecords=@()
      foreach($index in 0..5){$baselineRecords+=New-HostedTopRecord (100+$index) (New-HostedTopElement (10+$index) (100+$index) 'ControlType.Pane' 'Private baseline title') 'Chrome_WidgetWin_1' ($index-eq0) $true}
      $candidateRecords=@(
        (New-HostedTopRecord 200 (New-HostedTopElement 20 200 'ControlType.Pane' 'Private hidden surface') 'Chrome_WidgetWin_1' $false $true),
        (New-HostedTopRecord 201 (New-HostedTopElement 21 201 'ControlType.Pane' 'Private hidden dialog') '#32770' $false $true),
        (New-HostedTopRecord 202 (New-HostedTopElement 22 202 'ControlType.Pane' 'Print') '#32770' $true $true),
        (New-HostedTopRecord 203 (New-HostedTopElement 23 203 'ControlType.Pane' 'Private visible surface') 'Chrome_WidgetWin_1' $true $true),
        (New-HostedTopRecord 204 (New-HostedTopElement 24 204 'ControlType.Pane' 'Private disabled surface') 'ApplicationFrameWindow' $false $false)
      )
      $cancel=New-HostedTopElement 30 301 'ControlType.Button' 'Cancel'
      $print=New-HostedTopElement 31 302 'ControlType.Button' 'Print'
      $currentPage=New-HostedTopElement 32 303 'ControlType.RadioButton' 'Current Page'
      $printerCombo=New-HostedTopElement 33 304 'ControlType.ComboBox' ''
      $script:hostedNativeState='baseline';$script:hostedRootQueries=0
      $provider={param($requestedProcessId,[long]$rootHandle,[bool]$topLevelOnly)
        if($rootHandle-ne0){
          $script:hostedRootQueries++
          if($rootHandle-ne202){throw 'Hosted topology selected a generic or invisible top-level HWND.'}
          return @(
            [pscustomobject]@{HandleValue=202L;ParentHandleValue=0L;ClassName='#32770';ControlId=0;IsVisible=$true;IsEnabled=$true;Element=$candidateRecords[2].Element},
            [pscustomobject]@{HandleValue=301L;ParentHandleValue=202L;ClassName='Button';ControlId=2;IsVisible=$true;IsEnabled=$true;Element=$cancel},
            [pscustomobject]@{HandleValue=302L;ParentHandleValue=202L;ClassName='Button';ControlId=1;IsVisible=$true;IsEnabled=$true;Element=$print},
            [pscustomobject]@{HandleValue=303L;ParentHandleValue=202L;ClassName='Button';ControlId=0x0420;IsVisible=$true;IsEnabled=$true;Element=$currentPage},
            [pscustomobject]@{HandleValue=304L;ParentHandleValue=202L;ClassName='ComboBox';ControlId=0x0470;IsVisible=$true;IsEnabled=$true;Element=$printerCombo}
          )
        }
        if($script:hostedNativeState-ceq'baseline'){return $baselineRecords}
        return @($baselineRecords)+@($candidateRecords)
      }
      $baseline=@(Get-ProcessNativeWindowSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -TopLevelOnly -WindowProvider $provider)
      $baselineHandles=[Collections.Generic.HashSet[long]]::new();foreach($record in $baselineRecords){$null=$baselineHandles.Add([long]$record.HandleValue)}
      $script:hostedNativeState='post';$observed=@()
      $post=@(Get-ProcessNativeWindowSnapshot -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddSeconds(2)) -TopLevelOnly -WindowProvider $provider -ObservedRecords ([ref]$observed))
      $facts=@(Get-NativeTopLevelCandidateDiagnosticRecords -TopLevelRecords $observed -TopLevelSnapshot $post -BaselineHandleValues $baselineHandles -Deadline ([datetime]::UtcNow.AddSeconds(2)))
      $json=Get-SanitizedNativeWindowTopologyJson -TopLevelRecords $observed -CandidateTopLevelRecords $facts -SurfaceRecords @()
      if($json-cmatch'Private|HandleValue|202|203'){throw 'Hosted top-level diagnostic leaked a caption or native identity.'}
      $receipt=$json|ConvertFrom-Json
      if($receipt.topLevelOwnedCount-ne11-or$receipt.topLevelOwnedVisibleCount-ne3-or$receipt.candidateSurfaceCount-ne5-or$receipt.childCount-ne0-or
        $receipt.visibleDialogCandidateCount-ne1-or$receipt.visibleEnabledDialogCandidateCount-ne1-or$receipt.candidateTopLevels.Count-ne5-or
        $receipt.candidateTopLevels[1].classBucket-cne'dialog32770'-or$receipt.candidateTopLevels[1].visible-or
        $receipt.candidateTopLevels[2].classBucket-cne'dialog32770'-or-not$receipt.candidateTopLevels[2].visible-or-not$receipt.candidateTopLevels[2].enabled-or
        $receipt.candidateTopLevels[2].uiaControlTypeBucket-cne'pane'-or-not$receipt.candidateTopLevels[2].uiaNameMatches.print){throw "Hosted native topology receipt changed: $json"}
      $binding=Wait-NewProcessNativeWindowSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddSeconds(3)) -WindowProvider $provider
      if([string]$binding.surfaceRootIdentity-cnotmatch'^hwnd:202\|'-or$script:hostedRootQueries-ne1){throw 'Hosted native topology did not bind only the unique visible enabled dialog HWND.'}
      $candidateRecords[1].IsVisible=$true;$candidateRecords[1].IsEnabled=$false;$queriesBefore=$script:hostedRootQueries;$rejected=$false
      try{Wait-NewProcessNativeWindowSurface -ProcessId 7319 -Baseline $baseline -AnchorNames @('Cancel') -AnchorControlTypes @('ControlType.Button') -Stage 'first-print-dialog' -Deadline ([datetime]::UtcNow.AddMilliseconds(250)) -WindowProvider $provider|Out-Null}catch{$rejected=$true}
      if(-not$rejected-or$script:hostedRootQueries-ne$queriesBefore){throw 'Multiple visible dialog-class HWNDs reached a rooted UIA query.'}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('maps every native wait callsite to its exact diagnostic stage', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\\scripts\\installed-print-dialog.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Installed print script did not parse.'}
      $calls=@($ast.FindAll({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-in@('Wait-ProcessUiElement','Wait-ProcessUiWindowClosed','Wait-NewProcessUiSurface','Wait-NewProcessNativeWindowSurface','Wait-BoundProcessUiElement','Wait-BoundProcessUiSurfaceClosed','Wait-ProcessTopLevelUiBaselineRestored')},$true))
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
        'Wait-NewProcessUiSurface:$Stage','Wait-NewProcessUiSurface:save-output-dialog','Wait-NewProcessUiSurface:second-print-dialog',
        'Wait-NewProcessNativeWindowSurface:$Stage','Wait-NewProcessNativeWindowSurface:save-output-dialog','Wait-NewProcessNativeWindowSurface:second-print-dialog',
        'Wait-BoundProcessUiSurfaceClosed:$Stage','Wait-BoundProcessUiSurfaceClosed:save-output-dialog','Wait-BoundProcessUiSurfaceClosed:second-print-dialog',
        'Wait-BoundProcessUiElement:current-page-control',
        'Wait-ProcessTopLevelUiBaselineRestored:final-native-cleanup','Wait-ProcessTopLevelUiBaselineRestored:first-native-cleanup'
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
      $total=[datetime]::UtcNow.AddSeconds(1);$phase=Get-PrintPhaseDeadline -TotalDeadline $total -MaximumMilliseconds $script:PrintPins.NativeDialogTimeoutMilliseconds
      if($phase.Ticks-ne$total.Ticks){throw 'Native phase deadline was not capped by the shared total deadline.'}
      foreach($bad in @(0,-1)){$rejected=$false;try{Get-PrintPhaseDeadline -TotalDeadline $total -MaximumMilliseconds $bad}catch{$rejected=$true};if(-not$rejected){throw 'Invalid phase duration accepted.'}}
      $rejected=$false;try{Get-PrintPhaseDeadline -TotalDeadline ([datetime]::UtcNow.AddMilliseconds(-1)) -MaximumMilliseconds 1}catch{$rejected=$true};if(-not$rejected){throw 'Expired total deadline accepted.'}
      $script:expiredActionPatternReads=0
      $expiredActionElement=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=7319}}
      $expiredActionElement|Add-Member -MemberType ScriptMethod -Name TryGetCurrentPattern -Value {$script:expiredActionPatternReads++;return $true}
      foreach($operation in @(
        {Invoke-ProcessUiElement -Element $expiredActionElement -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddMilliseconds(-1))},
        {Select-ProcessUiElement -Element $expiredActionElement -ProcessId 7319 -Deadline ([datetime]::UtcNow.AddMilliseconds(-1))},
        {Set-ProcessUiElementValue -Element $expiredActionElement -ProcessId 7319 -Value 'fixture' -Deadline ([datetime]::UtcNow.AddMilliseconds(-1))}
      )){$rejected=$false;try{&$operation}catch{$rejected=$true};if(-not$rejected){throw 'Expired native action was accepted.'}}
      if($script:expiredActionPatternReads-ne0){throw 'Expired native action queried or invoked a UI Automation pattern.'}
      $script:topologyCalls=0
      function Assert-TrustedConsoleHostTopology {param([object[]]$Owned,[int]$RootProcessId,[string]$SystemDirectory,[scriptblock]$SignatureProvider,[scriptblock]$VersionInfoProvider)
        $script:topologyCalls++;$trusted=@($Owned|Where-Object{[IO.Path]::GetFileName([string]$_.Path)-ieq'conhost.exe'});$webviewIds=@($Owned|Where-Object{[IO.Path]::GetFileName([string]$_.Path)-ieq'msedgewebview2.exe'}|ForEach-Object{[int]$_.ProcessId})
        if($RootProcessId-ne41-or$trusted.Count-lt2-or@($trusted|Where-Object{[int]$_.ParentProcessId-eq$RootProcessId}).Count-lt1-or@($trusted|Where-Object{$webviewIds-contains[int]$_.ParentProcessId}).Count-lt1){throw 'invalid topology'};return $trusted.Count
      }
      $app='C:\fixture\pdf-workstation.exe';$edge='C:\fixture\msedgedriver.exe';$owned=@(
        [pscustomobject]@{Path=$app;ProcessId=42},[pscustomobject]@{Path=$edge;ProcessId=43},[pscustomobject]@{Path='C:\fixture\msedgewebview2.exe';ProcessId=44},
        [pscustomobject]@{Path='C:\Windows\System32\conhost.exe';ProcessId=45;ParentProcessId=41},
        [pscustomobject]@{Path='C:\Windows\System32\conhost.exe';ProcessId=46;ParentProcessId=44},
        [pscustomobject]@{Path='C:\Windows\System32\conhost.exe';ProcessId=47;ParentProcessId=44}
      )
      Assert-PrintOwnedExecutables -Owned $owned -ApplicationPath $app -EdgeDriverPath $edge -RootProcessId 41
      if($script:topologyCalls-ne1){throw 'Print executable validation bypassed the full trusted console-host topology helper.'}
      $rejected=$false;try{Assert-PrintOwnedExecutables -Owned @($owned+[pscustomobject]@{Path='C:\fixture\rogue.exe'}) -ApplicationPath $app -EdgeDriverPath $edge -RootProcessId 41}catch{$rejected=$true};if(-not$rejected){throw 'Unexpected descendant accepted.'}
      function Assert-TrustedConsoleHostTopology {return 2}
      $rejected=$false;try{Assert-PrintOwnedExecutables -Owned $owned -ApplicationPath $app -EdgeDriverPath $edge -RootProcessId 41}catch{$rejected=$true};if(-not$rejected){throw 'Console-host inventory was not compared with the trusted lifetime-union count.'}
      function Assert-TrustedConsoleHostTopology {throw 'full topology rejected'}
      $rejected=$false;try{Assert-PrintOwnedExecutables -Owned $owned -ApplicationPath $app -EdgeDriverPath $edge -RootProcessId 41}catch{$rejected=$true};if(-not$rejected){throw 'Console hosts were accepted by leaf name after full topology rejection.'}
      Assert-ProcessUiElement -Element ([pscustomobject]@{Current=[pscustomobject]@{ProcessId=42}}) -ProcessId 42
      $rejected=$false;try{Assert-ProcessUiElement -Element ([pscustomobject]@{Current=[pscustomobject]@{ProcessId=43}}) -ProcessId 42}catch{$rejected=$true};if(-not$rejected){throw 'Foreign UI Automation element accepted.'}
      $clean=[pscustomobject]@{sessionDeleted=$true;ownedProcessTreeStopped=$true;relevantProcessesRemaining=0};Assert-PrintCleanupResult $clean
      foreach($mutation in @('session','tree','residual')){$bad=$clean|Select-Object *;if($mutation-ceq'session'){$bad.sessionDeleted=$false}elseif($mutation-ceq'tree'){$bad.ownedProcessTreeStopped=$false}else{$bad.relevantProcessesRemaining=1};$rejected=$false;try{Assert-PrintCleanupResult $bad}catch{$rejected=$true};if(-not$rejected){throw ('Unsafe cleanup accepted: '+$mutation)}}
      Initialize-PdfiumPrintProof;$source=[pscustomobject]@{Fingerprint=[byte[]](1,40,100,220)};$good=[pscustomobject]@{Pages=1;Fingerprint=[byte[]](1,40,100,220)};Compare-PdfiumPrintProof $source $good|Out-Null
      foreach($bad in @([pscustomobject]@{Pages=2;Fingerprint=[byte[]](1,40,100,220)},[pscustomobject]@{Pages=1;Fingerprint=[byte[]](220,100,40,1)})){$rejected=$false;try{Compare-PdfiumPrintProof $source $bad}catch{$rejected=$true};if(-not$rejected){throw 'Unsafe PDF proof accepted.'}}
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const source = readFileSync('scripts/installed-print-dialog.ps1', 'utf8');
    const topologyCall = source.indexOf('$trustedConsoleHostCount = Assert-TrustedConsoleHostTopology');
    const firstUiSnapshot = source.indexOf('$originalNativeBaseline = @(Get-ProcessTopLevelUiSnapshot');
    expect(topologyCall).toBeGreaterThan(0);
    expect(firstUiSnapshot).toBeGreaterThan(topologyCall);
    expect(source.match(/Assert-TrustedConsoleHostTopology -Owned/g)).toHaveLength(2);
    expect(source).not.toMatch(/Assert-TrustedConsoleHostTopology[^\r\n]*-AllowAbsent/);
    expect(source.match(/\[int\]\$trustedConsoleHost(?:s|Count) -lt 2/g)).toHaveLength(2);
    expect(source).not.toMatch(/\[int\]\$trustedConsoleHost(?:s|Count) -ne 2/);
    expect(source).toContain('$processCleanupDeadline = [datetime]::UtcNow.AddMilliseconds($script:LaunchPins.CleanupProcessTimeoutMilliseconds)');
    expect(source).toContain('Wait-LaunchProcessQuiescence -Deadline $processCleanupDeadline');
    expect(source).toContain('$clear = $processesQuiescent -and $residualCategory');
  });
});
