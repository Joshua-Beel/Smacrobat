import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const source = readFileSync('scripts/installed-persistence.ps1', 'utf8');

function runPowerShell(script: string, executable = 'powershell.exe') {
  return spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
  });
}

describe('installed persistence WebDriver proof', () => {
  it('parses and uses only real UI controls for product state changes', () => {
    const check = String.raw`
      $tokens=$null;$errors=$null
      [Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-persistence.ps1',[ref]$tokens,[ref]$errors)|Out-Null
      if($errors.Count){throw 'Installed persistence script did not parse.'}
    `;
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(source).not.toMatch(/localStorage|sessionStorage|__TAURI__|invoke\s*\(/i);
    for (const control of ['Explore a sample PDF', 'Zoom in', 'Fit page', 'Select text on page', 'Collapse all tools', 'Pages', 'Toggle theme', 'Star welcome.pdf', 'Clear file history']) {
      expect(source).toContain(control);
    }
  });

  it('keeps every formerly split script as one exact runtime value with valid JavaScript syntax', () => {
    const check = String.raw`
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-persistence.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Installed persistence script did not parse.'}
      foreach($name in @('Get-PersistenceHomeScript','Get-PersistenceSampleRenderScript','Get-PersistenceZoomObserveScript','Get-PersistenceImageRenderScript','Get-PersistenceRecentStateScript')){
        $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq$name},$true)
        if($null-eq$function){throw ('Missing script helper: '+$name)}
        Invoke-Expression $function.Extent.Text
      }
      $stages=@('home-ready','sample-render','zoom-observe','recent-restart-observe','recent-reopen-render','post-clear-sample-render')
      $commands=@($ast.FindAll({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-ceq'Wait-PersistenceUi'},$true)|Where-Object{
        $elements=$_.CommandElements
        $stageIndex=-1
        for($index=0;$index-lt$elements.Count;$index++){if($elements[$index]-is[Management.Automation.Language.CommandParameterAst]-and$elements[$index].ParameterName-ceq'Stage'){$stageIndex=$index;break}}
        $stageIndex-ge 0-and$stageIndex+1-lt$elements.Count-and$stages-contains[string]$elements[$stageIndex+1].Value
      })
      if($commands.Count-ne 6){throw 'The exact six persistence stages were not found.'}
      $expectedInvocations=@{
        'home-ready'='(Get-PersistenceHomeScript)'
        'sample-render'='(Get-PersistenceSampleRenderScript)'
        'zoom-observe'='(Get-PersistenceZoomObserveScript -Expected $expected)'
        'recent-restart-observe'='(Get-PersistenceRecentStateScript)'
        'recent-reopen-render'='(Get-PersistenceImageRenderScript)'
        'post-clear-sample-render'='(Get-PersistenceImageRenderScript)'
      }
      foreach($command in $commands){
        $elements=$command.CommandElements
        $scriptIndex=-1;$stageIndex=-1
        for($index=0;$index-lt$elements.Count;$index++){
          if($elements[$index]-is[Management.Automation.Language.CommandParameterAst]-and$elements[$index].ParameterName-ceq'Script'){$scriptIndex=$index}
          if($elements[$index]-is[Management.Automation.Language.CommandParameterAst]-and$elements[$index].ParameterName-ceq'Stage'){$stageIndex=$index}
        }
        if($scriptIndex-lt 0-or$scriptIndex+2-ge$elements.Count-or$elements[$scriptIndex+1]-isnot[Management.Automation.Language.ParenExpressionAst]-or
          $elements[$scriptIndex+2]-isnot[Management.Automation.Language.CommandParameterAst]-or$elements[$scriptIndex+2].ParameterName-cne'Predicate'){
          throw 'An affected persistence Script parameter is not exactly one parenthesized AST value.'
        }
        $stage=[string]$elements[$stageIndex+1].Value
        if($elements[$scriptIndex+1].Extent.Text-cne$expectedInvocations[$stage]){throw ('Persistence stage uses the wrong script helper: '+$stage)}
      }
      [ordered]@{
        home=Get-PersistenceHomeScript
        sample=Get-PersistenceSampleRenderScript
        zoom125=Get-PersistenceZoomObserveScript -Expected 125
        zoom150=Get-PersistenceZoomObserveScript -Expected 150
        zoom175=Get-PersistenceZoomObserveScript -Expected 175
        image=Get-PersistenceImageRenderScript
      }|ConvertTo-Json -Compress
    `;
    for (const executable of ['powershell.exe', 'pwsh']) {
      const result = runPowerShell(check, executable);
      expect(result.status, `${executable}: ${result.stderr || result.stdout}`).toBe(0);
      const scripts = JSON.parse(result.stdout.trim()) as Record<string, string>;
      expect(scripts.home).toBe(`return {ready:document.readyState==='complete',title:document.title,sample:[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Explore a sample PDF'&&!x.disabled).length};`);
      expect(scripts.sample).toBe(`const i=document.querySelector('img[alt="Page 1"]');return {tab:[...document.querySelectorAll('button')].some(x=>x.textContent.includes('welcome.pdf')),pages:[...document.querySelectorAll('span')].some(x=>x.textContent.trim()==='/ 6'),image:!!i&&i.complete&&i.naturalWidth>0&&i.src.startsWith('blob:')};`);
      expect(scripts.zoom125).toBe(`const z=document.querySelector('select[aria-label="Zoom"]');return z?.value==='125';`);
      expect(scripts.zoom150).toBe(`const z=document.querySelector('select[aria-label="Zoom"]');return z?.value==='150';`);
      expect(scripts.zoom175).toBe(`const z=document.querySelector('select[aria-label="Zoom"]');return z?.value==='175';`);
      expect(scripts.image).toBe(`const i=document.querySelector('img[alt="Page 1"]');return !!i&&i.complete&&i.naturalWidth>0&&i.src.startsWith('blob:');`);
      for (const value of Object.values(scripts)) expect(() => new Function(value)).not.toThrow();
    }
    expect(source.match(/-Script \(Get-PersistenceImageRenderScript\)/g)).toHaveLength(2);
  }, 15_000);

  it('uses the unique Home sample marker only for empty-history phases', () => {
    const check = String.raw`
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-persistence.ps1',[ref]$tokens,[ref]$errors)
      $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq'Get-PersistenceHomeScript'},$true)
      Invoke-Expression $function.Extent.Text
      Get-PersistenceHomeScript
    `;
    const result = runPowerShell(check, 'pwsh');
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const homeScript = result.stdout.trim();
    const buttons = [
      { textContent: 'Open a file', disabled: false },
      { textContent: 'Open a file', disabled: false },
      { textContent: 'Explore a sample PDF', disabled: false },
    ];
    const document = {
      readyState: 'complete',
      title: 'PDF Workstation',
      querySelectorAll: (selector: string) => selector === 'button' ? buttons : [],
    };
    expect(new Function('document', homeScript)(document)).toEqual({ ready: true, title: 'PDF Workstation', sample: 1 });
    const appSource = readFileSync('src/App.tsx', 'utf8');
    expect((appSource.match(/Open a file/g) || []).length).toBeGreaterThan(1);
    expect(appSource).toContain('Explore a sample PDF');
    expect(appSource).toContain('!listed.length');
    const flow = source.slice(source.indexOf('function Invoke-PersistenceUiFlow'), source.indexOf('function Invoke-RealPersistenceLaunch'));
    expect(flow.match(/-Stage 'home-ready'/g)).toHaveLength(1);
    expect(flow.match(/-Stage 'recent-restart-observe'/g)).toHaveLength(1);
    expect(flow).toContain("if ($Mode -ceq 'verify-and-clear') {");
    expect(flow.indexOf("-Stage 'recent-restart-observe'")).toBeLessThan(flow.indexOf("if ($Mode -ceq 'write')"));
    expect(flow).not.toContain("sample:[...document.querySelectorAll('button')].some");
  });

  it('uses the same profile roots across three clean process launches and verifies clear on the third', () => {
    expect(source).toContain("foreach ($mode in @('write','verify-and-clear','verify-cleared'))");
    expect(source).toContain('-ProfileRoot $ProfileRoot -SettingsRoot $SettingsRoot');
    expect(source).toContain("throw 'Installed application restarts did not reuse the same controlled profile binding.'");
    expect(source).toContain("clearPersisted = $true");
    expect(source).toContain("excludedScope = @('Bookmarks','Comments','Find')");
    expect(source).not.toContain('unsupportedPersistedPanels');
    expect(source).toContain('Assert-PersistenceSentinel');
    expect(source).toContain('Assert-PersistenceStorageScope');
    expect(source).toContain("[int]$v.retainedZoom -eq $script:PersistencePins.Zoom");
    expect(source).toContain("[int]$v.pages -eq $script:PersistencePins.SamplePages");
  });

  it('accepts only exact supported UI state and phase-specific recent state', () => {
    const check = String.raw`
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-persistence.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Installed persistence script did not parse.'}
      foreach($name in @('Assert-PersistenceExactProperties','Assert-PersistenceLaunchResult')){
        $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq$name},$true)
        if($null-eq$function){throw ('Missing function: '+$name)}
        Invoke-Expression $function.Extent.Text
      }
      $script:PersistencePins=[ordered]@{Zoom=175}
      function New-Result([string]$mode,[bool]$recent,[bool]$starred,[bool]$cleared){
        [pscustomobject]@{mode=$mode;nativeDriverVersion='151.0.1.2';returnedRuntimeVersion='151.0.4129.50';profileBinding='session-capability-requested-profile';preferences=[pscustomobject]@{fit='page';retainedZoom=175;selectActive=$true;panActive=$false;toolsPanel=$false;pagesPanel=$true;dark=$true};recentPresent=$recent;starred=$starred;clearPersisted=$cleared;sessionDeleted=$true;ownedProcessTreeStopped=$true;relevantProcessesRemaining=0}
      }
      foreach($good in @((New-Result 'write' $true $true $false),(New-Result 'verify-and-clear' $true $true $false),(New-Result 'verify-cleared' $false $false $true))){
        Assert-PersistenceLaunchResult $good $good.mode '151.0.1.2' '151.0.4129.99'
      }
      foreach($mutation in @('star','clear','pan','zoom','driver','runtime')){
        $bad=if($mutation-ceq'clear'){New-Result 'verify-cleared' $true $true $false}else{New-Result 'write' $true $true $false}
        if($mutation-ceq'star'){$bad.starred=$false}elseif($mutation-ceq'pan'){$bad.preferences.panActive=$true}elseif($mutation-ceq'zoom'){$bad.preferences.retainedZoom=150}elseif($mutation-ceq'driver'){$bad.nativeDriverVersion='150.0.1.2'}elseif($mutation-ceq'runtime'){$bad.returnedRuntimeVersion='150.0.4129.50'}
        $rejected=$false;try{Assert-PersistenceLaunchResult $bad $bad.mode '151.0.1.2' '151.0.4129.99'}catch{$rejected=$true};if(-not$rejected){throw ('Invalid persistence result was accepted: '+$mutation)}
      }
    `;
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('allows only the exact captured app, driver, and at least one WebView descendant', () => {
    const launchSource = readFileSync('scripts/installed-app-launch.ps1', 'utf8');
    expect(launchSource).toContain('ParentProcessId = [int]$_.ParentProcessId');
    const check = String.raw`
      . ./scripts/ocr/installer-package.ps1
      . ./scripts/ocr/windows-signing.ps1
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-persistence.ps1',[ref]$tokens,[ref]$errors)
      $pins=$ast.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$script:PersistencePins'},$true);Invoke-Expression $pins.Extent.Text
      $launchAst=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-app-launch.ps1',[ref]$tokens,[ref]$errors)
      $launchPins=$launchAst.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$script:LaunchPins'},$true);Invoke-Expression $launchPins.Extent.Text
      $consoleFunction=$launchAst.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq'Assert-TrustedConsoleHostTopology'},$true);Invoke-Expression $consoleFunction.Extent.Text
      foreach($name in @('Assert-PersistenceExactProperties','Get-PersistenceOwnedExecutableCounts','Assert-PersistenceOwnedExecutables')){$function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq$name},$true);Invoke-Expression $function.Extent.Text}
      $system=[Environment]::GetFolderPath([Environment+SpecialFolder]::System);$conhost=Join-Path $system 'conhost.exe'
      $signature={param($path)[pscustomobject]@{Status='Valid';Publisher='Microsoft Windows';HasTimestamp=$true}}
      $version={param($path)[pscustomobject]@{CompanyName='Microsoft Corporation';ProductName=('Microsoft'+[char]0x00AE+' Windows'+[char]0x00AE+' Operating System');InternalName='ConHost';FileDescription='Console Window Host'}}
      $app='C:\Program Files\PDF Workstation\pdf-workstation.exe';$edge='C:\drivers\msedgedriver.exe'
      $validCore=@([pscustomobject]@{ProcessId=101;ParentProcessId=900;Path=$app},[pscustomobject]@{ProcessId=102;ParentProcessId=900;Path=$edge},[pscustomobject]@{ProcessId=103;ParentProcessId=101;Path='C:\WebView\msedgewebview2.exe'})
      $valid=@($validCore+[pscustomobject]@{ProcessId=104;ParentProcessId=900;Path=$conhost},[pscustomobject]@{ProcessId=105;ParentProcessId=103;Path=$conhost})
      Assert-PersistenceOwnedExecutables $valid $app $edge -RootProcessId 900 -SystemDirectory $system -ConsoleHostSignatureProvider $signature -ConsoleHostVersionInfoProvider $version
      $sequential=@($valid+[pscustomobject]@{ProcessId=106;ParentProcessId=900;Path=$conhost})
      Assert-PersistenceOwnedExecutables $sequential $app $edge -RootProcessId 900 -SystemDirectory $system -ConsoleHostSignatureProvider $signature -ConsoleHostVersionInfoProvider $version
      $sequentialReceipt=Get-PersistenceOwnedExecutableCounts $sequential $app $edge -RootProcessId 900
      if($sequentialReceipt.unknownCount-ne3-or$sequentialReceipt.parentCategoryCounts.rootCount-ne2-or$sequentialReceipt.parentCategoryCounts.webViewCount-ne1){throw 'Sequential trusted console-host diagnostics changed.'}
      $receipt=Get-PersistenceOwnedExecutableCounts $valid $app $edge -RootProcessId 900
      Assert-PersistenceExactProperties -Value $receipt -Expected @('applicationCount','edgeDriverCount','webViewCount','unknownCount','totalCount','missingPathCount','unknownLeafNameSha256','parentCategoryCounts') -Kind 'Sanitized persistence process counts'
      Assert-PersistenceExactProperties -Value $receipt.parentCategoryCounts -Expected @('applicationCount','edgeDriverCount','webViewCount','rootCount','unknownCount','unavailableCount') -Kind 'Sanitized persistence parent-category counts'
      if($receipt.applicationCount-ne1-or$receipt.edgeDriverCount-ne1-or$receipt.webViewCount-ne1-or$receipt.unknownCount-ne2-or$receipt.totalCount-ne5-or$receipt.missingPathCount-ne0-or$receipt.unknownLeafNameSha256.Count-ne1-or$receipt.unknownLeafNameSha256[0]-cne'C7FA65795C3627674274F83CCAB5776C80922708787A2121AC4D5CFD02551FC4'-or$receipt.parentCategoryCounts.rootCount-ne1-or$receipt.parentCategoryCounts.webViewCount-ne1){throw 'Approved persistence process counts changed.'}
      foreach($bad in @(@($valid[0],$valid[1]),@($valid+[pscustomobject]@{ProcessId=104;ParentProcessId=101;Path='C:\Secret\private-helper.exe';CommandLine='private command'}),@($valid+$valid[0]))){
        $rejected=$false;$message='';try{Assert-PersistenceOwnedExecutables $bad $app $edge -RootProcessId 900 -SystemDirectory $system -ConsoleHostSignatureProvider $signature -ConsoleHostVersionInfoProvider $version}catch{$rejected=$true;$message=$_.Exception.Message};if(-not$rejected){throw 'Unsafe captured descendant set was accepted.'}
        if($message-match'(?i)(secret|private-helper|private command|program files|pdf-workstation|msedgedriver|msedgewebview2|\\)'-or$message-cnotmatch'ownedCounts=\{'){throw 'Persistence descendant rejection leaked identity or omitted sanitized counts.'}
      }
      $script:PersistencePins.OwnedProcessMaximum=2;$rejected=$false;try{Get-PersistenceOwnedExecutableCounts $valid $app $edge|Out-Null}catch{$rejected=$true};if(-not$rejected){throw 'Oversized persistence descendant inventory was accepted.'}
      $script:PersistencePins.OwnedProcessMaximum=128
      $diagnostic=@($validCore,
        [pscustomobject]@{ProcessId=104;ParentProcessId=101;Path='C:\Secret\zeta-helper.exe';CommandLine='private command'},
        [pscustomobject]@{ProcessId=105;ParentProcessId=102;Path='C:\Secret\alpha-helper.exe'},
        [pscustomobject]@{ProcessId=106;ParentProcessId=103;Path='C:\Secret\web-helper.exe'},
        [pscustomobject]@{ProcessId=107;ParentProcessId=900;Path='C:\Secret\root-helper.exe'},
        [pscustomobject]@{ProcessId=108;ParentProcessId=999;Path='C:\Secret\external-helper.exe'},
        [pscustomobject]@{ProcessId=109;Path=$null})
      $diagnostic=@($diagnostic|ForEach-Object{$_})
      $details=Get-PersistenceOwnedExecutableCounts $diagnostic $app $edge -RootProcessId 900
      $reverse=Get-PersistenceOwnedExecutableCounts @($diagnostic[($diagnostic.Count-1)..0]) $app $edge -RootProcessId 900
      if(($details.unknownLeafNameSha256-join',')-cne($reverse.unknownLeafNameSha256-join',')){throw 'Unknown identity hashes are not deterministic and sorted.'}
      if($details.unknownCount-ne6-or$details.totalCount-ne9-or$details.missingPathCount-ne1-or$details.unknownLeafNameSha256.Count-ne5-or$details.parentCategoryCounts.applicationCount-ne1-or$details.parentCategoryCounts.edgeDriverCount-ne1-or$details.parentCategoryCounts.webViewCount-ne1-or$details.parentCategoryCounts.rootCount-ne1-or$details.parentCategoryCounts.unknownCount-ne1-or$details.parentCategoryCounts.unavailableCount-ne1){throw 'Sanitized unknown descendant diagnostics changed.'}
      $script:PersistencePins.UnknownIdentityMaximum=4;$rejected=$false;try{Get-PersistenceOwnedExecutableCounts $diagnostic $app $edge -RootProcessId 900|Out-Null}catch{$rejected=$true};if(-not$rejected){throw 'Oversized unknown identity inventory was accepted.'}
      $details|ConvertTo-Json -Depth 4 -Compress
    `;
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const details = JSON.parse(result.stdout.trim());
    const expectedHashes = ['alpha-helper.exe', 'external-helper.exe', 'root-helper.exe', 'web-helper.exe', 'zeta-helper.exe']
      .map((leaf) => createHash('sha256').update(leaf, 'utf8').digest('hex').toUpperCase()).sort();
    expect(details.unknownLeafNameSha256).toEqual(expectedHashes);
    expect(source).toContain('Persistence WebDriver captured an unexpected descendant executable; ownedCounts=$summary.');
  });

  it('enforces exclusive nonempty reparse-safe profile topology and runtime receipts', () => {
    expect(source).toContain("throw 'The requested profile, application settings, and sentinel topology is not exclusive.'");
    expect(source).toContain("throw 'A persistence profile top-level entry is a reparse point.'");
    expect(source).toContain("throw 'The active persistence profile contains a reparse point.'");
    expect(source).toContain("throw 'The bound persistence profile remained empty.'");
    expect(source).toContain("$vendorDriverProperty = $capabilities.PSObject.Properties['msedge.msedgedriverVersion']");
    expect(source).toContain('$returnedRuntimeVersion = [string]$capabilities.browserVersion');
    expect(source).toContain('-ExpectedRuntimeVersion $ExpectedRuntimeVersion');
  });

  it('keeps every WebDriver request bounded and every launch cleanup fail closed', () => {
    const result = runPowerShell(String.raw`
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-persistence.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Installed persistence script did not parse.'}
      $pins=$ast.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$script:PersistencePins'},$true)
      Invoke-Expression $pins.Extent.Text
      if($script:PersistencePins.LaunchTimeoutMilliseconds-ne120000-or$script:PersistencePins.SessionCreationTimeoutMilliseconds-ne60000-or$script:PersistencePins.PortHandoffTimeoutMilliseconds-ne300000){throw 'Persistence timeout pins changed.'}
      $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq'Invoke-RealPersistenceLaunch'},$true)
      $override=$function.Body.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$script:LaunchPins.SessionCreationTimeoutMilliseconds'},$true)
      $handoffDeadline=$function.Body.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$handoffDeadline'},$true)
      $handoff=$function.Body.Find({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-ceq'Wait-FixedWebDriverPortsFree'},$true)
      $deadline=$function.Body.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$deadline'},$true)
      $startedAfter=$function.Body.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$startedAfter'},$true)
      $startDriver=$function.Body.Find({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-ceq'Start-BoundedDiscardProcess'},$true)
      $session=$function.Body.Find({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-ceq'Invoke-BoundedLoopbackJson'-and$node.Extent.Text-cmatch"-Method POST -Path '/session'"},$true)
      if($null-eq$override-or$null-eq$handoffDeadline-or$null-eq$handoff-or$null-eq$deadline-or$null-eq$startedAfter-or$null-eq$startDriver-or$null-eq$session-or
        $handoffDeadline.Extent.Text-cnotmatch'PortHandoffTimeoutMilliseconds'-or$deadline.Extent.Text-cnotmatch'LaunchTimeoutMilliseconds'-or
        $handoffDeadline.Extent.StartOffset-ge$handoff.Extent.StartOffset-or$handoff.Extent.StartOffset-ge$deadline.Extent.StartOffset-or$deadline.Extent.StartOffset-ge$startedAfter.Extent.StartOffset-or$startedAfter.Extent.StartOffset-ge$startDriver.Extent.StartOffset-or
        $override.Extent.StartOffset-ge$session.Extent.StartOffset-or$deadline.Extent.StartOffset-ge$session.Extent.StartOffset){throw 'Persistence port handoff and fresh UI deadline ordering changed.'}
      if($function.Extent.Text-cmatch'Assert-FixedWebDriverPortsFree'){throw 'Persistence bypassed the bounded fixed-port handoff wait.'}
      $launchAst=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-app-launch.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Installed launch helper did not parse.'}
      $launchPins=$launchAst.Find({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left.Extent.Text-ceq'$script:LaunchPins'},$true)
      Invoke-Expression $launchPins.Extent.Text
      foreach($name in @('Get-LaunchRemainingMilliseconds','Get-LoopbackRequestTimeoutMilliseconds')){
        $helper=$launchAst.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq$name},$true)
        Invoke-Expression $helper.Extent.Text
      }
      $script:LaunchPins.SessionCreationTimeoutMilliseconds=$script:PersistencePins.SessionCreationTimeoutMilliseconds
      $launchDeadline=[datetime]::UtcNow.AddMilliseconds($script:PersistencePins.LaunchTimeoutMilliseconds)
      $sessionTimeout=Get-LoopbackRequestTimeoutMilliseconds -Method POST -Path '/session' -Port $script:LaunchPins.WebDriverPort -Deadline $launchDeadline
      $ordinaryTimeout=Get-LoopbackRequestTimeoutMilliseconds -Method GET -Path '/status' -Port $script:LaunchPins.WebDriverPort -Deadline $launchDeadline
      if($sessionTimeout-ne60000-or$ordinaryTimeout-ne10000){throw 'Persistence request timeout caps changed.'}
    `, 'pwsh');
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(source).toContain('Invoke-SessionDeleteOutcome');
    expect(source).toContain('Stop-OwnedLaunchProcesses');
    expect(source).toContain('$processCleanupDeadline = [datetime]::UtcNow.AddMilliseconds($script:LaunchPins.CleanupProcessTimeoutMilliseconds)');
    expect(source).toContain('Wait-LaunchProcessQuiescence -Deadline $processCleanupDeadline');
    expect(source).toContain('-not $processesQuiescent');
    expect(source).toContain('Assert-LaunchCleanupState');
    expect(source).toContain("throw 'Persistence launch cleanup was incomplete.'");
    expect(source).toContain('relevantProcessesRemaining = 0');
  });

  it('does not assign to PowerShell automatic or read-only variables', () => {
    const check = String.raw`
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-persistence.ps1',[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'Installed persistence script did not parse.'}
      $forbidden=@('args','error','executioncontext','foreach','home','host','input','lastexitcode','matches','myinvocation','nestedpromptlevel','ofs','pid','pscommandpath','psscriptroot','psversiontable','pwd','shellid','stacktrace','this')
      $assigned=@($ast.FindAll({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left-is[Management.Automation.Language.VariableExpressionAst]},$true)|ForEach-Object{$_.Left.VariablePath.UserPath.ToLowerInvariant()})
      $collisions=@($assigned|Where-Object{$forbidden-contains$_});if($collisions.Count){throw ('Persistence helper assigns automatic/read-only variables: '+($collisions-join','))}
    `;
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
