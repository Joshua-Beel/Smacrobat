[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'ocr/installer-package.ps1')
. (Join-Path $PSScriptRoot 'ocr/windows-signing.ps1')
. (Join-Path $PSScriptRoot 'installed-app-launch.ps1')

$script:ReadingPins = [ordered]@{
    TotalTimeoutMilliseconds = 180000
    PortReleaseTimeoutMilliseconds = 180000
    PortReleasePollMilliseconds = 250
    UiAutomationPollMilliseconds = 100
    ClipboardPollMilliseconds = 100
    RequestBytesMaximum = 1MB
    SelectionText = 'A place for your PDFs.'
    SearchText = 'Sample document'
    Password = 'test password'
}

function Wait-ReadingWebDriverPortsFree {
    param([Parameter(Mandatory = $true)][datetime]$Deadline,[scriptblock]$Probe)
    while ([datetime]::UtcNow -lt $Deadline) {
        try {
            if ($Probe) { & $Probe } else { Assert-FixedWebDriverPortsFree }
            if ([datetime]::UtcNow -lt $Deadline) { return }
            break
        } catch { }
        Start-Sleep -Milliseconds $script:ReadingPins.PortReleasePollMilliseconds
    }
    throw 'The prior installed-app proof did not release the fixed WebDriver ports before the bounded reading-tools handoff.'
}

function Assert-ReadingFileReceipt {
    param([Parameter(Mandatory = $true)][string]$Path,[Parameter(Mandatory = $true)][uint64]$Bytes,[Parameter(Mandatory = $true)][string]$Sha256,[Parameter(Mandatory = $true)][string]$Kind)
    Assert-NoReparseAncestors -Path $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Kind is missing." }
    $item = Get-Item -LiteralPath $Path -Force
    if ([uint64]$item.Length -ne $Bytes -or (Get-ExactSha256 -Path $Path) -cne $Sha256) { throw "$Kind does not match its exact receipt." }
}

function Get-ReadingSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','') } finally { $sha.Dispose() }
}

function Get-ReadingTextReceipt {
    param([Parameter(Mandatory = $true)][string]$Text)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    return [pscustomobject]@{ utf8Bytes = [int]$bytes.Length; sha256 = Get-ReadingSha256 -Bytes $bytes }
}

function Invoke-ReadingWebDriverActions {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][object[]]$Actions,
        [Parameter(Mandatory = $true)][datetime]$Deadline
    )
    if ($SessionId -cnotmatch '^[A-Za-z0-9-]+$' -or $Actions.Count -lt 1 -or $Actions.Count -gt 4) {
        throw 'WebDriver input actions are outside the exact reading-tools contract.'
    }
    $path = "/session/$SessionId/actions"
    $uri = [Uri]::new("http://127.0.0.1:$($script:LaunchPins.WebDriverPort)$path")
    if (-not $uri.IsLoopback -or $uri.Scheme -cne 'http') { throw 'Reading-tools WebDriver actions are not fixed loopback HTTP.' }
    $timeout = Get-LaunchRemainingMilliseconds -Deadline $Deadline -MaximumMilliseconds $script:LaunchPins.RequestTimeoutMilliseconds
    $request = [Net.HttpWebRequest]::CreateHttp($uri)
    $request.Method = 'POST'; $request.AllowAutoRedirect = $false; $request.Proxy = $null
    $request.Timeout = $timeout; $request.ReadWriteTimeout = $timeout
    $request.ContentType = 'application/json; charset=utf-8'
    $body = [ordered]@{ actions = $Actions }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($body | ConvertTo-Json -Depth 12 -Compress))
    if ($bytes.Length -gt $script:ReadingPins.RequestBytesMaximum) { throw 'Reading-tools WebDriver actions exceeded the request limit.' }
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    $response = $null
    try {
        $response = [Net.HttpWebResponse]$request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { throw 'Reading-tools WebDriver actions returned an unexpected status.' }
        $responseStream = $response.GetResponseStream(); $memory = [IO.MemoryStream]::new()
        try {
            $buffer = [byte[]]::new(4096)
            while (($read = $responseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if ($memory.Length + $read -gt $script:ReadingPins.RequestBytesMaximum) { throw 'Reading-tools WebDriver actions exceeded the response limit.' }
                $memory.Write($buffer, 0, $read)
            }
            $text = [Text.UTF8Encoding]::new($false, $true).GetString($memory.ToArray())
        } finally { $memory.Dispose(); $responseStream.Dispose() }
    } finally { if ($response) { $response.Dispose() } }
    if ([string]::IsNullOrWhiteSpace($text)) { throw 'Reading-tools WebDriver actions returned no JSON.' }
    $json = $text | ConvertFrom-Json
    $nodes = 0; Assert-BoundedJsonShape -Value $json -Nodes ([ref]$nodes)
    if ($json.PSObject.Properties['value'] -eq $null) { throw 'Reading-tools WebDriver actions returned no value member.' }
}

function Send-ReadingKeyChord {
    param([Parameter(Mandatory = $true)][string]$SessionId,[Parameter(Mandatory = $true)][ValidateSet('c','f')][string]$Key,[Parameter(Mandatory = $true)][datetime]$Deadline)
    $control = [string][char]0xE009
    Invoke-ReadingWebDriverActions -SessionId $SessionId -Deadline $Deadline -Actions @(
        [ordered]@{ type = 'key'; id = 'reading-keyboard'; actions = @(
            [ordered]@{ type = 'keyDown'; value = $control },
            [ordered]@{ type = 'keyDown'; value = $Key },
            [ordered]@{ type = 'keyUp'; value = $Key },
            [ordered]@{ type = 'keyUp'; value = $control }
        ) }
    )
}

function Invoke-ReadingClipboardSta {
    param([ValidateSet('set-sentinel','clear','receipt')][string]$Operation)
    $runspace = [RunspaceFactory]::CreateRunspace()
    $runspace.ApartmentState = [Threading.ApartmentState]::STA
    $runspace.ThreadOptions = [Management.Automation.Runspaces.PSThreadOptions]::UseNewThread
    $runspace.Open()
    $powerShell = [PowerShell]::Create(); $powerShell.Runspace = $runspace
    try {
        if ($Operation -ceq 'set-sentinel') {
            $null = $powerShell.AddScript("Add-Type -AssemblyName System.Windows.Forms;[Windows.Forms.Clipboard]::SetText('reading-verifier-sentinel')")
            $null = $powerShell.Invoke()
            if ($powerShell.HadErrors) { throw 'The Windows clipboard sentinel could not be set.' }
            return
        }
        if ($Operation -ceq 'clear') {
            $null = $powerShell.AddScript('Add-Type -AssemblyName System.Windows.Forms;[Windows.Forms.Clipboard]::Clear()')
            $null = $powerShell.Invoke()
            if ($powerShell.HadErrors) { throw 'The Windows clipboard could not be cleared.' }
            return
        }
        $source = @'
Add-Type -AssemblyName System.Windows.Forms
$text=[Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
$bytes=[Text.UTF8Encoding]::new($false).GetBytes($text)
$sha=[Security.Cryptography.SHA256]::Create()
try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','')}finally{$sha.Dispose()}
[pscustomobject]@{utf8Bytes=[int]$bytes.Length;sha256=$hash}
'@
        $null = $powerShell.AddScript($source)
        $values = @($powerShell.Invoke())
        if ($powerShell.HadErrors -or $values.Count -ne 1 -or [string]$values[0].sha256 -cnotmatch '^[A-F0-9]{64}$') {
            throw 'The Windows clipboard receipt was unavailable.'
        }
        return $values[0]
    } finally { $powerShell.Dispose(); $runspace.Dispose() }
}

function Wait-ReadingClipboardReceipt {
    param([Parameter(Mandatory = $true)]$Expected,[Parameter(Mandatory = $true)][datetime]$Deadline)
    do {
        try {
            $receipt = Invoke-ReadingClipboardSta -Operation receipt
            if ([int]$receipt.utf8Bytes -eq [int]$Expected.utf8Bytes -and [string]$receipt.sha256 -ceq [string]$Expected.sha256) { return $receipt }
        } catch { }
        Start-Sleep -Milliseconds $script:ReadingPins.ClipboardPollMilliseconds
    } while ([datetime]::UtcNow -lt $Deadline)
    throw 'The Windows clipboard did not receive the exact selected embedded text.'
}

function Get-ReadingAutomationElements {
    param([Parameter(Mandatory = $true)]$Root,[Parameter(Mandatory = $true)]$Condition,[ValidateRange(1,512)][int]$MaximumCount = 256)
    $collection = $Root.FindAll([Windows.Automation.TreeScope]::Descendants, $Condition)
    if ($collection.Count -gt $MaximumCount) { throw 'Process-bound UI Automation exceeded its element-count cap.' }
    $values = @()
    for ($index = 0; $index -lt $collection.Count; $index++) { $values += $collection.Item($index) }
    return $values
}

function Wait-ProcessBoundOpenDialog {
    param([Parameter(Mandatory = $true)][int]$ApplicationProcessId,[Parameter(Mandatory = $true)][datetime]$Deadline)
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $processCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $ApplicationProcessId)
    $windowCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Window)
    $condition = [Windows.Automation.AndCondition]::new($processCondition,$windowCondition)
    do {
        $collection = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition)
        if ($collection.Count -gt 8) { throw 'The application exposed too many process-bound top-level windows.' }
        $topLevelWindows = @()
        for ($index = 0; $index -lt $collection.Count; $index++) { $topLevelWindows += $collection.Item($index) }
        $windows = @($topLevelWindows | Where-Object {
            $_.Current.ProcessId -eq $ApplicationProcessId -and $_.Current.ClassName -ceq '#32770' -and
            $_.Current.Name -ceq 'Open' -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen
        })
        if ($windows.Count -eq 1) { return $windows[0] }
        if ($windows.Count -gt 1) { throw 'More than one process-bound native Open dialog was visible.' }
        Start-Sleep -Milliseconds $script:ReadingPins.UiAutomationPollMilliseconds
    } while ([datetime]::UtcNow -lt $Deadline)
    throw 'The exact process-bound native Open dialog did not appear.'
}

function Assert-ReadingAutomationChildProcessId {
    param([Parameter(Mandatory = $true)][object[]]$Elements,[Parameter(Mandatory = $true)][int]$ApplicationProcessId,[Parameter(Mandatory = $true)][string]$Kind)
    if (@($Elements | Where-Object { $_.Current.ProcessId -ne $ApplicationProcessId }).Count -ne 0) {
        throw "A process-bound native Open dialog $Kind child has a mismatched process identifier."
    }
}

function Submit-ProcessBoundOpenDialog {
    param([Parameter(Mandatory = $true)]$Dialog,[Parameter(Mandatory = $true)][int]$ApplicationProcessId,[Parameter(Mandatory = $true)][string]$Path)
    if ($Dialog.Current.ProcessId -ne $ApplicationProcessId) { throw 'The native Open dialog does not belong to the exact installed application process.' }
    $processCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $ApplicationProcessId)
    $descendants = @(Get-ReadingAutomationElements -Root $Dialog -Condition $processCondition -MaximumCount 256)
    if ($descendants.Count -lt 2 -or @($descendants | Where-Object { $_.Current.ProcessId -ne $ApplicationProcessId }).Count -ne 0) {
        throw 'The native Open dialog child inventory is outside the exact process-bound contract.'
    }
    $editTypeCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)
    $editCondition = [Windows.Automation.AndCondition]::new($processCondition,$editTypeCondition)
    $edits = @(Get-ReadingAutomationElements -Root $Dialog -Condition $editCondition | Where-Object {
        $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and $_.Current.AutomationId -in @('1001','1148')
    })
    if ($edits.Count -ne 1) { throw 'The process-bound native Open dialog did not expose one exact filename editor.' }
    Assert-ReadingAutomationChildProcessId -Elements $edits -ApplicationProcessId $ApplicationProcessId -Kind 'filename editor'
    $valuePattern = $null
    if (-not $edits[0].TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern) -or $valuePattern.Current.IsReadOnly) {
        throw 'The process-bound filename editor did not expose a writable ValuePattern.'
    }
    $valuePattern.SetValue($Path)
    $buttonTypeCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
    $buttonCondition = [Windows.Automation.AndCondition]::new($processCondition,$buttonTypeCondition)
    $buttons = @(Get-ReadingAutomationElements -Root $Dialog -Condition $buttonCondition | Where-Object {
        $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and $_.Current.AutomationId -ceq '1' -and $_.Current.Name -ceq 'Open'
    })
    if ($buttons.Count -ne 1) { throw 'The process-bound native Open dialog did not expose one exact Open button.' }
    Assert-ReadingAutomationChildProcessId -Elements $buttons -ApplicationProcessId $ApplicationProcessId -Kind 'Open button'
    $invokePattern = $null
    if (-not $buttons[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
        throw 'The process-bound native Open button did not expose InvokePattern.'
    }
    $invokePattern.Invoke()
}

function Open-ReadingUserFile {
    param([Parameter(Mandatory = $true)][string]$SessionId,[Parameter(Mandatory = $true)][int]$ApplicationProcessId,[Parameter(Mandatory = $true)][string]$Path,[Parameter(Mandatory = $true)][datetime]$Deadline)
    $clicked = Invoke-WebDriverScript -SessionId $SessionId -Deadline $Deadline -Script "const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Open a file'&&!x.disabled);if(b.length===1)b[0].click();return b.length===1;"
    if ($clicked -isnot [bool] -or -not $clicked) { throw 'The exact installed Open a file control was unavailable.' }
    $dialog = Wait-ProcessBoundOpenDialog -ApplicationProcessId $ApplicationProcessId -Deadline $Deadline
    Submit-ProcessBoundOpenDialog -Dialog $dialog -ApplicationProcessId $ApplicationProcessId -Path $Path
}

function Assert-ReadingOwnedExecutables {
    param([object[]]$Owned,[string]$ApplicationPath,[string]$EdgeDriverPath)
    $application = [IO.Path]::GetFullPath($ApplicationPath); $edgeDriver = [IO.Path]::GetFullPath($EdgeDriverPath)
    $applications = 0; $edgeDrivers = 0; $webViews = 0
    foreach ($process in $Owned) {
        $path = [IO.Path]::GetFullPath([string]$process.Path); $name = [IO.Path]::GetFileName($path)
        if ($path.Equals($application,[StringComparison]::OrdinalIgnoreCase)) { $applications++; continue }
        if ($path.Equals($edgeDriver,[StringComparison]::OrdinalIgnoreCase)) { $edgeDrivers++; continue }
        if ($name.Equals('msedgewebview2.exe',[StringComparison]::OrdinalIgnoreCase)) { $webViews++; continue }
        throw 'Reading-tools captured an unexpected descendant executable.'
    }
    if ($applications -ne 1 -or $edgeDrivers -ne 1 -or $webViews -lt 1) { throw 'Reading-tools did not capture the exact app, EdgeDriver, and WebView descendant topology.' }
}

function Assert-ReadingProfileScope {
    param([string]$ProfileRoot,[string]$SettingsRoot,[string]$Binding)
    $profile = [IO.Path]::GetFullPath($ProfileRoot).TrimEnd('\'); $settings = [IO.Path]::GetFullPath($SettingsRoot).TrimEnd('\')
    if ($profile.Equals($settings,[StringComparison]::OrdinalIgnoreCase) -or $profile.StartsWith($settings + '\',[StringComparison]::OrdinalIgnoreCase) -or $settings.StartsWith($profile + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Reading-tools profile and settings roots are not exclusive.' }
    Assert-NoReparseAncestors -Path $profile; Assert-NoReparseAncestors -Path $settings
    $settingsEntries = @(Get-ChildItem -LiteralPath $settings -Force)
    if ($settingsEntries.Count -ne 1 -or $settingsEntries[0].PSIsContainer -or $settingsEntries[0].Name -cne 'upgrade-sentinel.json' -or ($settingsEntries[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reading-tools found stale, linked, or unrelated application-settings siblings.' }
    if ($Binding -cnotmatch '^(session-capability|owned-webview)-(requested-profile|requested-ebwebview)$') { throw 'Reading-tools did not bind the fresh requested WebView profile.' }
    $entries = @(Get-ChildItem -LiteralPath $profile -Force)
    $active = if ($Binding.EndsWith('requested-ebwebview',[StringComparison]::Ordinal)) {
        if ($entries.Count -ne 1 -or -not $entries[0].PSIsContainer -or $entries[0].Name -cne 'EBWebView') { throw 'The requested child WebView profile has stale or unrelated siblings.' }
        $entries[0].FullName
    } else {
        if ($entries.Count -eq 0) { throw 'The requested WebView profile remained empty.' }
        $profile
    }
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($active); $count = 0
    while ($pending.Count -gt 0) {
        foreach ($entry in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
            $count++; if ($count -gt 20000) { throw 'The requested WebView profile exceeded its inventory cap.' }
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The requested WebView profile contains a reparse point.' }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
        }
    }
    if ($count -eq 0) { throw 'The bound requested WebView profile remained empty.' }
}

function Wait-ReadingDocument {
    param([Parameter(Mandatory = $true)][string]$SessionId,[Parameter(Mandatory = $true)][int]$Pages,[Parameter(Mandatory = $true)][datetime]$Deadline)
    $script = "const i=document.querySelector('img[alt=`"Page 1`"]'),n=document.querySelector('input[aria-label=`"Page number`"]');return {dialog:document.querySelectorAll('dialog[aria-labelledby=`"password-title`"]').length,images:!!i&&i.complete&&i.naturalWidth>0&&i.naturalHeight>0,pages:[...document.querySelectorAll('span')].some(x=>x.textContent.trim()==='/ $Pages'),page:n?.value||''};"
    return Wait-WebDriverOracle -SessionId $SessionId -Script $script -Deadline $Deadline -Kind 'user PDF render' -Predicate { param($v) [int]$v.dialog -eq 0 -and [bool]$v.images -and [bool]$v.pages -and [string]$v.page -ceq '1' }
}

function Close-ActiveReadingDocument {
    param([Parameter(Mandatory = $true)][string]$SessionId,[Parameter(Mandatory = $true)][datetime]$Deadline)
    $closed = Invoke-WebDriverScript -SessionId $SessionId -Deadline $Deadline -Script "const t=[...document.querySelectorAll('div')].filter(x=>x.querySelector(':scope>button>span')&&x.querySelector(':scope>button[aria-label^=`"Close `"]'));const a=t.filter(x=>x.className.includes('selectedTab'));const b=a.length===1?a[0].querySelector(':scope>button[aria-label^=`"Close `"]'):null;if(b)b.click();return !!b;"
    if ($closed -isnot [bool] -or -not $closed) { throw 'The active document close control was unavailable.' }
    $null = Wait-WebDriverOracle -SessionId $SessionId -Deadline $Deadline -Kind 'document close' -Script "return document.querySelectorAll('input[aria-label=`"Page number`"]').length===0;" -Predicate { param($v) $v -is [bool] -and $v }
}

function Set-ReadingPasswordInput {
    param([Parameter(Mandatory = $true)][string]$SessionId,[Parameter(Mandatory = $true)][string]$Password,[Parameter(Mandatory = $true)][datetime]$Deadline)
    $escaped = $Password | ConvertTo-Json -Compress
    $script = "const i=document.querySelector('dialog[aria-labelledby=`"password-title`"] input[type=`"password`"]');if(!i)return false;const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,$escaped);i.dispatchEvent(new Event('input',{bubbles:true}));return i.value.length===$($Password.Length);"
    $set = Invoke-WebDriverScript -SessionId $SessionId -Deadline $Deadline -Script $script
    if ($set -isnot [bool] -or -not $set) { throw 'The password input did not accept the bounded test value.' }
}

function Submit-ReadingPassword {
    param([Parameter(Mandatory = $true)][string]$SessionId,[Parameter(Mandatory = $true)][datetime]$Deadline)
    $clicked = Invoke-WebDriverScript -SessionId $SessionId -Deadline $Deadline -Script "const d=document.querySelector('dialog[aria-labelledby=`"password-title`"]'),b=d?[...d.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Open PDF'&&!x.disabled):[];if(b.length===1)b[0].click();return b.length===1;"
    if ($clicked -isnot [bool] -or -not $clicked) { throw 'The password submit control was unavailable.' }
}

function Cancel-ReadingPassword {
    param([Parameter(Mandatory = $true)][string]$SessionId,[Parameter(Mandatory = $true)][datetime]$Deadline)
    $clicked = Invoke-WebDriverScript -SessionId $SessionId -Deadline $Deadline -Script "const d=document.querySelector('dialog[aria-labelledby=`"password-title`"]'),b=d?[...d.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Cancel'&&!x.disabled):[];if(b.length===1)b[0].click();return b.length===1;"
    if ($clicked -isnot [bool] -or -not $clicked) { throw 'The password cancel control was unavailable.' }
    $null = Wait-WebDriverOracle -SessionId $SessionId -Deadline $Deadline -Kind 'password cancellation' -Script "return {dialog:document.querySelectorAll('dialog[aria-labelledby=`"password-title`"]').length,documents:document.querySelectorAll('input[aria-label=`"Page number`"]').length};" -Predicate { param($v) [int]$v.dialog -eq 0 -and [int]$v.documents -eq 0 }
}

function Invoke-RealInstalledReadingTools {
    param([string]$ApplicationPath,[string]$TauriDriverPath,[string]$EdgeDriverPath,[string]$ProfileRoot,[string]$SettingsRoot,[string]$PlainFixture,[string]$ProtectedFixture,[string]$ExpectedEdgeDriverVersion,[string]$ExpectedRuntimeVersion)
    Wait-ReadingWebDriverPortsFree -Deadline ([datetime]::UtcNow.AddMilliseconds($script:ReadingPins.PortReleaseTimeoutMilliseconds))
    $deadline = [datetime]::UtcNow.AddMilliseconds($script:ReadingPins.TotalTimeoutMilliseconds)
    $driverCapture = $null; $driver = $null; $sessionId = $null; $captured = @(); $result = $null
    $startedAfter = [datetime]::UtcNow; $sessionDeleteOutcome = 'requestfailed'; $driverExited = $false
    $driverStopOutcome = 'not-invoked'; $remaining = -1; $residualCategory = 'multiple'; $clipboardCleared = $false
    $capturedOutcomes = [pscustomobject]@{ application='absent';tauriDriver='absent';edgeDriver='absent';webview='absent';ocrEngine='absent';other='absent' }
    $residualFacts = [pscustomobject]@{ ownership='none';application=$false;tauriDriver=$false;edgeDriver=$false;webview=$false;ocrEngine=$false;other=$false }
    try {
        $driverCapture = Start-BoundedDiscardProcess -Path $TauriDriverPath -Arguments @("--port=$($script:LaunchPins.WebDriverPort)","--native-port=$($script:LaunchPins.NativeDriverPort)","--native-driver=$EdgeDriverPath")
        $driverCapture.Start(); $driver = $driverCapture.Process
        do {
            try { $status = Invoke-BoundedLoopbackJson -Method GET -Path '/status' -Deadline $deadline; if ($status.value.ready) { break } } catch { }
            if ($driver.HasExited) { throw 'Pinned tauri-driver exited before reading-tools readiness.' }
            Start-Sleep -Milliseconds 200
        } while ([datetime]::UtcNow -lt $deadline)
        if ($null -eq $status -or -not [bool]$status.value.ready) { throw 'Pinned tauri-driver did not become ready for reading tools.' }
        $nativeDriverVersion = Wait-NativeDriverStatus -ExpectedVersion $ExpectedEdgeDriverVersion -Deadline $deadline -TauriDriver $driver
        $sessionBody = [ordered]@{ capabilities=[ordered]@{ alwaysMatch=[ordered]@{ browserName='wry';'tauri:options'=[ordered]@{ application=$ApplicationPath;args=@();webviewOptions=[ordered]@{userDataFolder=$ProfileRoot} } } } }
        $session = Invoke-BoundedLoopbackJson -Method POST -Path '/session' -Body $sessionBody -Deadline $deadline
        if ($null -eq $session.value -or [string]$session.value.sessionId -cnotmatch '^[A-Za-z0-9-]+$') { throw 'Reading-tools WebDriver session identifier was invalid.' }
        $sessionId = [string]$session.value.sessionId
        $capabilities = $session.value.capabilities
        $capabilityKeys = @($capabilities.PSObject.Properties.Name | Sort-Object -CaseSensitive)
        if ($capabilityKeys.Count -eq 0 -or $capabilityKeys.Count -gt 32 -or @($capabilityKeys | Where-Object { $_ -cnotmatch '^[A-Za-z0-9:._-]{1,64}$' }).Count -ne 0) { throw 'Reading-tools returned an unsafe session capability-key set.' }
        $vendorDriver = $capabilities.PSObject.Properties['msedge.msedgedriverVersion']
        if ($null -ne $vendorDriver -and ([string]$vendorDriver.Value -split '\s+')[0] -cne $ExpectedEdgeDriverVersion) { throw 'Reading-tools session EdgeDriver capability disagrees with its trusted receipt.' }
        $returnedRuntimeVersion = [string]$capabilities.browserVersion
        $runtimeParts = $returnedRuntimeVersion.Split('.'); $expectedRuntimeParts = $ExpectedRuntimeVersion.Split('.')
        if ($returnedRuntimeVersion -cnotmatch '^\d+\.\d+\.\d+\.\d+$' -or $runtimeParts.Count -ne 4 -or ($runtimeParts[0..2] -join '.') -cne ($expectedRuntimeParts[0..2] -join '.')) { throw 'Reading-tools WebView2 runtime capability disagrees with its trusted receipt.' }
        $returnedUserData = if ($null -ne $capabilities.PSObject.Properties['msedge.userDataDir']) { [string]$capabilities.'msedge.userDataDir' } else { '' }
        $homeOracle = Wait-WebDriverOracle -SessionId $sessionId -Deadline $deadline -Kind 'reading-tools home' -Script "return {ready:document.readyState==='complete',title:document.title,open:[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Open a file'&&!x.disabled).length};" -Predicate { param($v) [bool]$v.ready -and [string]$v.title -ceq 'PDF Workstation' -and [int]$v.open -eq 1 }
        do {
            $captured += @(Get-OwnedLaunchProcesses -RootProcessId $driver.Id -StartedAfter $startedAfter); $captured = @(Get-UniqueOwnedLaunchProcesses -Processes $captured)
            $apps = @($captured | Where-Object { [string]$_.Path -and [IO.Path]::GetFullPath([string]$_.Path).Equals([IO.Path]::GetFullPath($ApplicationPath),[StringComparison]::OrdinalIgnoreCase) })
            if ($apps.Count -eq 1) { break }
            if ($apps.Count -gt 1) { throw 'More than one owned installed application process was found.' }
            Start-Sleep -Milliseconds 100
        } while ([datetime]::UtcNow -lt $deadline)
        if ($apps.Count -ne 1) { throw 'The owned installed application process was unavailable for process-bound UI Automation.' }
        $applicationProcessId = [int]$apps[0].ProcessId
        Assert-ReadingOwnedExecutables -Owned $captured -ApplicationPath $ApplicationPath -EdgeDriverPath $EdgeDriverPath
        $profileBinding = if ($returnedUserData) { 'session-capability-' + (Get-ExactProfileBinding -Candidate $returnedUserData -RequestedProfile $ProfileRoot -SettingsRoot $SettingsRoot) } else { Get-OwnedProfileBinding -Owned $captured -RequestedProfile $ProfileRoot -SettingsRoot $SettingsRoot }
        Assert-ReadingProfileScope -ProfileRoot $ProfileRoot -SettingsRoot $SettingsRoot -Binding $profileBinding

        Open-ReadingUserFile -SessionId $sessionId -ApplicationProcessId $applicationProcessId -Path $PlainFixture -Deadline $deadline
        $null = Wait-ReadingDocument -SessionId $sessionId -Pages 6 -Deadline $deadline
        $layer = Wait-WebDriverOracle -SessionId $sessionId -Deadline $deadline -Kind 'embedded text layer' -Script "const p=document.querySelector('[aria-label=`"Page 1`"]'),l=p?.querySelector('[data-testid=`"text-layer`"]'),i=p?.querySelector('img[alt=`"Page 1`"]');return {ready:!!l&&!!i&&i.complete,glyphs:l?.querySelectorAll('[data-geometry-index]').length||0};" -Predicate { param($v) [bool]$v.ready -and [int]$v.glyphs -gt 20 }
        $selectionScript = @'
const target='A place for your PDFs.',p=document.querySelector('[aria-label="Page 1"]'),l=p?.querySelector('[data-testid="text-layer"]'),i=p?.querySelector('img[alt="Page 1"]');if(!l||!i)return {ready:false,exact:false,utf16:0,rects:0,inside:false};const s=[...l.querySelectorAll('[data-geometry-index]')],joined=s.map(x=>x.textContent||'').join(''),start=joined.indexOf(target);if(start<0)return {ready:true,exact:false,utf16:0,rects:0,inside:false};let offset=0,first=null,last=null,firstOffset=0,lastOffset=0;for(const x of s){const text=x.textContent||'',next=offset+text.length;if(first===null&&start>=offset&&start<next){first=x;firstOffset=start-offset}if(start+target.length>offset&&start+target.length<=next){last=x;lastOffset=start+target.length-offset;break}offset=next}if(!first||!last)return {ready:true,exact:false,utf16:0,rects:0,inside:false};const r=document.createRange();r.setStart(first.firstChild,firstOffset);r.setEnd(last.firstChild,lastOffset);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);const rects=[...r.getClientRects()],page=i.getBoundingClientRect(),inside=rects.length>0&&rects.every(x=>x.width>0&&x.height>0&&x.left>=page.left-2&&x.top>=page.top-2&&x.right<=page.right+2&&x.bottom<=page.bottom+2);return {ready:true,exact:sel.toString()===target,utf16:sel.toString().length,rects:rects.length,inside};
'@
        $selection = Invoke-WebDriverScript -SessionId $sessionId -Script $selectionScript -Deadline $deadline
        if (-not [bool]$selection.ready -or -not [bool]$selection.exact -or [int]$selection.utf16 -ne $script:ReadingPins.SelectionText.Length -or [int]$selection.rects -lt 1 -or -not [bool]$selection.inside) { throw 'Installed embedded-text selection or its on-page geometry was not exact.' }
        $expectedClipboard = Get-ReadingTextReceipt -Text $script:ReadingPins.SelectionText
        Invoke-ReadingClipboardSta -Operation set-sentinel
        $sentinelReceipt = Invoke-ReadingClipboardSta -Operation receipt
        $expectedSentinel = Get-ReadingTextReceipt -Text 'reading-verifier-sentinel'
        if ([int]$sentinelReceipt.utf8Bytes -ne [int]$expectedSentinel.utf8Bytes -or [string]$sentinelReceipt.sha256 -cne [string]$expectedSentinel.sha256) { throw 'The Windows clipboard sentinel was not established before the real copy action.' }
        Send-ReadingKeyChord -SessionId $sessionId -Key c -Deadline $deadline
        $clipboard = Wait-ReadingClipboardReceipt -Expected $expectedClipboard -Deadline $deadline

        Send-ReadingKeyChord -SessionId $sessionId -Key f -Deadline $deadline
        $null = Wait-WebDriverOracle -SessionId $sessionId -Deadline $deadline -Kind 'Find panel' -Script "return document.querySelectorAll('aside[aria-label=`"Find in document`"] input[aria-label=`"Find in document`"]').length===1;" -Predicate { param($v) $v -is [bool] -and $v }
        $searchScript = @'
const i=document.querySelector('aside[aria-label="Find in document"] input[aria-label="Find in document"]');if(!i)return false;const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'Sample document');i.dispatchEvent(new Event('input',{bubbles:true}));i.closest('form').requestSubmit();return true;
'@
        if (-not (Invoke-WebDriverScript -SessionId $sessionId -Script $searchScript -Deadline $deadline)) { throw 'The installed Find form was unavailable.' }
        $search = Wait-WebDriverOracle -SessionId $sessionId -Deadline $deadline -Kind 'Find results' -Script "const a=document.querySelector('aside[aria-label=`"Find in document`"]');return {status:[...a.querySelectorAll('[role=`"status`"]')].map(x=>x.textContent.trim()).includes('6 matching pages.'),results:[...a.querySelectorAll('button')].filter(x=>/^Go to page [1-6]$/.test(x.textContent.trim())).length,next:[...a.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Next matching page'&&!x.disabled).length};" -Predicate { param($v) [bool]$v.status -and [int]$v.results -eq 6 -and [int]$v.next -eq 1 }
        for ($step = 0; $step -lt 2; $step++) {
            $next = Invoke-WebDriverScript -SessionId $sessionId -Deadline $deadline -Script "const a=document.querySelector('aside[aria-label=`"Find in document`"]'),b=a?[...a.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Next matching page'&&!x.disabled):[];if(b.length===1)b[0].click();return b.length===1;"
            if ($next -isnot [bool] -or -not $next) { throw 'Find next-page navigation control was unavailable.' }
        }
        $geometryScript = @'
const a=document.querySelector('aside[aria-label="Find in document"]'),live=[...a.querySelectorAll('[aria-live="polite"]')].map(x=>x.textContent.trim()),p=document.querySelector('[aria-label="Page 2"]'),i=p?.querySelector('img[alt="Page 2"]'),l=p?.querySelector('[data-testid="text-layer"]'),h=p?[...p.querySelectorAll('[data-testid="search-highlight"]')]:[];if(!i||!l)return {ready:false,nav:false,count:0,inside:false,paired:false};const page=i.getBoundingClientRect(),glyphs=[...l.querySelectorAll('[data-geometry-index]')],target='Sample document',joined=glyphs.map(x=>x.textContent||'').join(''),start=joined.indexOf(target),indexes=[];let offset=0;for(let n=0;n<glyphs.length;n++){const text=glyphs[n].textContent||'',next=offset+text.length;if(start>=0&&next>start&&offset<start+target.length&&glyphs[n].hasAttribute('data-angle'))indexes.push(n);offset=next}const inside=h.length>0&&h.every(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=page.left-2&&r.top>=page.top-2&&r.right<=page.right+2&&r.bottom<=page.bottom+2}),paired=h.length===indexes.length&&h.every((x,n)=>{const r=x.getBoundingClientRect(),g=glyphs[indexes[n]].getBoundingClientRect();return Math.abs(r.left-g.left)<=2&&Math.abs(r.top-g.top)<=2&&Math.abs(r.width-g.width)<=2&&Math.abs(r.height-g.height)<=2});return {ready:i.complete&&i.naturalWidth>0,nav:live.includes('Matching page 2 of 6'),count:h.length,inside,paired};
'@
        $geometry = Wait-WebDriverOracle -SessionId $sessionId -Script $geometryScript -Deadline $deadline -Kind 'search highlight geometry' -Predicate { param($v) [bool]$v.ready -and [bool]$v.nav -and [int]$v.count -gt 5 -and [bool]$v.inside -and [bool]$v.paired }
        Close-ActiveReadingDocument -SessionId $sessionId -Deadline $deadline

        Open-ReadingUserFile -SessionId $sessionId -ApplicationProcessId $applicationProcessId -Path $ProtectedFixture -Deadline $deadline
        $prompt = Wait-WebDriverOracle -SessionId $sessionId -Deadline $deadline -Kind 'password prompt' -Script "const d=document.querySelector('dialog[aria-labelledby=`"password-title`"]'),i=d?.querySelector('input[type=`"password`"]');return {one:!!d&&!!i&&i.value==='',message:[...d?.querySelectorAll('p')||[]].some(x=>x.textContent.trim()==='Your password is used only to open this document.')};" -Predicate { param($v) [bool]$v.one -and [bool]$v.message }
        Set-ReadingPasswordInput -SessionId $sessionId -Password 'wrong password' -Deadline $deadline; Submit-ReadingPassword -SessionId $sessionId -Deadline $deadline
        $wrong = Wait-WebDriverOracle -SessionId $sessionId -Deadline $deadline -Kind 'wrong password retry' -Script "const d=document.querySelector('dialog[aria-labelledby=`"password-title`"]'),i=d?.querySelector('input[type=`"password`"]');return {prompt:!!d,cleared:i?.value==='',alert:[...d?.querySelectorAll('[role=`"alert`"]')||[]].some(x=>x.textContent.trim()==='Incorrect password. Try again.')};" -Predicate { param($v) [bool]$v.prompt -and [bool]$v.cleared -and [bool]$v.alert }
        Set-ReadingPasswordInput -SessionId $sessionId -Password $script:ReadingPins.Password -Deadline $deadline; Submit-ReadingPassword -SessionId $sessionId -Deadline $deadline
        $null = Wait-ReadingDocument -SessionId $sessionId -Pages 1 -Deadline $deadline
        Close-ActiveReadingDocument -SessionId $sessionId -Deadline $deadline
        Open-ReadingUserFile -SessionId $sessionId -ApplicationProcessId $applicationProcessId -Path $ProtectedFixture -Deadline $deadline
        $reopened = Wait-WebDriverOracle -SessionId $sessionId -Deadline $deadline -Kind 'transient password reopen' -Script "const d=document.querySelector('dialog[aria-labelledby=`"password-title`"]'),i=d?.querySelector('input[type=`"password`"]');return {prompt:!!d,empty:i?.value===''};" -Predicate { param($v) [bool]$v.prompt -and [bool]$v.empty }
        Cancel-ReadingPassword -SessionId $sessionId -Deadline $deadline
        Start-Sleep -Milliseconds 250
        Open-ReadingUserFile -SessionId $sessionId -ApplicationProcessId $applicationProcessId -Path $ProtectedFixture -Deadline $deadline
        $afterCancel = Wait-WebDriverOracle -SessionId $sessionId -Deadline $deadline -Kind 'post-cancel password reopen' -Script "const d=document.querySelector('dialog[aria-labelledby=`"password-title`"]'),i=d?.querySelector('input[type=`"password`"]');return {prompt:!!d,empty:i?.value===''};" -Predicate { param($v) [bool]$v.prompt -and [bool]$v.empty }
        Cancel-ReadingPassword -SessionId $sessionId -Deadline $deadline

        $captured += @(Get-OwnedLaunchProcesses -RootProcessId $driver.Id -StartedAfter $startedAfter); $captured = @(Get-UniqueOwnedLaunchProcesses -Processes $captured)
        Assert-ReadingOwnedExecutables -Owned $captured -ApplicationPath $ApplicationPath -EdgeDriverPath $EdgeDriverPath
        Assert-ReadingProfileScope -ProfileRoot $ProfileRoot -SettingsRoot $SettingsRoot -Binding $profileBinding
        if ($driverCapture.Exceeded) { throw 'Reading-tools WebDriver diagnostic output exceeded its discarded cap.' }
        $result = [pscustomobject]@{
            nativeDriverVersion = $nativeDriverVersion
            returnedRuntimeVersion = $returnedRuntimeVersion
            profileBinding = $profileBinding
            processBoundPickerVerified = $true
            programmaticDomSelectionVerified = $true
            selectionGeometryInsidePage = [bool]$selection.inside
            selectionClientRectCount = [int]$selection.rects
            selectedTextUtf8Bytes = [int]$expectedClipboard.utf8Bytes
            selectedTextSha256 = [string]$expectedClipboard.sha256
            windowsClipboardVerified = $true
            clipboardUtf8Bytes = [int]$clipboard.utf8Bytes
            clipboardSha256 = [string]$clipboard.sha256
            searchResultCount = [int]$search.results
            searchNavigationVerified = [bool]$geometry.nav
            searchHighlightCount = [int]$geometry.count
            searchHighlightInsidePage = [bool]$geometry.inside
            searchHighlightMatchesGlyphGeometry = [bool]$geometry.paired
            passwordPromptVerified = [bool]$prompt.one
            wrongPasswordRetryVerified = [bool]$wrong.alert
            passwordInputClearedAfterWrong = [bool]$wrong.cleared
            correctPasswordOpenVerified = $true
            passwordReentryRequiredAfterCloseAndReopen = [bool]$reopened.prompt
            passwordCancelVerified = $true
            postCancelPromptVerified = [bool]$afterCancel.prompt
        }
    } finally {
        try {
            Invoke-ReadingClipboardSta -Operation clear
            $emptyClipboard = Invoke-ReadingClipboardSta -Operation receipt
            $emptyReceipt = Get-ReadingTextReceipt -Text ''
            $clipboardCleared = [int]$emptyClipboard.utf8Bytes -eq 0 -and [string]$emptyClipboard.sha256 -ceq [string]$emptyReceipt.sha256
        } catch { $clipboardCleared = $false }
        $cleanupDeadline = [datetime]::UtcNow.AddSeconds(10)
        if ($sessionId) { $sessionDeleteOutcome = Invoke-SessionDeleteOutcome -SessionId $sessionId -Deadline $cleanupDeadline }
        if ($driver) {
            try { $captured += @(Get-OwnedLaunchProcesses -RootProcessId $driver.Id -StartedAfter $startedAfter); $captured = @(Get-UniqueOwnedLaunchProcesses -Processes $captured) } catch { }
            $capturedOutcomes = Stop-OwnedLaunchProcesses -TauriDriver $driver -Captured $captured -Deadline ([datetime]::UtcNow.AddMilliseconds($script:LaunchPins.CleanupProcessTimeoutMilliseconds))
            $driverStopOutcome = [string]$capturedOutcomes.rootOutcome
            $remainingProcesses = @(Get-LaunchProcessSnapshot); $remaining = $remainingProcesses.Count
            $residualCategory = Get-LaunchResidualCategory -Processes $remainingProcesses
            $residualFacts = Get-LaunchResidualFacts -Processes $remainingProcesses -Captured $captured
            $driverExited = [bool]$driver.HasExited
        }
        if ($driverCapture) { $driverCapture.Dispose() }
    }
    if (-not $clipboardCleared) { throw 'Installed reading-tools verification did not clear and verify the Windows clipboard.' }
    Assert-LaunchCleanupState -Result $result -SessionDeleteOutcome $sessionDeleteOutcome -DriverExited $driverExited -RelevantProcessesClear ($residualCategory -ceq 'none') -DriverStopOutcome $driverStopOutcome -ResidualCategory $residualCategory -CapturedApplication $capturedOutcomes.application -CapturedTauriDriver $capturedOutcomes.tauriDriver -CapturedEdgeDriver $capturedOutcomes.edgeDriver -CapturedWebView $capturedOutcomes.webview -CapturedOcrEngine $capturedOutcomes.ocrEngine -CapturedOther $capturedOutcomes.other -ResidualOwnership $residualFacts.ownership -ResidualApplication $residualFacts.application -ResidualTauriDriver $residualFacts.tauriDriver -ResidualEdgeDriver $residualFacts.edgeDriver -ResidualWebView $residualFacts.webview -ResidualOcrEngine $residualFacts.ocrEngine -ResidualOther $residualFacts.other
    if ($null -eq $result -or $sessionDeleteOutcome -cne 'verified' -or -not $driverExited -or $remaining -ne 0) { throw 'Installed reading-tools cleanup did not reach its exact zero-process state.' }
    $result | Add-Member -NotePropertyName sessionDeleted -NotePropertyValue $true
    $result | Add-Member -NotePropertyName ownedProcessTreeStopped -NotePropertyValue $true
    $result | Add-Member -NotePropertyName relevantProcessesRemaining -NotePropertyValue 0
    return $result
}

function Invoke-InstalledReadingTools {
    param(
        [Parameter(Mandatory = $true)][string]$ApplicationPath,
        [Parameter(Mandatory = $true)]$ApplicationReceipt,
        [Parameter(Mandatory = $true)][string]$WebDriverRoot,
        [Parameter(Mandatory = $true)][string]$ProfileRoot,
        [Parameter(Mandatory = $true)][string]$SettingsRoot,
        [Parameter(Mandatory = $true)][string]$PlainFixture,
        [Parameter(Mandatory = $true)][string]$ProtectedFixture,
        [Parameter(Mandatory = $true)]$PlainReceipt,
        [Parameter(Mandatory = $true)]$ProtectedReceipt,
        [Parameter(Mandatory = $true)][string]$ExpectedPublisher
    )
    $receipt = Get-Content -LiteralPath (Join-Path $WebDriverRoot 'webdriver-receipt.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-WebDriverReceipt -Receipt $receipt
    $tauriDriver = Join-Path $WebDriverRoot 'tauri-driver-install/bin/tauri-driver.exe'
    $edgeDriver = Join-Path $WebDriverRoot 'edge-driver/msedgedriver.exe'
    Assert-ReadingFileReceipt -Path $ApplicationPath -Bytes ([uint64]$ApplicationReceipt.bytes) -Sha256 ([string]$ApplicationReceipt.sha256) -Kind 'Installed signed reading-tools application'
    $null = Assert-TrustedWindowsSignature -Path $ApplicationPath -ExpectedPublisher $ExpectedPublisher
    Assert-ReadingFileReceipt -Path $tauriDriver -Bytes ([uint64]$receipt.tauriDriver.bytes) -Sha256 ([string]$receipt.tauriDriver.sha256) -Kind 'Pinned reading-tools tauri-driver'
    Assert-ReadingFileReceipt -Path $edgeDriver -Bytes ([uint64]$receipt.edgeDriver.bytes) -Sha256 ([string]$receipt.edgeDriver.sha256) -Kind 'Pinned reading-tools EdgeDriver'
    $null = Assert-TrustedWindowsSignature -Path $edgeDriver -ExpectedPublisher $script:LaunchPins.EdgePublisher
    foreach ($fixture in @(@($PlainFixture,$PlainReceipt,'Plain reading fixture'),@($ProtectedFixture,$ProtectedReceipt,'Protected reading fixture'))) {
        Assert-ReadingFileReceipt -Path ([string]$fixture[0]) -Bytes ([uint64]$fixture[1].bytes) -Sha256 ([string]$fixture[1].sha256) -Kind ([string]$fixture[2])
    }
    if (Test-Path -LiteralPath $ProfileRoot) { throw 'Reading-tools WebView profile must be fresh.' }
    if (-not (Test-Path -LiteralPath $SettingsRoot -PathType Container)) { throw 'The controlled application settings root is missing after the signed upgrade proof.' }
    Assert-NoReparseAncestors -Path $SettingsRoot
    [IO.Directory]::CreateDirectory($ProfileRoot) | Out-Null
    $preSettingsEntries = @(Get-ChildItem -LiteralPath $SettingsRoot -Force)
    if ($preSettingsEntries.Count -ne 1 -or $preSettingsEntries[0].PSIsContainer -or $preSettingsEntries[0].Name -cne 'upgrade-sentinel.json' -or ($preSettingsEntries[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -or @(Get-ChildItem -LiteralPath $ProfileRoot -Force).Count -ne 0) { throw 'Reading-tools profile roots were not fresh, exclusive, and sentinel-only before launch.' }
    $settingsSentinel = $preSettingsEntries[0].FullName
    $settingsSentinelBytes = [uint64]$preSettingsEntries[0].Length
    $settingsSentinelSha256 = Get-ExactSha256 -Path $settingsSentinel
    if (@(Get-LaunchProcessSnapshot).Count -ne 0) { throw 'A relevant application or WebDriver process existed before reading-tools verification.' }
    $uiResult = $null
    try {
        $uiResult = Invoke-RealInstalledReadingTools -ApplicationPath $ApplicationPath -TauriDriverPath $tauriDriver -EdgeDriverPath $edgeDriver -ProfileRoot $ProfileRoot -SettingsRoot $SettingsRoot -PlainFixture $PlainFixture -ProtectedFixture $ProtectedFixture -ExpectedEdgeDriverVersion ([string]$receipt.edgeDriver.version) -ExpectedRuntimeVersion ([string]$receipt.webView2RuntimeVersion)
    } finally {
        Assert-ReadingFileReceipt -Path $settingsSentinel -Bytes $settingsSentinelBytes -Sha256 $settingsSentinelSha256 -Kind 'Post-flow upgrade settings sentinel'
        foreach ($fixture in @(@($PlainFixture,$PlainReceipt,'Post-flow plain reading fixture'),@($ProtectedFixture,$ProtectedReceipt,'Post-flow protected reading fixture'))) {
            Assert-ReadingFileReceipt -Path ([string]$fixture[0]) -Bytes ([uint64]$fixture[1].bytes) -Sha256 ([string]$fixture[1].sha256) -Kind ([string]$fixture[2])
        }
        $fixtureFiles = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($PlainFixture)) -File -Force)
        if ($fixtureFiles.Count -ne 2 -or @($fixtureFiles | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw 'The reading fixture inventory changed or contains a reparse point.' }
    }
    return $uiResult
}
