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
      $message='';try{Wait-ProcessTopLevelUiBaselineRestored -ProcessId 7319 -Baseline $baseline -Stage 'first-native-cleanup' -Deadline ([datetime]::UtcNow.AddMilliseconds(50)) -ElementProvider {param($requestedProcessId,$windowsOnly)@($main,$replacement)}}catch{$message=$_.Exception.Message}
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
    expect(source).toContain('$firstNativeControlBaseline = @(Get-ProcessUiTreeSnapshot');
    expect(source).toContain('$secondNativeControlBaseline = @(Get-ProcessUiTreeSnapshot');
  });

  it('maps every native wait callsite to its exact diagnostic stage', () => {
    const result = runPowerShell7(String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\\scripts\\installed-print-dialog.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Installed print script did not parse.'}
      $calls=@($ast.FindAll({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-in@('Wait-ProcessUiElement','Wait-ProcessUiWindowClosed','Wait-NewProcessUiSurface','Wait-BoundProcessUiElement','Wait-BoundProcessUiSurfaceClosed','Wait-ProcessTopLevelUiBaselineRestored')},$true))
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
