import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

function runPowerShell(source: string) {
  const root = `target/reading-tools-test-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  const path = `${root}/run.ps1`;
  writeFileSync(path, source, 'utf8');
  return spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function extractFunctions(path: string, names: string[], body: string) {
  return String.raw`
    $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\\${path.replaceAll('/', '\\')}',[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'Script did not parse.'}
    foreach($name in @(${names.map(name => `'${name}'`).join(',')})){
      $fn=$ast.Find({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-ceq$name},$true)
      if(-not$fn){throw ('Missing function: '+$name)}
      Invoke-Expression $fn.Extent.Text
    }
    ${body}
  `;
}

describe('installed signed reading-tools verifier', () => {
  it('parses and keeps all native interaction process-bound without coordinates or global SendKeys', () => {
    const source = readFileSync('scripts/installed-reading-tools.ps1', 'utf8');
    const parsed = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\\scripts\\installed-reading-tools.ps1',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|% ToString;exit 1}`,
    ], { encoding: 'utf8', timeout: 15_000 });
    expect(parsed.status, parsed.stderr || parsed.stdout).toBe(0);
    expect(source).toContain('AutomationElement]::ProcessIdProperty, $ApplicationProcessId');
    expect(source).toContain('TreeScope]::Children,$condition');
    expect(source).toContain("$elements.Count -gt 8");
    expect(source).toContain('[Windows.Automation.OrCondition]::new($windowCondition,$paneCondition)');
    expect(source).toContain('Test-ReadingAutomationDescendantOfSurface');
    expect(source).toContain('Wait-ReadingProcessUiSurfaceClosed');
    expect(source).toContain('[Windows.Automation.AndCondition]::new($processCondition,$typeCondition)');
    expect(source).toContain("-Kind 'filename editor'");
    expect(source).toContain("-Kind 'Open button'");
    expect(source).not.toContain("ClassName -ceq '#32770'");
    expect(source).not.toContain("Current.Name -ceq 'Open' -and $_.Current.IsEnabled");
    expect(source).toContain("AutomationId -in @('1001','1148')");
    expect(source).toContain("AutomationId -ceq '1'");
    expect(source).toContain('[Windows.Automation.ValuePattern]::Pattern');
    expect(source).toContain('[Windows.Automation.InvokePattern]::Pattern');
    expect(source.indexOf('$baseline = @(Get-ReadingProcessUiSurfaceSnapshot')).toBeLessThan(source.indexOf('$clicked = Invoke-WebDriverScript'));
    expect(source).not.toMatch(/SendKeys|mouse_event|SetCursorPos|click_input|screenX|screenY|__TAURI_INTERNALS__/i);
  });

  it('binds one unnamed owned Window or Pane by runtime delta and rejects ambiguity or baseline replacement', () => {
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Assert-ReadingSurfaceSnapshot', 'Wait-NewProcessBoundOpenSurface', 'Assert-ReadingSurfaceBinding', 'Wait-ReadingProcessUiSurfaceClosed'], String.raw`
      $script:ReadingPins=[ordered]@{UiAutomationPollMilliseconds=1}
      function New-Surface([string]$identity,[string]$type,[int]$processId,[string]$name=''){
        [pscustomobject]@{runtimeIdentity=$identity;controlType=$type;isEnabled=$true;isOffscreen=$false;element=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=$processId;Name=$name}}}
      }
      $baseline=@(New-Surface '1:1' 'Window' 42 'PDF Workstation')
      $unnamed=New-Surface '1:2' 'Pane' 42 ''
      $now=[datetime]'2026-01-01T00:00:00Z';$clock={$script:now};$sleep={param($milliseconds)$script:now=$script:now.AddMilliseconds($milliseconds)}
      $bound=Wait-NewProcessBoundOpenSurface -ApplicationProcessId 42 -Baseline $baseline -Deadline $now.AddSeconds(1) -SnapshotProvider { @($baseline+$unnamed) } -SleepProvider $sleep -UtcNowProvider $clock
      if($bound.surfaceRuntimeIdentity-cne'1:2'-or$bound.surfaceControlType-cne'Pane'-or[bool]$bound.surfaceElement.Current.Name){throw 'Unnamed owned pane was not bound by runtime delta.'}
      Wait-ReadingProcessUiSurfaceClosed -Binding $bound -ApplicationProcessId 42 -Deadline $now.AddSeconds(1) -SnapshotProvider { @($baseline) } -SleepProvider $sleep -UtcNowProvider $clock
      $ambiguous=$false;try{Wait-NewProcessBoundOpenSurface -ApplicationProcessId 42 -Baseline $baseline -Deadline $now.AddSeconds(1) -SnapshotProvider { @($baseline+$unnamed+(New-Surface '1:3' 'Window' 42 '')) } -SleepProvider $sleep -UtcNowProvider $clock}catch{$ambiguous=$_.Exception.Message-ceq'More than one new process-bound native picker surface appeared.'}
      if(-not$ambiguous){throw 'Ambiguous new picker surfaces were accepted.'}
      $replaced=$false;try{Wait-NewProcessBoundOpenSurface -ApplicationProcessId 42 -Baseline $baseline -Deadline $now.AddSeconds(1) -SnapshotProvider { @($unnamed) } -SleepProvider $sleep -UtcNowProvider $clock}catch{$replaced=$_.Exception.Message-ceq'The pre-click top-level UI baseline was replaced while opening the native picker.'}
      if(-not$replaced){throw 'Baseline replacement was accepted.'}
    `);
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects matching controls outside the exact bound picker surface', () => {
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Get-ReadingAutomationRuntimeIdentity', 'Assert-ReadingSurfaceBinding', 'Test-ReadingAutomationDescendantOfSurface', 'Get-ReadingBoundAutomationChildren'], String.raw`
      function New-Element([int[]]$runtime,[int]$processId,$parent){
        $element=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=$processId};Parent=$parent;Runtime=$runtime}
        $element|Add-Member ScriptMethod GetRuntimeId { return [int[]]$this.Runtime }
        return $element
      }
      $deadline=[datetime]::UtcNow.AddSeconds(5)
      $root=New-Element @(1,2) 42 $null;$otherRoot=New-Element @(1,3) 42 $null
      $inside=New-Element @(1,2,1) 42 $root;$outside=New-Element @(1,3,1) 42 $otherRoot
      $binding=[pscustomobject]@{surfaceRuntimeIdentity='1:2';surfaceControlType='Pane';surfaceElement=$root;baselineIdentities=[string[]]@('1:1')}
      $rejected=$false;try{Get-ReadingBoundAutomationChildren -Binding $binding -ApplicationProcessId 42 -ControlType Edit -Deadline $deadline -ElementProvider { @($inside,$outside) } -ParentProvider { param($element)$element.Parent }}catch{$rejected=$_.Exception.Message-ceq'A native picker control escaped the exact bound process-owned surface.'}
      if(-not$rejected){throw 'A matching control outside the bound picker surface was accepted.'}
      $accepted=@(Get-ReadingBoundAutomationChildren -Binding $binding -ApplicationProcessId 42 -ControlType Edit -Deadline $deadline -ElementProvider { @($inside) } -ParentProvider { param($element)$element.Parent })
      if($accepted.Count-ne1-or-not[object]::ReferenceEquals($accepted[0],$inside)){throw 'The exact bound descendant control was not retained.'}
    `);
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('fails closed when a surface snapshot completes after its deadline', () => {
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Assert-ReadingSurfaceSnapshot', 'Wait-NewProcessBoundOpenSurface'], String.raw`
      $script:ReadingPins=[ordered]@{UiAutomationPollMilliseconds=1}
      function New-Surface([string]$identity,[string]$type,[int]$processId){[pscustomobject]@{runtimeIdentity=$identity;controlType=$type;isEnabled=$true;isOffscreen=$false;element=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=$processId}}}}
      $baseline=@(New-Surface '1:1' 'Window' 42);$new=New-Surface '1:2' 'Pane' 42
      $script:now=[datetime]'2026-01-01T00:00:00Z';$deadline=$script:now.AddMilliseconds(10);$clock={$script:now};$probes=0
      $rejected=$false;try{Wait-NewProcessBoundOpenSurface -ApplicationProcessId 42 -Baseline $baseline -Deadline $deadline -SnapshotProvider { $script:probes++;$script:now=$deadline;@($baseline+$new) } -SleepProvider { throw 'Sleep was reached after a delayed read.' } -UtcNowProvider $clock}catch{$rejected=$_.Exception.Message-like'No single new process-bound native picker surface appeared*'}
      if(-not$rejected-or$probes-ne1){throw 'A post-deadline picker snapshot was accepted.'}
    `);
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('does not write or invoke when UI Automation pattern acquisition reaches the deadline', () => {
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Set-ReadingAutomationValueBeforeDeadline', 'Invoke-ReadingAutomationButtonBeforeDeadline'], String.raw`
      $script:valueWrites=0;$script:buttonInvokes=0
      $valuePattern=[pscustomobject]@{Current=[pscustomobject]@{IsReadOnly=$false}}
      $valuePattern|Add-Member ScriptMethod SetValue { param($value)$script:valueWrites++ }
      $invokePattern=[pscustomobject]@{}
      $invokePattern|Add-Member ScriptMethod Invoke { $script:buttonInvokes++ }
      $script:testValuePattern=$valuePattern;$script:testInvokePattern=$invokePattern
      $element=[pscustomobject]@{}
      $script:now=[datetime]'2026-01-01T00:00:00Z';$deadline=$script:now.AddMilliseconds(10);$clock={$script:now}
      $valueRejected=$false
      try{Set-ReadingAutomationValueBeforeDeadline -Element $element -Value 'fixture.pdf' -Deadline $deadline -UtcNowProvider $clock -PatternProvider { param($candidate,$patternRef)$script:now=$deadline;$patternRef.Value=$script:testValuePattern;$true }}catch{$valueRejected=$_.Exception.Message-ceq'The process-bound filename mutation deadline expired.'}
      if(-not$valueRejected-or$valueWrites-ne0){throw 'Filename ValuePattern mutated after delayed acquisition expired the deadline.'}
      $script:now=[datetime]'2026-01-01T00:00:00Z';$deadline=$script:now.AddMilliseconds(10);$invokeRejected=$false
      try{Invoke-ReadingAutomationButtonBeforeDeadline -Element $element -Deadline $deadline -UtcNowProvider $clock -PatternProvider { param($candidate,$patternRef)$script:now=$deadline;$patternRef.Value=$script:testInvokePattern;$true }}catch{$invokeRejected=$_.Exception.Message-ceq'The process-bound native Open mutation deadline expired.'}
      if(-not$invokeRejected-or$buttonInvokes-ne0){throw 'InvokePattern mutated after delayed acquisition expired the deadline.'}
      $script:now=[datetime]'2026-01-01T00:00:00Z';$deadline=$script:now.AddSeconds(1)
      Set-ReadingAutomationValueBeforeDeadline -Element $element -Value 'fixture.pdf' -Deadline $deadline -UtcNowProvider $clock -PatternProvider { param($candidate,$patternRef)$patternRef.Value=$script:testValuePattern;$true }
      Invoke-ReadingAutomationButtonBeforeDeadline -Element $element -Deadline $deadline -UtcNowProvider $clock -PatternProvider { param($candidate,$patternRef)$patternRef.Value=$script:testInvokePattern;$true }
      if($valueWrites-ne1-or$buttonInvokes-ne1){throw 'Timely UI Automation mutations did not execute exactly once.'}
    `);
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects a native picker child from a mismatched process', () => {
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Assert-ReadingAutomationChildProcessId'], String.raw`
      $good=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=42}}
      Assert-ReadingAutomationChildProcessId -Elements @($good) -ApplicationProcessId 42 -Kind 'test'
      $bad=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=43}}
      $rejected=$false;try{Assert-ReadingAutomationChildProcessId -Elements @($bad) -ApplicationProcessId 42 -Kind 'test'}catch{$rejected=$true}
      if(-not$rejected){throw 'Mismatched picker child process was accepted.'}
    `);
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('avoids PowerShell automatic variables and enforces fresh exclusive profile binding', () => {
    for (const path of ['scripts/installed-reading-tools.ps1', 'scripts/verify-signed-reading-tools.ps1']) {
      const check = String.raw`
        $tokens=$null;$errors=$null
        $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\\${path.replaceAll('/', '\\')}',[ref]$tokens,[ref]$errors)
        if($errors.Count){throw 'Script did not parse.'}
        $forbidden=@('args','error','executioncontext','foreach','home','host','input','lastexitcode','matches','myinvocation','nestedpromptlevel','ofs','pid','pscommandpath','psscriptroot','psversiontable','pwd','shellid','stacktrace','this')
        $assigned=@($ast.FindAll({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left-is[Management.Automation.Language.VariableExpressionAst]},$true)|ForEach-Object{$_.Left.VariablePath.UserPath.ToLowerInvariant()})
        if(@($assigned|Where-Object{$forbidden-contains$_}).Count){throw 'Automatic or read-only variable assignment found.'}
      `;
      const result = runPowerShell(check);
      expect(result.status, result.stderr || result.stdout).toBe(0);
    }
    const source = readFileSync('scripts/installed-reading-tools.ps1', 'utf8');
    expect(source).toContain('Assert-ReadingProfileScope');
    expect(source).toContain("requested-profile|requested-ebwebview");
    expect(source).toContain("upgrade-sentinel.json");
    expect(source).toContain('stale, linked, or unrelated application-settings siblings');
    expect(source).toContain('requested WebView profile contains a reparse point');
  });

  it('rejects rogue descendants and binds runtime and session profile capabilities', () => {
    const source = readFileSync('scripts/installed-reading-tools.ps1', 'utf8');
    expect(source).toContain("$capabilities.PSObject.Properties['msedge.msedgedriverVersion']");
    expect(source).toContain('$capabilities.browserVersion');
    expect(source).toContain("$capabilities.'msedge.userDataDir'");
    expect(source).toContain('Get-OwnedProfileBinding');
    expect(source).toContain('Assert-TrustedConsoleHostTopology -Owned $Owned -RootProcessId $RootProcessId');
    expect(source).not.toContain('Assert-TrustedConsoleHostTopology -Owned $Owned -RootProcessId $RootProcessId -AllowAbsent');
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Get-ReadingSha256', 'Get-ReadingOwnedExecutableDiagnostic', 'Assert-ReadingOwnedExecutables'], String.raw`
      $script:ReadingPins=[ordered]@{OwnedProcessMaximum=128;UnknownExecutableHashMaximum=32}
      $script:trustedConsoleCalls=0;$script:rejectConsole=$false
      function Assert-TrustedConsoleHostTopology{param([object[]]$Owned,[int]$RootProcessId,[string]$SystemDirectory,[scriptblock]$SignatureProvider,[scriptblock]$VersionInfoProvider);$script:trustedConsoleCalls++;if($script:rejectConsole){throw 'Untrusted console topology.'};if($RootProcessId-ne900){throw 'Wrong root process.'};2}
      $app='C:\\Program Files\\PDF Workstation\\pdf-workstation.exe';$edge='C:\\drivers\\msedgedriver.exe'
      $valid=@([pscustomobject]@{ProcessId=101;ParentProcessId=900;Path=$app},[pscustomobject]@{ProcessId=102;ParentProcessId=900;Path=$edge},[pscustomobject]@{ProcessId=103;ParentProcessId=101;Path='C:\\WebView\\msedgewebview2.exe'},[pscustomobject]@{ProcessId=104;ParentProcessId=900;Path='C:\\Windows\\System32\\conhost.exe'},[pscustomobject]@{ProcessId=105;ParentProcessId=103;Path='C:\\Windows\\System32\\conhost.exe'})
      Assert-ReadingOwnedExecutables -Owned $valid -ApplicationPath $app -EdgeDriverPath $edge -RootProcessId 900
      if($trustedConsoleCalls-ne1){throw 'Reading topology did not invoke the trusted console-host validator.'}
      $rejected=$false;try{Assert-ReadingOwnedExecutables -Owned @($valid+[pscustomobject]@{ProcessId=106;ParentProcessId=900;Path='C:\\Windows\\notepad.exe'}) -ApplicationPath $app -EdgeDriverPath $edge -RootProcessId 900}catch{$rejected=$true}
      if(-not$rejected){throw 'Rogue descendant was accepted.'}
      $script:rejectConsole=$true;$consoleRejected=$false;try{Assert-ReadingOwnedExecutables -Owned $valid -ApplicationPath $app -EdgeDriverPath $edge -RootProcessId 900}catch{$consoleRejected=$_.Exception.Message-ceq'Untrusted console topology.'}
      if(-not$consoleRejected){throw 'Reading topology accepted a console host rejected by the shared validator.'}
    `);
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('uses only bounded exact WebDriver action payloads for Ctrl+C and Ctrl+F', () => {
    const source = readFileSync('scripts/installed-reading-tools.ps1', 'utf8');
    expect(source).toContain('"/session/$SessionId/actions"');
    expect(source).toContain("[ValidateSet('c','f')][string]$Key");
    expect(source).toContain("[string][char]0xE009");
    expect(source).toContain("type = 'keyDown'");
    expect(source).toContain("type = 'keyUp'");
    expect(source).toContain('RequestBytesMaximum = 1MB');
    expect(source).toContain('TotalTimeoutMilliseconds = 180000');
    expect(source).toContain('PortReleaseTimeoutMilliseconds = 180000');
    expect(source).toContain('$null = Wait-FixedWebDriverPortsFree -Deadline');
    expect(source).not.toContain('function Wait-ReadingWebDriverPortsFree');
    expect(source.indexOf('Wait-FixedWebDriverPortsFree -Deadline')).toBeLessThan(source.indexOf('$deadline = [datetime]::UtcNow.AddMilliseconds($script:ReadingPins.TotalTimeoutMilliseconds)'));
    expect(source).toContain('Assert-BoundedJsonShape');
  });

  it('uses the signed Home marker and the unique global Open action when Home has two Open buttons', () => {
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Get-ReadingHomeScript', 'Get-ReadingOpenFileScript'], String.raw`
      [ordered]@{home=Get-ReadingHomeScript;open=Get-ReadingOpenFileScript}|ConvertTo-Json -Compress
    `);
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const scripts = JSON.parse(result.stdout.trim()) as { home: string; open: string };
    expect(() => new Function('document', scripts.home)).not.toThrow();
    expect(() => new Function('document', scripts.open)).not.toThrow();
    const globalParent = { querySelector: (selector: string) => selector === 'button[aria-label="Toggle theme"]' ? {} : null };
    const emptyParent = { querySelector: () => null };
    const clicked: string[] = [];
    const buttons = [
      { textContent: 'Open a file', disabled: false, parentElement: globalParent, click: () => clicked.push('global') },
      { textContent: 'Open a file', disabled: false, parentElement: emptyParent, click: () => clicked.push('empty') },
      { textContent: 'Explore a sample PDF', disabled: false, parentElement: emptyParent, click: () => clicked.push('sample') },
    ];
    const document = { readyState: 'complete', title: 'PDF Workstation', querySelectorAll: (selector: string) => selector === 'button' ? buttons : [] };
    expect(new Function('document', scripts.home)(document)).toEqual({ ready: true, title: 'PDF Workstation', sample: 1 });
    expect(new Function('document', scripts.open)(document)).toBe(true);
    expect(clicked).toEqual(['global']);
    const checkedOutApp = readFileSync('src/App.tsx', 'utf8');
    expect((checkedOutApp.match(/Open a file/g) || []).length).toBeGreaterThan(1);
    expect(checkedOutApp).toContain('Explore a sample PDF');
  });

  it('waits boundedly for fixed ports released by the prior installed-app proof', () => {
    const check = extractFunctions('scripts/installed-app-launch.ps1', ['Wait-FixedWebDriverPortsFree'], String.raw`
      $script:LaunchPins=[ordered]@{CleanupProcessPollMilliseconds=100}
      $script:now=[datetime]::SpecifyKind([datetime]'2026-01-01T00:00:00',[DateTimeKind]::Utc);$attempts=0
      $clock={$script:now};$sleep={param($milliseconds)$script:now=$script:now.AddMilliseconds($milliseconds)}
      Wait-FixedWebDriverPortsFree -Deadline $script:now.AddMilliseconds(500) -ProbeProvider { $script:attempts++;if($script:attempts-lt3){throw 'A fixed loopback WebDriver port is already in use.'} } -SleepProvider $sleep -UtcNowProvider $clock|Out-Null
      if($attempts-ne3){throw 'Shared port-release probe did not retry exactly to success.'}
      $expiredProbes=0;$rejected=$false
      try{Wait-FixedWebDriverPortsFree -Deadline $script:now -ProbeProvider { $script:expiredProbes++ } -SleepProvider $sleep -UtcNowProvider $clock|Out-Null}catch{$rejected=$_.Exception.Message-ceq'Fixed loopback WebDriver ports did not become free before the handoff deadline.'}
      if(-not$rejected){throw 'Expired shared port-release wait did not fail closed.'}
      if($expiredProbes-ne0){throw 'Expired shared port-release wait invoked its probe.'}
    `);
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('suppresses the shared port status and leaves one reading result object on the return pipeline', () => {
    const check = String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\\scripts\\installed-reading-tools.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Reading script did not parse.'}
      $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq'Invoke-RealInstalledReadingTools'},$true)
      $waits=@($function.FindAll({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-ceq'Wait-FixedWebDriverPortsFree'},$true))
      if($waits.Count-ne1){throw 'Reading function did not contain one shared fixed-port handoff.'}
      $assignment=$waits[0]
      while($null-ne$assignment-and$assignment-isnot[Management.Automation.Language.AssignmentStatementAst]){$assignment=$assignment.Parent}
      if($null-eq$assignment-or$assignment.Left-isnot[Management.Automation.Language.VariableExpressionAst]-or$assignment.Left.VariablePath.UserPath-cne'null'){throw 'Shared fixed-port handoff output was not assigned to null.'}
      $returns=@($function.FindAll({param($node)$node-is[Management.Automation.Language.ReturnStatementAst]-and$node.Extent.Text.Trim()-ceq'return $result'},$true))
      if($returns.Count-ne1){throw 'Reading function did not expose one exact result return.'}
      function Wait-FixedWebDriverPortsFree{param([datetime]$Deadline);'free'}
      $script:ReadingPins=[ordered]@{PortReleaseTimeoutMilliseconds=180000}
      $result=[pscustomobject][ordered]@{schemaVersion=1;kind='reading-tools'}
      $statements=$assignment.Extent.Text+[Environment]::NewLine+$returns[0].Extent.Text
      $output=@(&([scriptblock]::Create($statements)))
      if($output.Count-ne1-or$output[0]-isnot[Management.Automation.PSCustomObject]-or($output[0].PSObject.Properties.Name-join',')-cne'schemaVersion,kind'){throw 'Shared fixed-port status contaminated the reading result pipeline.'}
    `;
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('reports deterministic bounded privacy-safe unknown descendant diagnostics', () => {
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Get-ReadingSha256', 'Get-ReadingOwnedExecutableDiagnostic', 'Assert-ReadingOwnedExecutables'], String.raw`
      $script:ReadingPins=[ordered]@{OwnedProcessMaximum=128;UnknownExecutableHashMaximum=32}
      $app='C:\\Program Files\\PDF Workstation\\pdf-workstation.exe';$edge='C:\\drivers\\msedgedriver.exe'
      $valid=@([pscustomobject]@{Path=$app},[pscustomobject]@{Path=$edge},[pscustomobject]@{Path='C:\\WebView\\msedgewebview2.exe'})
      $unknownA=[pscustomobject]@{Path='C:\\private\\NoTePad.EXE';ProcessId=98765;CommandLine='secret argument'}
      $unknownB=[pscustomobject]@{Path='D:\\sensitive\\ALPHA.exe';ProcessId=87654;CommandLine='private switch'}
      $missing=[pscustomobject]@{Path=$null;ProcessId=76543;CommandLine='hidden'}
      $first=Get-ReadingOwnedExecutableDiagnostic -Owned @($valid+$unknownA+$unknownB+$missing) -ApplicationPath $app -EdgeDriverPath $edge
      $second=Get-ReadingOwnedExecutableDiagnostic -Owned @(@($missing)+@($unknownB)+$valid+@($unknownA)) -ApplicationPath $app -EdgeDriverPath $edge
      $firstJson=$first|ConvertTo-Json -Depth 4 -Compress;$secondJson=$second|ConvertTo-Json -Depth 4 -Compress
      if($firstJson-cne$secondJson){throw 'Unknown descendant diagnostic was not deterministic.'}
      $expectedProperties='schemaVersion,capturedCount,applicationCount,edgeDriverCount,webViewCount,consoleHostCount,unknownCount,missingPathCount,unknownLeafHashCount,unknownLeafHashes,unknownLeafHashesTruncated,parentCategoryCountsAvailable,parentCategoryCounts'
      if(($first.PSObject.Properties.Name-join',')-cne$expectedProperties){throw 'Unknown descendant diagnostic schema drifted.'}
      if($first.capturedCount-ne6-or$first.applicationCount-ne1-or$first.edgeDriverCount-ne1-or$first.webViewCount-ne1-or$first.unknownCount-ne3-or$first.missingPathCount-ne1){throw 'Unknown descendant counts were incorrect.'}
      if($first.unknownLeafHashCount-ne2-or$first.unknownLeafHashes.Count-ne2-or$first.unknownLeafHashesTruncated-or$first.parentCategoryCountsAvailable-or$first.parentCategoryCounts.Count-ne0){throw 'Unknown descendant privacy fields were incorrect.'}
      if(@($first.unknownLeafHashes|Where-Object{$_-cnotmatch'^[A-F0-9]{64}$'}).Count){throw 'Unknown descendant leaf hash was malformed.'}
      function Assert-TrustedConsoleHostTopology{param([object[]]$Owned,[int]$RootProcessId,[string]$SystemDirectory,[scriptblock]$SignatureProvider,[scriptblock]$VersionInfoProvider);2}
      $console=@([pscustomobject]@{Path='C:\\Windows\\System32\\conhost.exe'},[pscustomobject]@{Path='C:\\Windows\\System32\\conhost.exe'})
      $message='';try{Assert-ReadingOwnedExecutables -Owned @($valid+$console+$unknownA+$missing) -ApplicationPath $app -EdgeDriverPath $edge -RootProcessId 900}catch{$message=$_.Exception.Message}
      if($message-cnotmatch'^Reading-tools captured an unexpected descendant executable; diagnostic='){throw 'Strict unknown descendant rejection was lost.'}
      foreach($forbidden in @('notepad.exe','private','sensitive','98765','secret argument','C:\\','D:\\')){if($message.ToLowerInvariant().Contains($forbidden.ToLowerInvariant())){throw 'Unknown descendant diagnostic leaked a raw value.'}}
      $many=@($valid);for($index=0;$index-lt35;$index++){$many+=[pscustomobject]@{Path=('C:\\private\\rogue-{0:d2}.exe'-f$index)}}
      $bounded=Get-ReadingOwnedExecutableDiagnostic -Owned $many -ApplicationPath $app -EdgeDriverPath $edge
      if($bounded.unknownCount-ne35-or$bounded.unknownLeafHashCount-ne32-or$bounded.unknownLeafHashes.Count-ne32-or-not$bounded.unknownLeafHashesTruncated){throw 'Unknown descendant hash cap was not enforced.'}
      $over=@();for($index=0;$index-lt129;$index++){$over+=[pscustomobject]@{Path=$app}}
      $capRejected=$false;try{Get-ReadingOwnedExecutableDiagnostic -Owned $over -ApplicationPath $app -EdgeDriverPath $edge|Out-Null}catch{$capRejected=$_.Exception.Message-ceq'Reading-tools owned executable inventory exceeded its process-count cap.'}
      if(-not$capRejected){throw 'Owned executable process cap did not fail closed.'}
      $firstJson
    `);
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const diagnostic = JSON.parse(result.stdout.trim()) as { unknownLeafHashes: string[] };
    const expectedNotepadHash = createHash('sha256').update('notepad.exe', 'utf8').digest('hex').toUpperCase();
    expect(diagnostic.unknownLeafHashes).toEqual([...diagnostic.unknownLeafHashes].sort());
    expect(diagnostic.unknownLeafHashes).toContain(expectedNotepadHash);
    expect(result.stdout).not.toMatch(/notepad\.exe|private|sensitive|98765|secret argument|[A-Z]:\\/i);
  });

  it('loads and executes the production receipt helper in a standalone reading script process', () => {
    const source = String.raw`
      $ErrorActionPreference='Stop';Set-StrictMode -Version Latest
      . '${process.cwd().replaceAll("'", "''")}\scripts\installed-reading-tools.ps1'
      $root=Join-Path (Resolve-Path target) ('reading-receipt-'+[Guid]::NewGuid().ToString('N'))
      [IO.Directory]::CreateDirectory($root)|Out-Null
      $path=Join-Path $root 'receipt.bin';[IO.File]::WriteAllBytes($path,[byte[]](1,2,3,4))
      $sha=Get-ExactSha256 -Path $path
      Assert-ReadingFileReceipt -Path $path -Bytes 4 -Sha256 $sha -Kind 'Standalone receipt fixture'
      [IO.File]::WriteAllBytes($path,[byte[]](1,2,3,5))
      $rejected=$false;try{Assert-ReadingFileReceipt -Path $path -Bytes 4 -Sha256 $sha -Kind 'Standalone receipt fixture'}catch{$rejected=$true}
      if(-not$rejected){throw 'The production receipt helper accepted changed bytes.'}
    `;
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('generates the exact deterministic encrypted PDF without a helper binary or network', () => {
    const script = readFileSync('scripts/verify-signed-reading-tools.ps1', 'utf8');
    expect(script).not.toMatch(/cargo|rustc|Invoke-WebRequest|Invoke-RestMethod|https?:\/\//i);
    const source = extractFunctions('scripts/verify-signed-reading-tools.ps1', [
      'Join-ReadingByteArrays', 'Get-ReadingMd5', 'Invoke-ReadingRc4',
      'Get-ReadingPasswordPad', 'New-ProtectedReadingFixture',
    ], String.raw`
      . '${process.cwd().replaceAll("'", "''")}\scripts\installed-reading-tools.ps1'
      $script:ReadingVerificationPins=[ordered]@{ProtectedFixtureBytes=[uint64]912;ProtectedFixtureSha256='9BE85022232671CFD796C711E0B8B06847E7020D49AA07FA20DBD6DADE168A37'}
      $root=Join-Path (Resolve-Path target) ('reading-fixture-'+[Guid]::NewGuid().ToString('N'))
      [IO.Directory]::CreateDirectory($root)|Out-Null
      New-ProtectedReadingFixture -Destination (Join-Path $root 'first.pdf')
      New-ProtectedReadingFixture -Destination (Join-Path $root 'second.pdf')
      $a=[IO.File]::ReadAllBytes((Join-Path $root 'first.pdf'));$b=[IO.File]::ReadAllBytes((Join-Path $root 'second.pdf'))
      if(-not[System.Linq.Enumerable]::SequenceEqual[byte]($a,$b)){throw 'Fixture generation was not deterministic.'}
      $ascii=[Text.Encoding]::ASCII.GetString($a)
      if($ascii-notmatch'^%PDF-1\.4'-or$ascii-notmatch'/Filter /Standard /V 1 /R 2'-or$ascii-notmatch'/Encrypt 6 0 R'-or$ascii-match'Protected reading fixture'){throw 'Encrypted fixture structure was not exact.'}
    `);
    const result = runPowerShell(source);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('retains only hashed or Boolean reading evidence and gates cleanup at zero processes', () => {
    const installed = readFileSync('scripts/installed-reading-tools.ps1', 'utf8');
    const verify = readFileSync('scripts/verify-signed-reading-tools.ps1', 'utf8');
    expect(verify).toContain("reading-tools-verification.json");
    expect(verify).toContain('selectedTextSha256');
    expect(verify).toContain('clipboardSha256');
    expect(verify).toContain("method = 'programmatic-dom-range-plus-real-windows-clipboard'");
    expect(verify).toContain('programmaticDomSelectionVerified');
    expect(verify).toContain('uiReentryRequiredAfterCloseAndReopen');
    expect(verify).toContain('passwordStoragePersistenceInspected=$false');
    expect(verify).toContain('artifactIdentifierIncluded = $false');
    expect(verify).toContain('11005152678|36499724415');
    expect(verify).toContain('The reading-tools record contains a raw path, text fixture value, password');
    expect(installed).toContain('Invoke-ReadingClipboardSta -Operation clear');
    expect(installed).toContain('$clipboardCleared');
    expect(installed).toContain('Post-flow plain reading fixture');
    expect(installed).toContain('The reading fixture inventory changed or contains a reparse point.');
    expect(installed).toContain('Assert-LaunchCleanupState');
    expect(installed).toContain('Wait-LaunchProcessQuiescence -Deadline $processCleanupDeadline');
    expect(installed).toContain('-not $processesQuiescent');
    expect(installed).toContain("$sessionDeleteOutcome -cne 'verified'");
    expect(installed).toContain('$remaining -ne 0');
    expect(installed).toContain('-NotePropertyName relevantProcessesRemaining -NotePropertyValue 0');
    expect(verify).not.toMatch(/plainFixture\s*=\s*\[ordered\]@\{[^}]*path/);
  });
});
