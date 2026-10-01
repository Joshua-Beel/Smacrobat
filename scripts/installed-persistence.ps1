$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'installed-app-launch.ps1')

$script:PersistencePins = [ordered]@{
    Zoom = 175
    SampleName = 'welcome.pdf'
    SamplePages = 6
    Launches = 3
    LaunchTimeoutMilliseconds = 120000
    SessionCreationTimeoutMilliseconds = 60000
    PortHandoffTimeoutMilliseconds = 300000
    OwnedProcessMaximum = 128
    UnknownIdentityMaximum = 16
}

function Assert-PersistenceExactProperties {
    param($Value,[string[]]$Expected,[string]$Kind)
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $wanted = @($Expected | Sort-Object -CaseSensitive)
    if ($actual.Count -ne $wanted.Count -or (Compare-Object $wanted $actual -CaseSensitive)) {
        throw "$Kind has an unexpected or missing property."
    }
}

function Assert-PersistenceSentinel {
    param([string]$Path,[uint64]$Bytes,[string]$Sha256)
    Assert-NoReparseAncestors -Path $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'The exact persistence sentinel is missing.' }
    $item = Get-Item -LiteralPath $Path
    if ([uint64]$item.Length -ne $Bytes -or (Get-ExactSha256 -Path $Path) -cne $Sha256) {
        throw 'The exact persistence sentinel changed during installed application launches.'
    }
}

function Assert-PersistenceStorageScope {
    param([string]$ProfileRoot,[string]$SettingsRoot,[string]$SentinelPath,[string]$Binding)
    $profile = [IO.Path]::GetFullPath($ProfileRoot).TrimEnd('\')
    $settings = [IO.Path]::GetFullPath($SettingsRoot).TrimEnd('\')
    $sentinel = [IO.Path]::GetFullPath($SentinelPath)
    if ($profile.Equals($settings,[StringComparison]::OrdinalIgnoreCase) -or $profile.StartsWith($settings + '\',[StringComparison]::OrdinalIgnoreCase) -or
        $settings.StartsWith($profile + '\',[StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetDirectoryName($sentinel)).Equals($settings,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'The requested profile, application settings, and sentinel topology is not exclusive.'
    }
    Assert-NoReparseAncestors -Path $ProfileRoot
    Assert-NoReparseAncestors -Path $SettingsRoot
    $sentinelName = [IO.Path]::GetFileName($SentinelPath)
    $settingsEntries = @(Get-ChildItem -LiteralPath $SettingsRoot -Force)
    $profileEntries = @(Get-ChildItem -LiteralPath $ProfileRoot -Force)
    foreach ($entry in @($settingsEntries) + @($profileEntries)) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A persistence profile top-level entry is a reparse point.' }
    }
    $settingsWebView = Join-Path $SettingsRoot 'EBWebView'
    $requestedWebView = Join-Path $ProfileRoot 'EBWebView'
    if ($Binding -cnotmatch '^(session-capability|owned-webview)-(requested-profile|requested-ebwebview|tauri-app-settings-ebwebview)$') {
        throw 'The persistence launch used an unsupported profile binding.'
    }
    $bindingKind = $Binding -replace '^(session-capability|owned-webview)-',''
    $activeProfile = switch ($bindingKind) {
        'tauri-app-settings-ebwebview' {
            if ($settingsEntries.Count -ne 2 -or @($settingsEntries | Where-Object { $_.Name -ceq $sentinelName -and -not $_.PSIsContainer }).Count -ne 1 -or
                @($settingsEntries | Where-Object { $_.Name -ceq 'EBWebView' -and $_.PSIsContainer }).Count -ne 1 -or $profileEntries.Count -ne 0) {
                throw 'The bound Tauri settings profile has unexpected siblings or requested-profile writes.'
            }
            $settingsWebView
        }
        'requested-ebwebview' {
            if ($settingsEntries.Count -ne 1 -or @($settingsEntries | Where-Object { $_.Name -ceq $sentinelName -and -not $_.PSIsContainer }).Count -ne 1 -or
                $profileEntries.Count -ne 1 -or @($profileEntries | Where-Object { $_.Name -ceq 'EBWebView' -and $_.PSIsContainer }).Count -ne 1) {
                throw 'The bound requested child profile has unexpected siblings or settings-root writes.'
            }
            $requestedWebView
        }
        'requested-profile' {
            if ($settingsEntries.Count -ne 1 -or @($settingsEntries | Where-Object { $_.Name -ceq $sentinelName -and -not $_.PSIsContainer }).Count -ne 1 -or $profileEntries.Count -eq 0) {
                throw 'The bound requested profile is empty or the settings root gained an unrelated entry.'
            }
            $ProfileRoot
        }
    }
    Assert-NoReparseAncestors -Path $activeProfile
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push([IO.Path]::GetFullPath($activeProfile))
    $activeEntries = 0
    while ($pending.Count -gt 0) {
        foreach ($entry in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
            $activeEntries++
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The active persistence profile contains a reparse point.' }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
        }
    }
    if ($activeEntries -eq 0) { throw 'The bound persistence profile remained empty.' }
}

function Invoke-PersistenceUiScript {
    param([string]$SessionId,[string]$Script,[datetime]$Deadline,[string]$Stage)
    try {
        return Invoke-WebDriverScript -SessionId $SessionId -Script $Script -Deadline $Deadline
    } catch {
        $code = Get-BoundedWebDriverErrorCode -Exception $_.Exception
        throw "Installed persistence WebDriver stage failed: $Stage; w3cError=$code."
    }
}

function Wait-PersistenceUi {
    param([string]$SessionId,[string]$Script,[datetime]$Deadline,[scriptblock]$Predicate,[string]$Stage)
    do {
        $value = Invoke-PersistenceUiScript -SessionId $SessionId -Script $Script -Deadline $Deadline -Stage $Stage
        if (& $Predicate $value) { return $value }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $Deadline)
    throw "Installed persistence UI stage did not complete: $Stage."
}

function Get-PersistenceOwnedExecutableCounts {
    param([object[]]$Owned,[string]$ApplicationPath,[string]$EdgeDriverPath,[int]$RootProcessId = 0)
    $application = [IO.Path]::GetFullPath($ApplicationPath)
    $driver = [IO.Path]::GetFullPath($EdgeDriverPath)
    $items = @($Owned)
    if ($items.Count -gt $script:PersistencePins.OwnedProcessMaximum) { throw 'Persistence WebDriver captured an oversized descendant inventory.' }
    $counts = [ordered]@{
        applicationCount = 0; edgeDriverCount = 0; webViewCount = 0; unknownCount = 0; totalCount = [int]$items.Count
        missingPathCount = 0; unknownLeafNameSha256 = @()
        parentCategoryCounts = [pscustomobject][ordered]@{ applicationCount = 0; edgeDriverCount = 0; webViewCount = 0; rootCount = 0; unknownCount = 0; unavailableCount = 0 }
    }
    $metadata = [Collections.Generic.List[object]]::new()
    $categoriesByProcessId = @{}
    $unknownHashes = [Collections.Generic.List[string]]::new()
    foreach ($process in $items) {
        $path = ''; $leafName = ''; $category = 'unknown'
        $rawPath = [string]$process.Path
        if (-not [string]::IsNullOrWhiteSpace($rawPath)) { try { $path = [IO.Path]::GetFullPath($rawPath); $leafName = [IO.Path]::GetFileName($path) } catch { } }
        if ([string]::IsNullOrWhiteSpace($path) -or [string]::IsNullOrWhiteSpace($leafName)) { $counts.missingPathCount++ }
        elseif ($path.Equals($application,[StringComparison]::OrdinalIgnoreCase)) { $category = 'application'; $counts.applicationCount++ }
        elseif ($path.Equals($driver,[StringComparison]::OrdinalIgnoreCase)) { $category = 'edgeDriver'; $counts.edgeDriverCount++ }
        elseif ($leafName.Equals('msedgewebview2.exe',[StringComparison]::OrdinalIgnoreCase)) { $category = 'webView'; $counts.webViewCount++ }
        else {
            $hash = [Security.Cryptography.SHA256]::Create()
            try { $unknownHashes.Add(([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($leafName.ToLowerInvariant())))).Replace('-','')) } finally { $hash.Dispose() }
        }
        if ($category -ceq 'unknown') { $counts.unknownCount++ }
        $metadata.Add([pscustomobject]@{ Record = $process; Category = $category })
        $processIdProperty = $process.PSObject.Properties['ProcessId']
        $capturedProcessId = 0
        if ($null -ne $processIdProperty -and [int]::TryParse([string]$processIdProperty.Value,[ref]$capturedProcessId) -and $capturedProcessId -gt 0) {
            if ($categoriesByProcessId.ContainsKey($capturedProcessId)) { $categoriesByProcessId[$capturedProcessId] = 'unknown' } else { $categoriesByProcessId[$capturedProcessId] = $category }
        }
    }
    $uniqueHashes = @($unknownHashes | Sort-Object -CaseSensitive -Unique)
    if ($uniqueHashes.Count -gt $script:PersistencePins.UnknownIdentityMaximum) { throw 'Persistence WebDriver captured an oversized unknown executable identity inventory.' }
    $counts.unknownLeafNameSha256 = $uniqueHashes
    foreach ($item in $metadata) {
        if ([string]$item.Category -cne 'unknown') { continue }
        $parentProperty = $item.Record.PSObject.Properties['ParentProcessId']
        $parentProcessId = 0
        if ($null -eq $parentProperty -or -not [int]::TryParse([string]$parentProperty.Value,[ref]$parentProcessId) -or $parentProcessId -le 0) {
            $counts.parentCategoryCounts.unavailableCount++; continue
        }
        $parentCategory = if ($RootProcessId -gt 0 -and $parentProcessId -eq $RootProcessId) { 'root' }
            elseif ($categoriesByProcessId.ContainsKey($parentProcessId)) { [string]$categoriesByProcessId[$parentProcessId] }
            else { 'unknown' }
        switch ($parentCategory) {
            'application' { $counts.parentCategoryCounts.applicationCount++; break }
            'edgeDriver' { $counts.parentCategoryCounts.edgeDriverCount++; break }
            'webView' { $counts.parentCategoryCounts.webViewCount++; break }
            'root' { $counts.parentCategoryCounts.rootCount++; break }
            default { $counts.parentCategoryCounts.unknownCount++ }
        }
    }
    return [pscustomobject]$counts
}

function Assert-PersistenceOwnedExecutables {
    param(
        [object[]]$Owned,
        [string]$ApplicationPath,
        [string]$EdgeDriverPath,
        [int]$RootProcessId = 0,
        [string]$SystemDirectory,
        [scriptblock]$ConsoleHostSignatureProvider,
        [scriptblock]$ConsoleHostVersionInfoProvider
    )
    $counts = Get-PersistenceOwnedExecutableCounts -Owned $Owned -ApplicationPath $ApplicationPath -EdgeDriverPath $EdgeDriverPath -RootProcessId $RootProcessId
    $summary = $counts | ConvertTo-Json -Compress
    try {
        $trustedConsoleHostCount = Assert-TrustedConsoleHostTopology -Owned $Owned -RootProcessId $RootProcessId -SystemDirectory $SystemDirectory -SignatureProvider $ConsoleHostSignatureProvider -VersionInfoProvider $ConsoleHostVersionInfoProvider
    } catch {
        throw "Persistence WebDriver captured an untrusted console-host topology; ownedCounts=$summary."
    }
    if ([int]$counts.unknownCount -ne [int]$trustedConsoleHostCount) {
        throw "Persistence WebDriver captured an unexpected descendant executable; ownedCounts=$summary."
    }
    if ([int]$counts.applicationCount -ne 1 -or [int]$counts.edgeDriverCount -ne 1 -or [int]$counts.webViewCount -lt 1) {
        throw "Persistence WebDriver did not capture exactly one installed app, one trusted EdgeDriver, and at least one WebView2 process; ownedCounts=$summary."
    }
}

function Get-PersistenceDocumentStateScript {
    return @'
const z=document.querySelector('select[aria-label="Zoom"]'),o=z?[...z.options].filter(x=>x.value==='175'):[],s=document.querySelector('button[aria-label="Select text on page"]'),p=document.querySelector('button[aria-label="Pan document"]'),menu=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Menu');if(menu?.getAttribute('aria-expanded')==='false')menu.click();return {fit:z?.value||'',retainedZoom:o.length===1?Number(o[0].value):null,selectActive:!!s&&s.classList.length===2,panActive:!!p&&p.classList.length===2,toolsPanel:[...document.querySelectorAll('aside h2')].some(x=>x.textContent.trim()==='All tools'),pagesPanel:[...document.querySelectorAll('aside h2')].some(x=>x.textContent.trim()==='Pages'),dark:[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='Switch to light theme')};
'@
}

function Get-PersistenceRecentStateScript {
    return @'
const rows=[...document.querySelectorAll('button')].filter(x=>x.querySelector('small')?.textContent.trim()==='PDF document'&&x.querySelector('span')?.childNodes[0]?.textContent.trim()==='welcome.pdf'),row=rows.length===1?rows[0].parentElement:null,pageText=row?.children[2]?.textContent.trim()||'',star=[...document.querySelectorAll('button')].filter(x=>x.getAttribute('aria-label')==='Unstar welcome.pdf'),clear=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Clear file history');return {rows:rows.length,pages:/^\d+$/.test(pageText)?Number(pageText):0,starred:star.length===1,clearEnabled:clear.length===1&&!clear[0].disabled};
'@
}

function Get-PersistenceSampleRenderScript {
    $script = @'
const i=document.querySelector('img[alt="Page 1"]');return {tab:[...document.querySelectorAll('button')].some(x=>x.textContent.includes('welcome.pdf')),pages:[...document.querySelectorAll('span')].some(x=>x.textContent.trim()==='/ 6'),image:!!i&&i.complete&&i.naturalWidth>0&&i.src.startsWith('blob:')};
'@
    return $script.Trim()
}

function Get-PersistenceHomeScript {
    return @'
return {ready:document.readyState==='complete',title:document.title,sample:[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Explore a sample PDF'&&!x.disabled).length};
'@
}

function Get-PersistenceZoomObserveScript {
    param([ValidateSet(125,150,175)][int]$Expected)
    $script = @'
const z=document.querySelector('select[aria-label="Zoom"]');return z?.value==='__EXPECTED_ZOOM__';
'@
    return $script.Trim().Replace('__EXPECTED_ZOOM__',[string]$Expected)
}

function Get-PersistenceImageRenderScript {
    $script = @'
const i=document.querySelector('img[alt="Page 1"]');return !!i&&i.complete&&i.naturalWidth>0&&i.src.startsWith('blob:');
'@
    return $script.Trim()
}

function Invoke-PersistenceUiFlow {
    param([string]$SessionId,[datetime]$Deadline,[ValidateSet('write','verify-and-clear','verify-cleared')][string]$Mode)
    if ($Mode -ceq 'verify-and-clear') {
        $recent = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'recent-restart-observe' -Script (Get-PersistenceRecentStateScript) -Predicate { param($v) [int]$v.rows -eq 1 -and [int]$v.pages -eq $script:PersistencePins.SamplePages -and [bool]$v.starred -and [bool]$v.clearEnabled }
    } else {
        $homeOracle = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'home-ready' -Script (Get-PersistenceHomeScript) -Predicate { param($v) [bool]$v.ready -and [string]$v.title -ceq 'PDF Workstation' -and [int]$v.sample -eq 1 }
    }
    if ($Mode -ceq 'write') {
        $clicked = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'sample-open' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Explore a sample PDF');if(b.length===1)b[0].click();return b.length===1;"
        if ($clicked -isnot [bool] -or -not $clicked) { throw 'The exact installed sample UI control was unavailable.' }
        $null = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'sample-render' -Script (Get-PersistenceSampleRenderScript) -Predicate { param($v) [bool]$v.tab -and [bool]$v.pages -and [bool]$v.image }
        foreach ($expected in @(125,150,175)) {
            $zoomed = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'zoom-change' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.getAttribute('aria-label')==='Zoom in');if(b.length===1)b[0].click();return b.length===1;"
            if ($zoomed -isnot [bool] -or -not $zoomed) { throw 'The exact Zoom in UI control was unavailable.' }
            $null = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'zoom-observe' -Script (Get-PersistenceZoomObserveScript -Expected $expected) -Predicate { param($v) $v -is [bool] -and $v }
        }
        $changed = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'preference-controls' -Script "const labels=['Fit page','Select text on page','Collapse all tools','Pages','Toggle theme'],buttons=labels.map(a=>[...document.querySelectorAll('button')].filter(x=>x.getAttribute('aria-label')===a));if(buttons.some(x=>x.length!==1))return false;for(const b of buttons)b[0].click();return true;"
        if ($changed -isnot [bool] -or -not $changed) { throw 'One or more exact reading preference UI controls were unavailable.' }
        $documentState = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'preference-write-observe' -Script (Get-PersistenceDocumentStateScript) -Predicate { param($v) [string]$v.fit -ceq 'page' -and [int]$v.retainedZoom -eq $script:PersistencePins.Zoom -and [bool]$v.selectActive -and -not [bool]$v.panActive -and -not [bool]$v.toolsPanel -and [bool]$v.pagesPanel -and [bool]$v.dark }
        $homeClick = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'home-return' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.getAttribute('aria-label')==='Home');if(b.length===1)b[0].click();return b.length===1;"
        if ($homeClick -isnot [bool] -or -not $homeClick) { throw 'The exact Home UI control was unavailable.' }
        $null = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'recent-write-ready' -Script (Get-PersistenceRecentStateScript) -Predicate { param($v) [int]$v.rows -eq 1 -and [int]$v.pages -eq $script:PersistencePins.SamplePages -and -not [bool]$v.starred -and [bool]$v.clearEnabled }
        $starred = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'star-write' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.getAttribute('aria-label')==='Star welcome.pdf');if(b.length===1)b[0].click();return b.length===1;"
        if ($starred -isnot [bool] -or -not $starred) { throw 'The exact sample star UI control was unavailable.' }
        $recent = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'star-write-observe' -Script (Get-PersistenceRecentStateScript) -Predicate { param($v) [int]$v.rows -eq 1 -and [int]$v.pages -eq $script:PersistencePins.SamplePages -and [bool]$v.starred -and [bool]$v.clearEnabled }
        return [pscustomobject]@{ preferences = $documentState; recentPresent = $true; starred = $true; clearPersisted = $false }
    }

    if ($Mode -ceq 'verify-and-clear') {
        $starredSection = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'starred-section' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Starred');if(b.length===1)b[0].click();return b.length===1;"
        if ($starredSection -isnot [bool] -or -not $starredSection) { throw 'The exact Starred UI control was unavailable.' }
        $null = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'starred-section-observe' -Script (Get-PersistenceRecentStateScript) -Predicate { param($v) [int]$v.rows -eq 1 -and [int]$v.pages -eq $script:PersistencePins.SamplePages -and [bool]$v.starred }
        $opened = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'recent-reopen' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.querySelector('small')?.textContent.trim()==='PDF document'&&x.querySelector('span')?.childNodes[0]?.textContent.trim()==='welcome.pdf');if(b.length===1)b[0].click();return b.length===1;"
        if ($opened -isnot [bool] -or -not $opened) { throw 'The exact recent sample UI row was unavailable.' }
        $null = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'recent-reopen-render' -Script (Get-PersistenceImageRenderScript) -Predicate { param($v) $v -is [bool] -and $v }
        $documentState = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'preference-restart-observe' -Script (Get-PersistenceDocumentStateScript) -Predicate { param($v) [string]$v.fit -ceq 'page' -and [int]$v.retainedZoom -eq $script:PersistencePins.Zoom -and [bool]$v.selectActive -and -not [bool]$v.panActive -and -not [bool]$v.toolsPanel -and [bool]$v.pagesPanel -and [bool]$v.dark }
        $homeClick = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'clear-home-return' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.getAttribute('aria-label')==='Home');if(b.length===1)b[0].click();return b.length===1;"
        if ($homeClick -isnot [bool] -or -not $homeClick) { throw 'The exact Home UI control was unavailable before clearing history.' }
        $recentSection = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'recent-section' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Recent');if(b.length===1)b[0].click();return b.length===1;"
        if ($recentSection -isnot [bool] -or -not $recentSection) { throw 'The exact Recent UI control was unavailable.' }
        $cleared = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'clear-history' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Clear file history'&&!x.disabled);if(b.length===1)b[0].click();return b.length===1;"
        if ($cleared -isnot [bool] -or -not $cleared) { throw 'The exact Clear file history UI control was unavailable.' }
        $null = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'clear-history-observe' -Script (Get-PersistenceRecentStateScript) -Predicate { param($v) [int]$v.rows -eq 0 -and [int]$v.pages -eq 0 -and -not [bool]$v.starred -and -not [bool]$v.clearEnabled }
        return [pscustomobject]@{ preferences = $documentState; recentPresent = $true; starred = $true; clearPersisted = $false }
    }

    $clearedState = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'clear-restart-observe' -Script (Get-PersistenceRecentStateScript) -Predicate { param($v) [int]$v.rows -eq 0 -and [int]$v.pages -eq 0 -and -not [bool]$v.starred -and -not [bool]$v.clearEnabled }
    $clicked = Invoke-PersistenceUiScript -SessionId $SessionId -Deadline $Deadline -Stage 'post-clear-sample-open' -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Explore a sample PDF');if(b.length===1)b[0].click();return b.length===1;"
    if ($clicked -isnot [bool] -or -not $clicked) { throw 'The exact installed sample UI control was unavailable after the clear-history restart.' }
    $null = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'post-clear-sample-render' -Script (Get-PersistenceImageRenderScript) -Predicate { param($v) $v -is [bool] -and $v }
    $documentState = Wait-PersistenceUi -SessionId $SessionId -Deadline $Deadline -Stage 'post-clear-preference-observe' -Script (Get-PersistenceDocumentStateScript) -Predicate { param($v) [string]$v.fit -ceq 'page' -and [int]$v.retainedZoom -eq $script:PersistencePins.Zoom -and [bool]$v.selectActive -and -not [bool]$v.panActive -and -not [bool]$v.toolsPanel -and [bool]$v.pagesPanel -and [bool]$v.dark }
    return [pscustomobject]@{ preferences = $documentState; recentPresent = $false; starred = $false; clearPersisted = $true }
}

function Invoke-RealPersistenceLaunch {
    param([string]$ApplicationPath,[string]$TauriDriverPath,[string]$EdgeDriverPath,[string]$ProfileRoot,[string]$SettingsRoot,[string]$ExpectedEdgeDriverVersion,[string]$ExpectedRuntimeVersion,[ValidateSet('write','verify-and-clear','verify-cleared')][string]$Mode)
    $script:LaunchPins.SessionCreationTimeoutMilliseconds = $script:PersistencePins.SessionCreationTimeoutMilliseconds
    $driverCapture = $null; $driver = $null; $sessionId = $null; $captured = @(); $result = $null; $status = $null
    $sessionDeleteOutcome = 'requestfailed'; $driverExited = $false
    $driverStopOutcome = 'not-invoked'; $processesQuiescent = $false; $residualCategory = 'multiple'; $remaining = -1
    $capturedOutcomes = [pscustomobject]@{ application = 'absent'; tauriDriver = 'absent'; edgeDriver = 'absent'; webview = 'absent'; ocrEngine = 'absent'; other = 'absent' }
    $residualFacts = [pscustomobject]@{ ownership = 'none'; application = $false; tauriDriver = $false; edgeDriver = $false; webview = $false; ocrEngine = $false; other = $false }
    try {
        $handoffDeadline = [datetime]::UtcNow.AddMilliseconds($script:PersistencePins.PortHandoffTimeoutMilliseconds)
        $null = Wait-FixedWebDriverPortsFree -Deadline $handoffDeadline
        $deadline = [datetime]::UtcNow.AddMilliseconds($script:PersistencePins.LaunchTimeoutMilliseconds)
        $startedAfter = [datetime]::UtcNow
        $driverCapture = Start-BoundedDiscardProcess -Path $TauriDriverPath -Arguments @("--port=$($script:LaunchPins.WebDriverPort)","--native-port=$($script:LaunchPins.NativeDriverPort)","--native-driver=$EdgeDriverPath")
        $driverCapture.Start(); $driver = $driverCapture.Process
        do {
            try { $status = Invoke-BoundedLoopbackJson -Method GET -Path '/status' -Deadline $deadline; if ([bool]$status.value.ready) { break } } catch { }
            if ($driver.HasExited) { throw 'Pinned tauri-driver exited before persistence readiness.' }
            Start-Sleep -Milliseconds 200
        } while ([datetime]::UtcNow -lt $deadline)
        if ($null -eq $status -or -not [bool]$status.value.ready) { throw 'Pinned tauri-driver did not become ready for persistence verification.' }
        $nativeDriverVersion = Wait-NativeDriverStatus -ExpectedVersion $ExpectedEdgeDriverVersion -Deadline $deadline -TauriDriver $driver
        $sessionBody = [ordered]@{ capabilities = [ordered]@{ alwaysMatch = [ordered]@{ browserName = 'wry'; 'tauri:options' = [ordered]@{ application = $ApplicationPath; args = @(); webviewOptions = [ordered]@{ userDataFolder = $ProfileRoot } } } } }
        $session = Invoke-BoundedLoopbackJson -Method POST -Path '/session' -Body $sessionBody -Deadline $deadline
        if ($null -eq $session.value -or [string]$session.value.sessionId -cnotmatch '^[A-Za-z0-9-]+$') { throw 'Persistence WebDriver did not return a bounded session identifier.' }
        $sessionId = [string]$session.value.sessionId
        $capabilities = $session.value.capabilities
        $capabilityKeys = @($capabilities.PSObject.Properties.Name | Sort-Object -CaseSensitive)
        if ($capabilityKeys.Count -eq 0 -or $capabilityKeys.Count -gt 32 -or @($capabilityKeys | Where-Object { $_ -cnotmatch '^[A-Za-z0-9:._-]{1,64}$' }).Count -ne 0) {
            throw 'Persistence WebDriver returned an unsafe capability-key set.'
        }
        $vendorDriverProperty = $capabilities.PSObject.Properties['msedge.msedgedriverVersion']
        if ($null -ne $vendorDriverProperty -and ([string]$vendorDriverProperty.Value -split '\s+')[0] -cne $ExpectedEdgeDriverVersion) {
            throw 'The persistence session EdgeDriver capability disagrees with its trusted receipt.'
        }
        $returnedRuntimeVersion = [string]$capabilities.browserVersion
        $returnedRuntimeParts = $returnedRuntimeVersion.Split('.')
        $expectedRuntimeParts = $ExpectedRuntimeVersion.Split('.')
        if ($returnedRuntimeVersion -cnotmatch '^\d+\.\d+\.\d+\.\d+$' -or $returnedRuntimeParts.Count -ne 4 -or
            ($returnedRuntimeParts[0..2] -join '.') -cne ($expectedRuntimeParts[0..2] -join '.')) {
            throw 'The persistence session WebView2 runtime capability disagrees with its trusted receipt.'
        }
        $returnedUserData = if ($null -ne $capabilities.PSObject.Properties['msedge.userDataDir']) { [string]$capabilities.'msedge.userDataDir' } else { '' }
        $flow = Invoke-PersistenceUiFlow -SessionId $sessionId -Deadline $deadline -Mode $Mode
        $captured += @(Get-OwnedLaunchProcesses -RootProcessId $driver.Id -StartedAfter $startedAfter)
        $captured = @(Get-UniqueOwnedLaunchProcesses -Processes $captured)
        Assert-PersistenceOwnedExecutables -Owned $captured -ApplicationPath $ApplicationPath -EdgeDriverPath $EdgeDriverPath -RootProcessId $driver.Id
        $binding = if ($returnedUserData) { 'session-capability-' + (Get-ExactProfileBinding -Candidate $returnedUserData -RequestedProfile $ProfileRoot -SettingsRoot $SettingsRoot) } else { Get-OwnedProfileBinding -Owned $captured -RequestedProfile $ProfileRoot -SettingsRoot $SettingsRoot }
        if ($driverCapture.Exceeded) { throw 'Persistence WebDriver diagnostic output exceeded its discarded character cap.' }
        $result = [pscustomobject]@{ mode = $Mode; nativeDriverVersion = $nativeDriverVersion; returnedRuntimeVersion = $returnedRuntimeVersion; profileBinding = $binding; preferences = $flow.preferences; recentPresent = [bool]$flow.recentPresent; starred = [bool]$flow.starred; clearPersisted = [bool]$flow.clearPersisted }
    } finally {
        $cleanupDeadline = [datetime]::UtcNow.AddSeconds(10)
        if ($sessionId) { $sessionDeleteOutcome = Invoke-SessionDeleteOutcome -SessionId $sessionId -Deadline $cleanupDeadline }
        if ($driver) {
            try { $captured += @(Get-OwnedLaunchProcesses -RootProcessId $driver.Id -StartedAfter $startedAfter); $captured = @(Get-UniqueOwnedLaunchProcesses -Processes $captured) } catch { }
            $processCleanupDeadline = [datetime]::UtcNow.AddMilliseconds($script:LaunchPins.CleanupProcessTimeoutMilliseconds)
            $capturedOutcomes = Stop-OwnedLaunchProcesses -TauriDriver $driver -Captured $captured -Deadline $processCleanupDeadline
            $driverStopOutcome = [string]$capturedOutcomes.rootOutcome
            $quiescence = Wait-LaunchProcessQuiescence -Deadline $processCleanupDeadline
            $processesQuiescent = [bool]$quiescence.stable
            $remainingProcesses = @($quiescence.processes); $remaining = $remainingProcesses.Count
            $residualCategory = Get-LaunchResidualCategory -Processes $remainingProcesses
            $residualFacts = Get-LaunchResidualFacts -Processes $remainingProcesses -Captured $captured
            $driverExited = [bool]$driver.HasExited
        }
        if ($driverCapture) { $driverCapture.Dispose() }
    }
    Assert-LaunchCleanupState -Result $result -SessionDeleteOutcome $sessionDeleteOutcome -DriverExited $driverExited -RelevantProcessesClear ($processesQuiescent -and $residualCategory -ceq 'none') -DriverStopOutcome $driverStopOutcome -ResidualCategory $residualCategory -CapturedApplication $capturedOutcomes.application -CapturedTauriDriver $capturedOutcomes.tauriDriver -CapturedEdgeDriver $capturedOutcomes.edgeDriver -CapturedWebView $capturedOutcomes.webview -CapturedOcrEngine $capturedOutcomes.ocrEngine -CapturedOther $capturedOutcomes.other -ResidualOwnership $residualFacts.ownership -ResidualApplication $residualFacts.application -ResidualTauriDriver $residualFacts.tauriDriver -ResidualEdgeDriver $residualFacts.edgeDriver -ResidualWebView $residualFacts.webview -ResidualOcrEngine $residualFacts.ocrEngine -ResidualOther $residualFacts.other
    if ($sessionDeleteOutcome -cne 'verified' -or -not $driverExited -or -not $processesQuiescent -or $remaining -ne 0) { throw 'Persistence launch cleanup was incomplete.' }
    $result | Add-Member -NotePropertyName sessionDeleted -NotePropertyValue $true
    $result | Add-Member -NotePropertyName ownedProcessTreeStopped -NotePropertyValue $true
    $result | Add-Member -NotePropertyName relevantProcessesRemaining -NotePropertyValue 0
    return $result
}

function Assert-PersistenceLaunchResult {
    param($Result,[string]$Mode,[string]$ExpectedEdgeDriverVersion,[string]$ExpectedRuntimeVersion)
    Assert-PersistenceExactProperties -Value $Result -Expected @('mode','nativeDriverVersion','returnedRuntimeVersion','profileBinding','preferences','recentPresent','starred','clearPersisted','sessionDeleted','ownedProcessTreeStopped','relevantProcessesRemaining') -Kind 'Persistence launch result'
    Assert-PersistenceExactProperties -Value $Result.preferences -Expected @('fit','retainedZoom','selectActive','panActive','toolsPanel','pagesPanel','dark') -Kind 'Persistence preference result'
    $returnedRuntimeParts = ([string]$Result.returnedRuntimeVersion).Split('.')
    $expectedRuntimeParts = $ExpectedRuntimeVersion.Split('.')
    if ([string]$Result.mode -cne $Mode -or [string]$Result.nativeDriverVersion -cne $ExpectedEdgeDriverVersion -or
        [string]$Result.returnedRuntimeVersion -cnotmatch '^\d+\.\d+\.\d+\.\d+$' -or $returnedRuntimeParts.Count -ne 4 -or ($returnedRuntimeParts[0..2] -join '.') -cne ($expectedRuntimeParts[0..2] -join '.') -or
        [string]$Result.profileBinding -cnotmatch '^(session-capability|owned-webview)-(requested-profile|requested-ebwebview|tauri-app-settings-ebwebview)$' -or
        [string]$Result.preferences.fit -cne 'page' -or [int]$Result.preferences.retainedZoom -ne $script:PersistencePins.Zoom -or -not [bool]$Result.preferences.selectActive -or [bool]$Result.preferences.panActive -or [bool]$Result.preferences.toolsPanel -or -not [bool]$Result.preferences.pagesPanel -or -not [bool]$Result.preferences.dark -or
        $Result.sessionDeleted -isnot [bool] -or -not $Result.sessionDeleted -or $Result.ownedProcessTreeStopped -isnot [bool] -or -not $Result.ownedProcessTreeStopped -or [int]$Result.relevantProcessesRemaining -ne 0) {
        throw 'Persistence launch did not prove the exact UI state and cleanup contract.'
    }
    if ($Mode -ceq 'write' -or $Mode -ceq 'verify-and-clear') {
        if (-not [bool]$Result.recentPresent -or -not [bool]$Result.starred -or [bool]$Result.clearPersisted) { throw 'Recent-file or star state did not match the expected launch phase.' }
    } elseif ([bool]$Result.recentPresent -or [bool]$Result.starred -or -not [bool]$Result.clearPersisted) {
        throw 'Clear file history did not persist across the final restart.'
    }
}

function Invoke-InstalledPersistenceVerification {
    param([string]$ApplicationPath,[string]$WebDriverRoot,[string]$ProfileRoot,[string]$SettingsRoot,[string]$SentinelPath,[uint64]$SentinelBytes,[string]$SentinelSha256,[string]$ExpectedEdgeDriverVersion,[string]$ExpectedRuntimeVersion,[scriptblock]$LaunchProvider)
    $tauriDriver = Join-Path $WebDriverRoot 'tauri-driver-install/bin/tauri-driver.exe'
    $edgeDriver = Join-Path $WebDriverRoot 'edge-driver/msedgedriver.exe'
    foreach ($path in @($ApplicationPath,$tauriDriver,$edgeDriver,$SentinelPath)) { Assert-NoReparseAncestors -Path $path; if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A required persistence input is missing.' } }
    if ($ExpectedEdgeDriverVersion -cnotmatch '^\d+\.\d+\.\d+\.\d+$' -or $ExpectedRuntimeVersion -cnotmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'An expected WebDriver or WebView2 runtime version is invalid.' }
    Assert-PersistenceSentinel -Path $SentinelPath -Bytes $SentinelBytes -Sha256 $SentinelSha256
    $results = [Collections.Generic.List[object]]::new()
    foreach ($mode in @('write','verify-and-clear','verify-cleared')) {
        $launch = if ($LaunchProvider) { & $LaunchProvider $mode $ApplicationPath $tauriDriver $edgeDriver $ProfileRoot $SettingsRoot $ExpectedEdgeDriverVersion $ExpectedRuntimeVersion } else { Invoke-RealPersistenceLaunch -ApplicationPath $ApplicationPath -TauriDriverPath $tauriDriver -EdgeDriverPath $edgeDriver -ProfileRoot $ProfileRoot -SettingsRoot $SettingsRoot -ExpectedEdgeDriverVersion $ExpectedEdgeDriverVersion -ExpectedRuntimeVersion $ExpectedRuntimeVersion -Mode $mode }
        Assert-PersistenceLaunchResult -Result $launch -Mode $mode -ExpectedEdgeDriverVersion $ExpectedEdgeDriverVersion -ExpectedRuntimeVersion $ExpectedRuntimeVersion
        Assert-PersistenceSentinel -Path $SentinelPath -Bytes $SentinelBytes -Sha256 $SentinelSha256
        Assert-PersistenceStorageScope -ProfileRoot $ProfileRoot -SettingsRoot $SettingsRoot -SentinelPath $SentinelPath -Binding ([string]$launch.profileBinding)
        $results.Add($launch)
    }
    if ([string]$results[0].profileBinding -cne [string]$results[1].profileBinding -or [string]$results[1].profileBinding -cne [string]$results[2].profileBinding) {
        throw 'Installed application restarts did not reuse the same controlled profile binding.'
    }
    return [ordered]@{
        launches = $script:PersistencePins.Launches
        profileBinding = [string]$results[0].profileBinding
        preferences = [ordered]@{ theme = 'dark'; zoom = $script:PersistencePins.Zoom; fitMode = 'page'; panMode = $false; allToolsPanelVisible = $false; pagesPanelVisible = $true }
        recentFiles = [ordered]@{ sampleName = $script:PersistencePins.SampleName; pages = $script:PersistencePins.SamplePages; presentAfterRestart = $true; starredAfterRestart = $true; clearHistoryPersisted = $true }
        preferencesPreservedAfterClear = $true
        cleanup = [ordered]@{ sessionsDeleted = 3; ownedProcessTreesStopped = 3; relevantProcessesRemaining = 0 }
        sentinelPreserved = $true
        unrelatedSettingsEntries = 0
        excludedScope = @('Bookmarks','Comments','Find')
    }
}
