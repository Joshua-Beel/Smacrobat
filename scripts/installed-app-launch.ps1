$script:LaunchPins = [ordered]@{
    TauriDriverVersion = '2.0.6'
    TauriDriverPackageSha256 = '24DC39BD26A65361C1C8E067636BBFF1D9DD7E2FC58FF874EDFBA33ACAB0E6D0'
    EdgePublisher = 'Microsoft Corporation'
    WebDriverPort = 4444
    NativeDriverPort = 4445
    TotalTimeoutMilliseconds = 60000
    RequestBytesMaximum = 1MB
    JsonDepthMaximum = 12
    JsonNodesMaximum = 512
}

function Assert-LaunchExactProperties {
    param($Value,[string[]]$Expected,[string]$Kind)
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $wanted = @($Expected | Sort-Object -CaseSensitive)
    if ($actual.Count -ne $wanted.Count -or (Compare-Object $wanted $actual -CaseSensitive)) {
        throw "$Kind has an unexpected or missing property."
    }
}

function Assert-LaunchReceiptValue {
    param($Value,[string]$Kind)
    Assert-LaunchExactProperties -Value $Value -Expected @('bytes','sha256') -Kind $Kind
    if ([uint64]$Value.bytes -eq 0 -or [string]$Value.sha256 -cnotmatch '^[A-F0-9]{64}$') { throw "$Kind has an invalid receipt." }
}

function Assert-WebDriverReceipt {
    param($Receipt)
    Assert-LaunchExactProperties -Value $Receipt -Expected @('schemaVersion','tauriDriverSource','tauriDriver','webView2RuntimeVersion','edgeDriverArchive','edgeDriver') -Kind 'WebDriver receipt'
    if ($Receipt.schemaVersion -ne 1 -or [string]$Receipt.webView2RuntimeVersion -cnotmatch '^\d+\.\d+\.\d+\.\d+$') {
        throw 'WebDriver receipt schema or WebView2 version is invalid.'
    }
    Assert-LaunchExactProperties -Value $Receipt.tauriDriverSource -Expected @('version','origin','bytes','sha256') -Kind 'tauri-driver source receipt'
    if ([string]$Receipt.tauriDriverSource.version -cne $script:LaunchPins.TauriDriverVersion -or
        [string]$Receipt.tauriDriverSource.origin -cne 'static.crates.io' -or
        [string]$Receipt.tauriDriverSource.sha256 -cne $script:LaunchPins.TauriDriverPackageSha256 -or
        [uint64]$Receipt.tauriDriverSource.bytes -eq 0) { throw 'tauri-driver source receipt is not pinned.' }
    Assert-LaunchExactProperties -Value $Receipt.tauriDriver -Expected @('version','cargoVersion','rustcVersion','bytes','sha256') -Kind 'tauri-driver executable receipt'
    if ([string]$Receipt.tauriDriver.version -cne $script:LaunchPins.TauriDriverVersion -or [uint64]$Receipt.tauriDriver.bytes -eq 0 -or
        [string]$Receipt.tauriDriver.cargoVersion -cnotmatch '^cargo \d+\.\d+\.\d+ ' -or [string]$Receipt.tauriDriver.rustcVersion -cnotmatch '^rustc \d+\.\d+\.\d+ ' -or
        [string]$Receipt.tauriDriver.sha256 -cnotmatch '^[A-F0-9]{64}$') { throw 'tauri-driver executable receipt is invalid.' }
    Assert-LaunchExactProperties -Value $Receipt.edgeDriverArchive -Expected @('origin','bytes','sha256') -Kind 'EdgeDriver archive receipt'
    if (@('msedgedriver.microsoft.com','msedgewebdriverstorage.blob.core.windows.net') -cnotcontains [string]$Receipt.edgeDriverArchive.origin -or
        [uint64]$Receipt.edgeDriverArchive.bytes -eq 0 -or [string]$Receipt.edgeDriverArchive.sha256 -cnotmatch '^[A-F0-9]{64}$') {
        throw 'EdgeDriver archive receipt is outside its exact Microsoft origin allowlist.'
    }
    Assert-LaunchExactProperties -Value $Receipt.edgeDriver -Expected @('version','bytes','sha256','signatureStatus','publisher','hasTimestamp') -Kind 'EdgeDriver executable receipt'
    $runtimeParts = ([string]$Receipt.webView2RuntimeVersion).Split('.')
    $driverParts = ([string]$Receipt.edgeDriver.version).Split('.')
    if ($driverParts.Count -ne 4 -or ($driverParts[0..2] -join '.') -cne ($runtimeParts[0..2] -join '.') -or
        [uint64]$Receipt.edgeDriver.bytes -eq 0 -or [string]$Receipt.edgeDriver.sha256 -cnotmatch '^[A-F0-9]{64}$' -or
        [string]$Receipt.edgeDriver.signatureStatus -cne 'Valid' -or [string]$Receipt.edgeDriver.publisher -cne $script:LaunchPins.EdgePublisher -or
        $Receipt.edgeDriver.hasTimestamp -isnot [bool] -or -not $Receipt.edgeDriver.hasTimestamp) {
        throw 'EdgeDriver receipt is not trusted or does not match the WebView2 Runtime.'
    }
}

function Assert-BoundedJsonShape {
    param($Value,[int]$Depth = 0,[ref]$Nodes)
    $Nodes.Value++
    if ($Depth -gt $script:LaunchPins.JsonDepthMaximum -or $Nodes.Value -gt $script:LaunchPins.JsonNodesMaximum) {
        throw 'WebDriver JSON exceeded its shape limit.'
    }
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) { return }
    if ($Value -is [Collections.IDictionary]) {
        foreach ($key in $Value.Keys) { Assert-BoundedJsonShape -Value $Value[$key] -Depth ($Depth + 1) -Nodes $Nodes }
        return
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [Management.Automation.PSCustomObject]) {
        foreach ($item in $Value) { Assert-BoundedJsonShape -Value $item -Depth ($Depth + 1) -Nodes $Nodes }
        return
    }
    foreach ($property in $Value.PSObject.Properties) { Assert-BoundedJsonShape -Value $property.Value -Depth ($Depth + 1) -Nodes $Nodes }
}

function Get-LaunchRemainingMilliseconds {
    param([datetime]$Deadline)
    $remaining = [int][Math]::Floor(($Deadline - [datetime]::UtcNow).TotalMilliseconds)
    if ($remaining -le 0) { throw 'Installed application launch smoke exceeded its total deadline.' }
    return [Math]::Min($remaining, 10000)
}

function Invoke-BoundedLoopbackJson {
    param(
        [ValidateSet('GET','POST','DELETE')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        $Body,
        [Parameter(Mandatory = $true)][datetime]$Deadline,
        [int]$Port = $script:LaunchPins.WebDriverPort
    )
    $webDriverRequest = $Port -eq $script:LaunchPins.WebDriverPort -and $Path -cmatch '^/(status|session(?:/[-A-Za-z0-9]+(?:/execute/sync)?)?)$'
    $nativeStatusRequest = $Port -eq $script:LaunchPins.NativeDriverPort -and $Method -ceq 'GET' -and $Path -ceq '/status' -and $null -eq $Body
    if (-not $webDriverRequest -and -not $nativeStatusRequest) {
        throw 'WebDriver requests are restricted to the fixed loopback endpoint and command allowlist.'
    }
    $uri = [Uri]::new("http://127.0.0.1:$Port$Path")
    if (-not $uri.IsLoopback -or $uri.Scheme -cne 'http') { throw 'WebDriver URI is not fixed loopback HTTP.' }
    $timeout = Get-LaunchRemainingMilliseconds -Deadline $Deadline
    $request = [Net.HttpWebRequest]::CreateHttp($uri)
    $request.Method = $Method
    $request.AllowAutoRedirect = $false
    $request.Proxy = $null
    $request.Timeout = $timeout
    $request.ReadWriteTimeout = $timeout
    $request.ContentType = 'application/json; charset=utf-8'
    if ($null -ne $Body) {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Body | ConvertTo-Json -Depth 12 -Compress))
        if ($bytes.Length -gt $script:LaunchPins.RequestBytesMaximum) { throw 'WebDriver request exceeded its byte limit.' }
        $request.ContentLength = $bytes.Length
        $requestStream = $request.GetRequestStream()
        try { $requestStream.Write($bytes, 0, $bytes.Length) } finally { $requestStream.Dispose() }
    }
    $response = $null
    try {
        $response = [Net.HttpWebResponse]$request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { throw 'WebDriver returned an unexpected HTTP status.' }
        if ($response.ContentLength -gt $script:LaunchPins.RequestBytesMaximum) { throw 'WebDriver response exceeded its declared byte limit.' }
        $stream = $response.GetResponseStream()
        $memory = [IO.MemoryStream]::new()
        try {
            $buffer = [byte[]]::new(8192)
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if ($memory.Length + $read -gt $script:LaunchPins.RequestBytesMaximum) { throw 'WebDriver response exceeded its live byte limit.' }
                $memory.Write($buffer, 0, $read)
            }
            $text = [Text.UTF8Encoding]::new($false, $true).GetString($memory.ToArray())
        } finally { $memory.Dispose(); $stream.Dispose() }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
    }
    if ([string]::IsNullOrWhiteSpace($text)) { throw 'WebDriver returned an empty JSON response.' }
    $value = $text | ConvertFrom-Json
    $nodes = 0
    Assert-BoundedJsonShape -Value $value -Nodes ([ref]$nodes)
    return $value
}

function Assert-NativeDriverStatus {
    param($Status,[Parameter(Mandatory = $true)][string]$ExpectedVersion)
    if ($ExpectedVersion -cnotmatch '^\d+\.\d+\.\d+\.\d+$' -or
        $null -eq $Status.PSObject.Properties['value'] -or
        $null -eq $Status.value.PSObject.Properties['ready'] -or $Status.value.ready -isnot [bool] -or -not $Status.value.ready -or
        $null -eq $Status.value.PSObject.Properties['build'] -or
        $null -eq $Status.value.build.PSObject.Properties['version']) {
        throw 'Native EdgeDriver status is incomplete.'
    }
    $reported = ([string]$Status.value.build.version -split '\s+')[0]
    if ($reported -cne $ExpectedVersion) { throw 'The live native EdgeDriver version does not match its trusted receipt.' }
    return $reported
}

function Wait-NativeDriverStatus {
    param([Parameter(Mandatory = $true)][string]$ExpectedVersion,[Parameter(Mandatory = $true)][datetime]$Deadline,[Parameter(Mandatory = $true)]$TauriDriver,[scriptblock]$StatusProvider)
    do {
        try {
            $status = if ($StatusProvider) { & $StatusProvider $Deadline } else { Invoke-BoundedLoopbackJson -Method GET -Path '/status' -Port $script:LaunchPins.NativeDriverPort -Deadline $Deadline }
        } catch {
            if ($TauriDriver.HasExited) { throw 'Pinned tauri-driver exited before the native EdgeDriver became ready.' }
            Start-Sleep -Milliseconds 200
            continue
        }
        return Assert-NativeDriverStatus -Status $status -ExpectedVersion $ExpectedVersion
    } while ([datetime]::UtcNow -lt $Deadline)
    throw 'Native EdgeDriver did not become ready before the shared launch deadline.'
}

function Get-OwnedProfileBinding {
    param([object[]]$Owned,[Parameter(Mandatory = $true)][string]$ExpectedProfile)
    $expected = [IO.Path]::GetFullPath($ExpectedProfile).TrimEnd('\')
    $webViews = @($Owned | Where-Object { [IO.Path]::GetFileName([string]$_.Path).Equals('msedgewebview2.exe',[StringComparison]::OrdinalIgnoreCase) })
    if ($webViews.Count -eq 0) { throw 'No owned WebView2 process was available to bind the fresh profile.' }
    $matched = 0
    foreach ($process in $webViews) {
        $commandLine = [string]$process.CommandLine
        $userDataSwitches = [regex]::Matches($commandLine, '(?i)(?:^|\s)"?--user-data-dir=(?:"(?<quoted>[^"]+)"|(?<plain>[^\s"]+))"?(?=\s|$)')
        if ($userDataSwitches.Count -gt 1) { throw 'An owned WebView2 process has multiple user-data-dir switches.' }
        if ($userDataSwitches.Count -eq 1) {
            $candidate = if ($userDataSwitches[0].Groups['quoted'].Success) { $userDataSwitches[0].Groups['quoted'].Value } else { $userDataSwitches[0].Groups['plain'].Value }
            $canonical = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
            if (-not $canonical.Equals($expected,[StringComparison]::OrdinalIgnoreCase)) { throw 'An owned WebView2 process used a different profile path.' }
            $matched++
        }
    }
    if ($matched -eq 0) { throw 'No owned WebView2 command line bound the fresh profile path.' }
    return 'owned-webview-command-line'
}

function Assert-OwnedLaunchExecutables {
    param([object[]]$Owned,[Parameter(Mandatory = $true)][string]$ApplicationPath,[Parameter(Mandatory = $true)][string]$EdgeDriverPath)
    $applications = @($Owned | Where-Object { [IO.Path]::GetFileName([string]$_.Path).Equals('pdf-workstation.exe',[StringComparison]::OrdinalIgnoreCase) })
    if ($applications.Count -ne 1 -or -not ([IO.Path]::GetFullPath([string]$applications[0].Path)).Equals([IO.Path]::GetFullPath($ApplicationPath),[StringComparison]::OrdinalIgnoreCase)) {
        throw 'WebDriver did not launch exactly the installed signed application.'
    }
    $nativeDrivers = @($Owned | Where-Object { [IO.Path]::GetFileName([string]$_.Path).Equals('msedgedriver.exe',[StringComparison]::OrdinalIgnoreCase) })
    if ($nativeDrivers.Count -ne 1 -or -not ([IO.Path]::GetFullPath([string]$nativeDrivers[0].Path)).Equals([IO.Path]::GetFullPath($EdgeDriverPath),[StringComparison]::OrdinalIgnoreCase)) {
        throw 'tauri-driver did not own exactly the trusted native EdgeDriver executable.'
    }
}

function Invoke-WebDriverScript {
    param([string]$SessionId,[string]$Script,[datetime]$Deadline)
    if ($SessionId -cnotmatch '^[A-Za-z0-9-]+$' -or $Script.Length -gt 8192) { throw 'WebDriver session or script is outside its bounded contract.' }
    $response = Invoke-BoundedLoopbackJson -Method POST -Path "/session/$SessionId/execute/sync" -Body ([ordered]@{ script = $Script; args = @() }) -Deadline $Deadline
    if ($null -eq $response.PSObject.Properties['value']) { throw 'WebDriver script response has no value.' }
    return $response.value
}

function Wait-WebDriverOracle {
    param([string]$SessionId,[string]$Script,[datetime]$Deadline,[scriptblock]$Predicate,[string]$Kind)
    do {
        $value = Invoke-WebDriverScript -SessionId $SessionId -Script $Script -Deadline $Deadline
        if (& $Predicate $value) { return $value }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $Deadline)
    throw "$Kind did not become true before the shared launch deadline."
}

function Get-LaunchProcessSnapshot {
    $names = @('pdf-workstation','tauri-driver','msedgedriver','msedgewebview2')
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $names.Contains($_.ProcessName.ToLowerInvariant()) })
}

function Assert-FixedWebDriverPortsFree {
    $network = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
    $ports = @($script:LaunchPins.WebDriverPort,$script:LaunchPins.NativeDriverPort)
    if (@($network.GetActiveTcpListeners() | Where-Object { $ports.Contains($_.Port) }).Count -ne 0 -or
        @($network.GetActiveTcpConnections() | Where-Object { $ports.Contains($_.LocalEndPoint.Port) -or $ports.Contains($_.RemoteEndPoint.Port) }).Count -ne 0) {
        throw 'A fixed loopback WebDriver port is already in use.'
    }
}

function Get-OwnedLaunchProcesses {
    param([Parameter(Mandatory = $true)][int]$RootProcessId,[Parameter(Mandatory = $true)][datetime]$StartedAfter)
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $owned = [Collections.Generic.HashSet[uint32]]::new()
    $null = $owned.Add([uint32]$RootProcessId)
    do {
        $added = $false
        foreach ($process in $all) {
            if ($owned.Contains([uint32]$process.ParentProcessId) -and $owned.Add([uint32]$process.ProcessId)) { $added = $true }
        }
    } while ($added)
    return @($all | Where-Object { $owned.Contains([uint32]$_.ProcessId) -and [uint32]$_.ProcessId -ne [uint32]$RootProcessId } | ForEach-Object {
        $process = Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
        if ($process.StartTime.ToUniversalTime() -lt $StartedAfter) { throw 'A purported launch descendant predates the owned tauri-driver process.' }
        [pscustomobject]@{ ProcessId = $process.Id; Path = [string]$process.Path; StartTicks = $process.StartTime.ToUniversalTime().Ticks; CommandLine = [string]$_.CommandLine }
    })
}

function Start-BoundedDiscardProcess {
    param([string]$Path,[string[]]$Arguments,[int]$MaximumCharacters = 65536)
    if (-not ('BoundedDiscardProcess' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
public sealed class BoundedDiscardProcess : IDisposable {
  public Process Process { get; }
  private long characters;
  private int exceeded;
  public bool Exceeded { get { return Volatile.Read(ref exceeded) != 0; } }
  private readonly int maximum;
  public BoundedDiscardProcess(string path, string[] arguments, int maximumCharacters) {
    maximum = maximumCharacters;
    var start = new ProcessStartInfo { FileName = path, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var argument in arguments) start.ArgumentList.Add(argument);
    Process = new Process { StartInfo = start };
    DataReceivedEventHandler count = (_, e) => { if (e.Data != null && Interlocked.Add(ref characters, e.Data.Length + 1) > maximum) Interlocked.Exchange(ref exceeded, 1); };
    Process.OutputDataReceived += count;
    Process.ErrorDataReceived += count;
  }
  public void Start() { if (!Process.Start()) throw new InvalidOperationException("Process did not start."); Process.BeginOutputReadLine(); Process.BeginErrorReadLine(); }
  public void Dispose() { Process.Dispose(); }
}
'@
    }
    return [BoundedDiscardProcess]::new($Path, $Arguments, $MaximumCharacters)
}

function Stop-OwnedLaunchProcesses {
    param([Diagnostics.Process]$TauriDriver,[object[]]$Captured)
    if ($null -ne $TauriDriver -and -not $TauriDriver.HasExited) {
        try { $TauriDriver.Kill($true) } catch { }
        try { $TauriDriver.WaitForExit(5000) | Out-Null } catch { }
    }
    foreach ($owned in @($Captured | Sort-Object ProcessId -Descending)) {
        try {
            $process = Get-Process -Id ([int]$owned.ProcessId) -ErrorAction Stop
            $path = [string]$process.Path
            $started = $process.StartTime.ToUniversalTime().Ticks
            if ($path.Equals([string]$owned.Path, [StringComparison]::OrdinalIgnoreCase) -and $started -eq [int64]$owned.StartTicks) {
                $process.Kill($true)
                $process.WaitForExit(5000) | Out-Null
            }
        } catch { }
    }
}

function Invoke-RealInstalledAppLaunch {
    param([string]$ApplicationPath,[string]$TauriDriverPath,[string]$EdgeDriverPath,[string]$ProfileRoot,[string]$ExpectedEdgeDriverVersion)
    $deadline = [datetime]::UtcNow.AddMilliseconds($script:LaunchPins.TotalTimeoutMilliseconds)
    $driverCapture = $null
    $driver = $null
    $sessionId = $null
    $captured = @()
    $startedAfter = [datetime]::UtcNow
    $result = $null
    $sessionDeleted = $false
    $ownedStopped = $false
    $remaining = -1
    try {
        Assert-FixedWebDriverPortsFree
        $driverCapture = Start-BoundedDiscardProcess -Path $TauriDriverPath -Arguments @(
            "--port=$($script:LaunchPins.WebDriverPort)",
            "--native-port=$($script:LaunchPins.NativeDriverPort)",
            "--native-driver=$EdgeDriverPath"
        )
        $driverCapture.Start()
        $driver = $driverCapture.Process
        do {
            try {
                $status = Invoke-BoundedLoopbackJson -Method GET -Path '/status' -Deadline $deadline
                if ($null -ne $status.value -and [bool]$status.value.ready) { break }
            } catch { }
            if ($driver.HasExited) { throw 'Pinned tauri-driver exited before readiness.' }
            Start-Sleep -Milliseconds 200
        } while ([datetime]::UtcNow -lt $deadline)
        if ($null -eq $status -or -not [bool]$status.value.ready) { throw 'Pinned tauri-driver did not become ready.' }
        if ($driver.HasExited) { throw 'Pinned tauri-driver exited after reporting readiness.' }
        $nativeDriverVersion = Wait-NativeDriverStatus -ExpectedVersion $ExpectedEdgeDriverVersion -Deadline $deadline -TauriDriver $driver
        if ($driver.HasExited) { throw 'Pinned tauri-driver exited while binding the native EdgeDriver status.' }

        $sessionBody = [ordered]@{ capabilities = [ordered]@{ alwaysMatch = [ordered]@{
            browserName = 'wry'
            'tauri:options' = [ordered]@{ application = $ApplicationPath; args = @(); webviewOptions = [ordered]@{ userDataFolder = $ProfileRoot } }
        } } }
        $session = Invoke-BoundedLoopbackJson -Method POST -Path '/session' -Body $sessionBody -Deadline $deadline
        if ($null -eq $session.value -or [string]$session.value.sessionId -cnotmatch '^[A-Za-z0-9-]+$') { throw 'WebDriver did not return a bounded session identifier.' }
        if ($driver.HasExited) { throw 'Pinned tauri-driver exited during session creation.' }
        $sessionId = [string]$session.value.sessionId
        $capabilities = $session.value.capabilities
        $capabilityKeys = @($capabilities.PSObject.Properties.Name | Sort-Object -CaseSensitive)
        if ($capabilityKeys.Count -eq 0 -or $capabilityKeys.Count -gt 32 -or @($capabilityKeys | Where-Object { $_ -cnotmatch '^[A-Za-z0-9:._-]{1,64}$' }).Count -ne 0) {
            throw 'WebDriver returned an unsafe capability-key set.'
        }
        $vendorDriverProperty = $capabilities.PSObject.Properties['msedge.msedgedriverVersion']
        if ($null -ne $vendorDriverProperty -and ([string]$vendorDriverProperty.Value -split '\s+')[0] -cne $nativeDriverVersion) {
            throw 'The optional session EdgeDriver version disagrees with the live native status.'
        }
        $returnedRuntimeVersion = [string]$capabilities.browserVersion
        $userDataProperty = $capabilities.PSObject.Properties['msedge.userDataDir']
        $returnedUserData = if ($null -ne $userDataProperty) { [string]$userDataProperty.Value } else { '' }

        $homeScript = "return {ready:document.readyState==='complete',title:document.title,home:[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Explore a sample PDF')};"
        $homeOracle = Wait-WebDriverOracle -SessionId $sessionId -Script $homeScript -Deadline $deadline -Kind 'Home UI' -Predicate { param($v) [bool]$v.ready -and [string]$v.title -ceq 'PDF Workstation' -and [bool]$v.home }
        $ocrScript = "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='All tools');if(b)b.click();const o=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Scan & OCR');const s=o?.nextElementSibling;return {heading:[...document.querySelectorAll('h1')].some(x=>x.textContent.trim()==='All tools'),status:s?.tagName==='SPAN'&&o?.parentElement?.lastElementChild===s?s.textContent.trim():''};"
        $ocr = Wait-WebDriverOracle -SessionId $sessionId -Script $ocrScript -Deadline $deadline -Kind 'Native OCR capability UI' -Predicate { param($v) [bool]$v.heading -and [string]$v.status -ceq 'Available' }
        $homeClick = Invoke-WebDriverScript -SessionId $sessionId -Script "const a=[...document.querySelectorAll('button')].filter(x=>x.getAttribute('aria-label')==='Home'||x.textContent.trim()==='Home');if(a.length===1)a[0].click();return a.length===1;" -Deadline $deadline
        if ($homeClick -isnot [bool] -or -not $homeClick) { throw 'The exact Home control was unavailable.' }
        $null = Wait-WebDriverOracle -SessionId $sessionId -Script "return [...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='Explore a sample PDF');" -Deadline $deadline -Kind 'Home sample control' -Predicate { param($v) $v -is [bool] -and $v }
        $sampleClick = "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Explore a sample PDF');if(b)b.click();return !!b;"
        $clicked = Invoke-WebDriverScript -SessionId $sessionId -Script $sampleClick -Deadline $deadline
        if ($clicked -isnot [bool] -or -not $clicked) { throw 'The installed sample-open button was unavailable.' }
        $sampleScript = @'
const i=document.querySelector('img[alt="Page 1"]');return {tab:[...document.querySelectorAll('button')].some(x=>x.textContent.includes('welcome.pdf')),pages:[...document.querySelectorAll('span')].some(x=>x.textContent.trim()==='/ 6'),footer:[...document.querySelectorAll('footer span')].some(x=>x.textContent.trim()==='welcome.pdf · Source preserved'),image:!!i&&i.complete&&i.naturalWidth>0&&i.naturalHeight>0&&i.src.startsWith('blob:'),width:i?.naturalWidth||0,height:i?.naturalHeight||0};
'@
        $sample = Wait-WebDriverOracle -SessionId $sessionId -Script $sampleScript -Deadline $deadline -Kind 'Installed sample PDF render' -Predicate { param($v) [bool]$v.tab -and [bool]$v.pages -and [bool]$v.footer -and [bool]$v.image -and [int]$v.width -gt 0 -and [int]$v.height -gt 0 }
        $captured = @(Get-OwnedLaunchProcesses -RootProcessId $driver.Id -StartedAfter $startedAfter)
        Assert-OwnedLaunchExecutables -Owned $captured -ApplicationPath $ApplicationPath -EdgeDriverPath $EdgeDriverPath
        $profileBinding = if (-not [string]::IsNullOrWhiteSpace($returnedUserData)) {
            if (-not ([IO.Path]::GetFullPath($returnedUserData).TrimEnd('\')).Equals([IO.Path]::GetFullPath($ProfileRoot).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)) {
                throw 'The session returned a different WebView profile path.'
            }
            'session-capability'
        } else {
            Get-OwnedProfileBinding -Owned $captured -ExpectedProfile $ProfileRoot
        }
        if ($driverCapture.Exceeded) { throw 'WebDriver diagnostic output exceeded its discarded character cap.' }
        $result = [pscustomobject]@{
            nativeDriverVersion = $nativeDriverVersion
            driverVersionBinding = 'native-status'
            returnedRuntimeVersion = $returnedRuntimeVersion
            profileBindingMethod = $profileBinding
            sessionCapabilityKeys = $capabilityKeys
            title = [string]$homeOracle.title
            homeButton = [bool]$homeOracle.home
            ocrCapabilityStatus = [string]$ocr.status
            sampleName = 'welcome.pdf'
            samplePages = 6
            renderedPageWidth = [int]$sample.width
            renderedPageHeight = [int]$sample.height
            renderedPageBlob = [bool]$sample.image
        }
    } finally {
        $cleanupDeadline = [datetime]::UtcNow.AddSeconds(10)
        if ($sessionId) {
            try {
                $delete = Invoke-BoundedLoopbackJson -Method DELETE -Path "/session/$sessionId" -Deadline $cleanupDeadline
                if ($null -ne $delete.PSObject.Properties['value'] -and $null -eq $delete.value) { $sessionDeleted = $true }
            } catch { }
        }
        if ($driver) {
            try { $captured += @(Get-OwnedLaunchProcesses -RootProcessId $driver.Id -StartedAfter $startedAfter) } catch { }
            Stop-OwnedLaunchProcesses -TauriDriver $driver -Captured $captured
            $remaining = @(Get-LaunchProcessSnapshot).Count
            $ownedStopped = $driver.HasExited -and $remaining -eq 0
        }
        if ($driverCapture) { $driverCapture.Dispose() }
    }
    if ($null -eq $result -or -not $sessionDeleted -or -not $ownedStopped -or $remaining -ne 0) {
        throw 'Installed application launch cleanup did not delete the session and stop the owned process tree.'
    }
    $result | Add-Member -NotePropertyName sessionDeleted -NotePropertyValue $sessionDeleted
    $result | Add-Member -NotePropertyName ownedProcessTreeStopped -NotePropertyValue $ownedStopped
    $result | Add-Member -NotePropertyName relevantProcessesRemaining -NotePropertyValue $remaining
    return $result
}

function Invoke-InstalledAppLaunchSmoke {
    param(
        [Parameter(Mandatory = $true)][string]$ApplicationPath,
        [Parameter(Mandatory = $true)]$ApplicationReceipt,
        [Parameter(Mandatory = $true)][string]$WebDriverRoot,
        [Parameter(Mandatory = $true)][string]$ProfileRoot,
        [Parameter(Mandatory = $true)][string]$RunnerTemp,
        [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
        [scriptblock]$ProcessProvider
    )
    $runner = [IO.Path]::GetFullPath($RunnerTemp).TrimEnd('\')
    $driverRoot = [IO.Path]::GetFullPath($WebDriverRoot).TrimEnd('\')
    $profile = [IO.Path]::GetFullPath($ProfileRoot).TrimEnd('\')
    foreach ($candidate in @($driverRoot,$profile)) {
        if (-not $candidate.StartsWith($runner + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Launch-smoke paths must stay beneath RUNNER_TEMP.' }
        Assert-NoReparseAncestors -Path $candidate
    }
    if (-not (Test-Path -LiteralPath $driverRoot -PathType Container) -or (Test-Path -LiteralPath $profile)) { throw 'WebDriver inputs must exist and the WebView profile must be fresh.' }
    $ambient = @(Get-LaunchProcessSnapshot)
    if ($ambient.Count -ne 0) { throw 'The hosted runner already has an application or WebDriver process.' }
    $receiptPath = Join-Path $driverRoot 'webdriver-receipt.json'
    Assert-NoReparseAncestors -Path $receiptPath
    $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-WebDriverReceipt -Receipt $receipt
    $tauriDriver = Join-Path $driverRoot 'tauri-driver-install/bin/tauri-driver.exe'
    $edgeDriver = Join-Path $driverRoot 'edge-driver/msedgedriver.exe'
    Assert-FileReceipt -Path $ApplicationPath -Bytes ([uint64]$ApplicationReceipt.bytes) -Sha256 ([string]$ApplicationReceipt.sha256) -Kind 'Installed signed launch application'
    $null = Assert-TrustedWindowsSignature -Path $ApplicationPath -ExpectedPublisher $ExpectedPublisher
    Assert-FileReceipt -Path $tauriDriver -Bytes ([uint64]$receipt.tauriDriver.bytes) -Sha256 ([string]$receipt.tauriDriver.sha256) -Kind 'Pinned tauri-driver executable'
    Assert-FileReceipt -Path $edgeDriver -Bytes ([uint64]$receipt.edgeDriver.bytes) -Sha256 ([string]$receipt.edgeDriver.sha256) -Kind 'Exact EdgeDriver executable'
    $null = Assert-TrustedWindowsSignature -Path $edgeDriver -ExpectedPublisher $script:LaunchPins.EdgePublisher
    [IO.Directory]::CreateDirectory($profile) | Out-Null
    Assert-NoReparseAncestors -Path $profile
    $expectedEdgeDriverVersion = [string]$receipt.edgeDriver.version
    $result = if ($ProcessProvider) { & $ProcessProvider $ApplicationPath $tauriDriver $edgeDriver $profile $expectedEdgeDriverVersion } else { Invoke-RealInstalledAppLaunch -ApplicationPath $ApplicationPath -TauriDriverPath $tauriDriver -EdgeDriverPath $edgeDriver -ProfileRoot $profile -ExpectedEdgeDriverVersion $expectedEdgeDriverVersion }
    Assert-LaunchExactProperties -Value $result -Expected @('nativeDriverVersion','driverVersionBinding','returnedRuntimeVersion','profileBindingMethod','sessionCapabilityKeys','title','homeButton','ocrCapabilityStatus','sampleName','samplePages','renderedPageWidth','renderedPageHeight','renderedPageBlob','sessionDeleted','ownedProcessTreeStopped','relevantProcessesRemaining') -Kind 'Installed application launch result'
    $returnedRuntimeParts = ([string]$result.returnedRuntimeVersion).Split('.')
    $expectedRuntimeParts = ([string]$receipt.webView2RuntimeVersion).Split('.')
    $capabilityKeys = @($result.sessionCapabilityKeys)
    if ([string]$result.nativeDriverVersion -cne $expectedEdgeDriverVersion -or [string]$result.driverVersionBinding -cne 'native-status' -or
        $returnedRuntimeParts.Count -ne 4 -or ($returnedRuntimeParts[0..2] -join '.') -cne ($expectedRuntimeParts[0..2] -join '.') -or
        @('session-capability','owned-webview-command-line') -cnotcontains [string]$result.profileBindingMethod -or
        $capabilityKeys.Count -eq 0 -or $capabilityKeys.Count -gt 32 -or @($capabilityKeys | Where-Object { $_ -cnotmatch '^[A-Za-z0-9:._-]{1,64}$' }).Count -ne 0 -or
        [string]$result.title -cne 'PDF Workstation' -or $result.homeButton -isnot [bool] -or -not $result.homeButton -or
        [string]$result.ocrCapabilityStatus -cne 'Available' -or [string]$result.sampleName -cne 'welcome.pdf' -or
        [int]$result.samplePages -ne 6 -or [int]$result.renderedPageWidth -le 0 -or [int]$result.renderedPageHeight -le 0 -or
        $result.renderedPageBlob -isnot [bool] -or -not $result.renderedPageBlob -or
        $result.sessionDeleted -isnot [bool] -or -not $result.sessionDeleted -or
        $result.ownedProcessTreeStopped -isnot [bool] -or -not $result.ownedProcessTreeStopped -or [int]$result.relevantProcessesRemaining -ne 0) {
        throw 'Installed application launch result did not match its exact native IPC and rendered-sample oracles.'
    }
    if (@(Get-LaunchProcessSnapshot).Count -ne 0) { throw 'Installed application launch cleanup left a relevant process running.' }
    return [ordered]@{
        drivers = [ordered]@{
            tauriDriver = [ordered]@{ version = $script:LaunchPins.TauriDriverVersion; bytes = [uint64]$receipt.tauriDriver.bytes; sha256 = [string]$receipt.tauriDriver.sha256; sourceSha256 = $script:LaunchPins.TauriDriverPackageSha256 }
            webView2RuntimeVersion = [string]$receipt.webView2RuntimeVersion
            testedSessionRuntimeVersion = [string]$result.returnedRuntimeVersion
            edgeDriver = [ordered]@{ version = [string]$receipt.edgeDriver.version; bytes = [uint64]$receipt.edgeDriver.bytes; sha256 = [string]$receipt.edgeDriver.sha256; publisher = $script:LaunchPins.EdgePublisher; trustedTimestamp = $true; versionBinding = 'native-status' }
            sessionCapabilityKeys = $capabilityKeys
        }
        profile = [ordered]@{ state = 'fresh-runner-owned'; binding = [string]$result.profileBindingMethod }
        title = 'PDF Workstation'
        homeButton = 'Explore a sample PDF'
        ocrCapabilityStatus = 'Available'
        sample = [ordered]@{ name = 'welcome.pdf'; pages = 6; firstPageDecoded = $true; naturalWidth = [int]$result.renderedPageWidth; naturalHeight = [int]$result.renderedPageHeight; source = 'blob:' }
        cleanup = [ordered]@{ sessionDeleted = $true; ownedProcessTreeStopped = $true; relevantProcessesRemaining = 0 }
    }
}
