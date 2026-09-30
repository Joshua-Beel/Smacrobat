import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
      foreach($name in @('Get-PersistenceSampleRenderScript','Get-PersistenceZoomObserveScript','Get-PersistenceImageRenderScript')){
        $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq$name},$true)
        if($null-eq$function){throw ('Missing script helper: '+$name)}
        Invoke-Expression $function.Extent.Text
      }
      $stages=@('sample-render','zoom-observe','recent-reopen-render','post-clear-sample-render')
      $commands=@($ast.FindAll({param($node)$node-is[Management.Automation.Language.CommandAst]-and$node.GetCommandName()-ceq'Wait-PersistenceUi'},$true)|Where-Object{
        $elements=$_.CommandElements
        $stageIndex=-1
        for($index=0;$index-lt$elements.Count;$index++){if($elements[$index]-is[Management.Automation.Language.CommandParameterAst]-and$elements[$index].ParameterName-ceq'Stage'){$stageIndex=$index;break}}
        $stageIndex-ge 0-and$stageIndex+1-lt$elements.Count-and$stages-contains[string]$elements[$stageIndex+1].Value
      })
      if($commands.Count-ne 4){throw 'The exact four affected persistence stages were not found.'}
      $expectedInvocations=@{
        'sample-render'='(Get-PersistenceSampleRenderScript)'
        'zoom-observe'='(Get-PersistenceZoomObserveScript -Expected $expected)'
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
      expect(scripts.sample).toBe(`const i=document.querySelector('img[alt="Page 1"]');return {tab:[...document.querySelectorAll('button')].some(x=>x.textContent.includes('welcome.pdf')),pages:[...document.querySelectorAll('span')].some(x=>x.textContent.trim()==='/ 6'),image:!!i&&i.complete&&i.naturalWidth>0&&i.src.startsWith('blob:')};`);
      expect(scripts.zoom125).toBe(`const z=document.querySelector('select[aria-label="Zoom"]');return z?.value==='125';`);
      expect(scripts.zoom150).toBe(`const z=document.querySelector('select[aria-label="Zoom"]');return z?.value==='150';`);
      expect(scripts.zoom175).toBe(`const z=document.querySelector('select[aria-label="Zoom"]');return z?.value==='175';`);
      expect(scripts.image).toBe(`const i=document.querySelector('img[alt="Page 1"]');return !!i&&i.complete&&i.naturalWidth>0&&i.src.startsWith('blob:');`);
      for (const value of Object.values(scripts)) expect(() => new Function(value)).not.toThrow();
    }
    expect(source.match(/-Script \(Get-PersistenceImageRenderScript\)/g)).toHaveLength(2);
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
    const check = String.raw`
      $tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${process.cwd().replaceAll("'", "''")}\scripts\installed-persistence.ps1',[ref]$tokens,[ref]$errors)
      $function=$ast.Find({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq'Assert-PersistenceOwnedExecutables'},$true)
      Invoke-Expression $function.Extent.Text
      $app='C:\Program Files\PDF Workstation\pdf-workstation.exe';$edge='C:\drivers\msedgedriver.exe'
      $valid=@([pscustomobject]@{Path=$app},[pscustomobject]@{Path=$edge},[pscustomobject]@{Path='C:\WebView\msedgewebview2.exe'})
      Assert-PersistenceOwnedExecutables $valid $app $edge
      foreach($bad in @(@($valid[0],$valid[1]),@($valid+[pscustomobject]@{Path='C:\Windows\notepad.exe'}),@($valid+$valid[0]))){
        $rejected=$false;try{Assert-PersistenceOwnedExecutables $bad $app $edge}catch{$rejected=$true};if(-not$rejected){throw 'Unsafe captured descendant set was accepted.'}
      }
    `;
    const result = runPowerShell(check);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(source).toContain("throw 'Persistence WebDriver captured an unexpected descendant executable.'");
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
    expect(source).toContain('[datetime]::UtcNow.AddMilliseconds($script:LaunchPins.TotalTimeoutMilliseconds)');
    expect(source).toContain('Invoke-SessionDeleteOutcome');
    expect(source).toContain('Stop-OwnedLaunchProcesses');
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
