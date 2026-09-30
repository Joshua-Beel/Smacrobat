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
    expect(source).toContain("$collection.Count -gt 8");
    expect(source).toContain('MaximumCount 256');
    expect(source).toContain('$Dialog.Current.ProcessId -ne $ApplicationProcessId');
    expect(source).toContain('[Windows.Automation.AndCondition]::new($processCondition,$editTypeCondition)');
    expect(source).toContain('[Windows.Automation.AndCondition]::new($processCondition,$buttonTypeCondition)');
    expect(source).toContain("-Kind 'filename editor'");
    expect(source).toContain("-Kind 'Open button'");
    expect(source).toContain("ClassName -ceq '#32770'");
    expect(source).toContain("AutomationId -in @('1001','1148')");
    expect(source).toContain("AutomationId -ceq '1'");
    expect(source).toContain('[Windows.Automation.ValuePattern]::Pattern');
    expect(source).toContain('[Windows.Automation.InvokePattern]::Pattern');
    expect(source).not.toMatch(/SendKeys|mouse_event|SetCursorPos|click_input|screenX|screenY|__TAURI_INTERNALS__/i);
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
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Get-ReadingSha256', 'Get-ReadingOwnedExecutableDiagnostic', 'Assert-ReadingOwnedExecutables'], String.raw`
      $script:ReadingPins=[ordered]@{OwnedProcessMaximum=128;UnknownExecutableHashMaximum=32}
      $app='C:\\Program Files\\PDF Workstation\\pdf-workstation.exe';$edge='C:\\drivers\\msedgedriver.exe'
      $valid=@([pscustomobject]@{Path=$app},[pscustomobject]@{Path=$edge},[pscustomobject]@{Path='C:\\WebView\\msedgewebview2.exe'})
      Assert-ReadingOwnedExecutables $valid $app $edge
      $rejected=$false;try{Assert-ReadingOwnedExecutables @($valid+[pscustomobject]@{Path='C:\\Windows\\notepad.exe'}) $app $edge}catch{$rejected=$true}
      if(-not$rejected){throw 'Rogue descendant was accepted.'}
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
    expect(source).toContain('Wait-ReadingWebDriverPortsFree -Deadline');
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
    const check = extractFunctions('scripts/installed-reading-tools.ps1', ['Wait-ReadingWebDriverPortsFree'], String.raw`
      $script:ReadingPins=[ordered]@{PortReleasePollMilliseconds=1}
      $attempts=0
      Wait-ReadingWebDriverPortsFree -Deadline ([datetime]::UtcNow.AddSeconds(2)) -Probe { $script:attempts++;if($script:attempts-lt3){throw 'still occupied'} }
      if($attempts-ne3){throw 'Port-release probe did not retry exactly to success.'}
      $expiredProbes=0;$rejected=$false
      try{Wait-ReadingWebDriverPortsFree -Deadline ([datetime]::UtcNow.AddMilliseconds(-1)) -Probe { $script:expiredProbes++ }}catch{$rejected=$_.Exception.Message-ceq'The prior installed-app proof did not release the fixed WebDriver ports before the bounded reading-tools handoff.'}
      if(-not$rejected){throw 'Expired port-release wait did not fail closed.'}
      if($expiredProbes-ne0){throw 'Expired port-release wait invoked its probe.'}
    `);
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
      $expectedProperties='schemaVersion,capturedCount,applicationCount,edgeDriverCount,webViewCount,unknownCount,missingPathCount,unknownLeafHashCount,unknownLeafHashes,unknownLeafHashesTruncated,parentCategoryCountsAvailable,parentCategoryCounts'
      if(($first.PSObject.Properties.Name-join',')-cne$expectedProperties){throw 'Unknown descendant diagnostic schema drifted.'}
      if($first.capturedCount-ne6-or$first.applicationCount-ne1-or$first.edgeDriverCount-ne1-or$first.webViewCount-ne1-or$first.unknownCount-ne3-or$first.missingPathCount-ne1){throw 'Unknown descendant counts were incorrect.'}
      if($first.unknownLeafHashCount-ne2-or$first.unknownLeafHashes.Count-ne2-or$first.unknownLeafHashesTruncated-or$first.parentCategoryCountsAvailable-or$first.parentCategoryCounts.Count-ne0){throw 'Unknown descendant privacy fields were incorrect.'}
      if(@($first.unknownLeafHashes|Where-Object{$_-cnotmatch'^[A-F0-9]{64}$'}).Count){throw 'Unknown descendant leaf hash was malformed.'}
      $message='';try{Assert-ReadingOwnedExecutables -Owned @($valid+$unknownA+$missing) -ApplicationPath $app -EdgeDriverPath $edge}catch{$message=$_.Exception.Message}
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
    expect(installed).toContain("$sessionDeleteOutcome -cne 'verified'");
    expect(installed).toContain('$remaining -ne 0');
    expect(installed).toContain('-NotePropertyName relevantProcessesRemaining -NotePropertyValue 0');
    expect(verify).not.toMatch(/plainFixture\s*=\s*\[ordered\]@\{[^}]*path/);
  });
});
