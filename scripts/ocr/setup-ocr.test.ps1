[CmdletBinding()]
param(
    [Parameter(Mandatory, HelpMessage = 'Choose a new retained directory beneath target for this control run.')]
    [string] $EvidenceRoot,
    [Parameter(Mandatory, HelpMessage = 'Provide a completed setup-ocr.ps1 output root whose manifest binds the current setup script.')]
    [string] $VerifiedRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$setupPath = Join-Path $repoRoot 'scripts\setup-ocr.ps1'
$pwshPath = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop).Source

function Resolve-RepoPath([string] $Path) {
    if ([IO.Path]::IsPathFullyQualified($Path)) {
        return [IO.Path]::GetFullPath($Path)
    }
    return [IO.Path]::GetFullPath((Join-Path $repoRoot $Path))
}

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-SetupExpectFailure([string] $OutputRoot) {
    $output = & $pwshPath -NoProfile -File $setupPath -OutputRoot $OutputRoot -Jobs 1 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        throw "Setup unexpectedly accepted OutputRoot '$OutputRoot'."
    }
    return [ordered]@{
        exitCode = $exitCode
        output = $output.Trim()
    }
}

function Import-SetupFunction([Management.Automation.Language.ScriptBlockAst] $Ast, [string] $Name) {
    $functionAst = @($Ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
    }, $true))
    if ($functionAst.Count -ne 1) {
        throw "Expected one setup function named '$Name', found $($functionAst.Count)."
    }
    $definition = $functionAst[0].Extent.Text
    $scopedDefinition = $definition -replace '^function\s+[^\s({]+', "function global:$Name"
    Invoke-Expression $scopedDefinition
}

function Assert-ProcessGone([string] $PidPath) {
    Assert-True (Test-Path -LiteralPath $PidPath -PathType Leaf) "Child PID receipt is missing: $PidPath"
    $childPid = [int][IO.File]::ReadAllText($PidPath)
    Start-Sleep -Milliseconds 100
    $remaining = Get-Process -Id $childPid -ErrorAction SilentlyContinue
    Assert-True ($null -eq $remaining) "Child process $childPid was not reaped."
}

function New-TestZip {
    param(
        [Parameter(Mandatory)]
        [string] $Path,
        [Parameter(Mandatory)]
        [ValidateSet('Traversal', 'Link', 'Oversize')]
        [string] $Kind
    )
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        if ($Kind -eq 'Traversal') {
            $entry = $zip.CreateEntry('cmake-prefix/../escape.txt')
            $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
            try {
                $writer.Write('escape')
            } finally {
                $writer.Dispose()
            }
        } elseif ($Kind -eq 'Link') {
            $entry = $zip.CreateEntry('cmake-prefix/link')
            $linkAttributes = [uint32]::Parse('A0000000', [Globalization.NumberStyles]::HexNumber)
            $entry.ExternalAttributes = [BitConverter]::ToInt32([BitConverter]::GetBytes($linkAttributes), 0)
        } else {
            $entry = $zip.CreateEntry('cmake-prefix/data.bin', [IO.Compression.CompressionLevel]::NoCompression)
            $entryStream = $entry.Open()
            try {
                $bytes = [byte[]]::new(2048)
                $entryStream.Write($bytes, 0, $bytes.Length)
            } finally {
                $entryStream.Dispose()
            }
        }
    } finally {
        $zip.Dispose()
        $stream.Dispose()
    }
}

$evidenceRoot = Resolve-RepoPath $EvidenceRoot
$verifiedRoot = Resolve-RepoPath $VerifiedRoot
$targetRoot = Join-Path $repoRoot 'target'
$targetPrefix = [IO.Path]::GetFullPath($targetRoot).TrimEnd('\') + '\'
Assert-True ($evidenceRoot.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) 'EvidenceRoot must be beneath target.'
Assert-True (-not (Test-Path -LiteralPath $evidenceRoot)) "EvidenceRoot already exists: $evidenceRoot"
Assert-True (Test-Path -LiteralPath $verifiedRoot -PathType Container) "VerifiedRoot does not exist: $verifiedRoot"
[IO.Directory]::CreateDirectory($evidenceRoot) | Out-Null

$verifiedManifestPath = Join-Path $verifiedRoot 'engine\ocr-engine-manifest.json'
$verifiedManifest = Get-Content -Raw -LiteralPath $verifiedManifestPath | ConvertFrom-Json
$verifiedSetupReceipt = @($verifiedManifest.artifacts.recipeInputs | Where-Object path -eq 'scripts/setup-ocr.ps1')
Assert-True ($verifiedSetupReceipt.Count -eq 1) 'Verified manifest has no unique setup-script receipt.'
$currentSetupHash = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash
$currentSetupBytes = (Get-Item -LiteralPath $setupPath).Length
Assert-True ($currentSetupHash -eq $verifiedSetupReceipt[0].sha256) 'Current setup script hash differs from the verified build receipt.'
Assert-True ($currentSetupBytes -eq $verifiedSetupReceipt[0].bytes) 'Current setup script length differs from the verified build receipt.'

$setupSource = Get-Content -Raw -LiteralPath $setupPath
$tokens = $null
$errors = $null
$setupAst = [Management.Automation.Language.Parser]::ParseFile($setupPath, [ref]$tokens, [ref]$errors)
Assert-True ($errors.Count -eq 0) 'The setup script did not parse cleanly.'
$typeMatch = [regex]::Match(
    $setupSource,
    "(?s)Add-Type -TypeDefinition @'\r?\n(?<source>.*?)\r?\n'@"
)
Assert-True $typeMatch.Success 'Could not locate the bounded-process type in setup-ocr.ps1.'
Add-Type -TypeDefinition $typeMatch.Groups['source'].Value
foreach ($name in @(
    'Add-SetupLog',
    'Assert-ContainedPath',
    'Assert-FileHashAndSize',
    'Assert-SafeArchiveName',
    'Expand-PinnedZip'
)) {
    Import-SetupFunction $setupAst $name
}

$results = [ordered]@{
    schemaVersion = 1
    setupScript = [ordered]@{
        path = 'scripts/setup-ocr.ps1'
        bytes = $currentSetupBytes
        sha256 = $currentSetupHash
        matchesVerifiedManifest = $true
    }
    testScript = [ordered]@{
        path = 'scripts/ocr/setup-ocr.test.ps1'
        bytes = (Get-Item -LiteralPath $PSCommandPath).Length
        sha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
    }
    controls = [ordered]@{}
}

$outsidePath = Join-Path $repoRoot 'ocr-outside-negative-control-20260924'
Assert-True (-not (Test-Path -LiteralPath $outsidePath)) 'Outside-target control path already exists.'
$outside = Invoke-SetupExpectFailure $outsidePath
Assert-True (-not (Test-Path -LiteralPath $outsidePath)) 'Outside-target refusal created its requested root.'
$results.controls.outsideTarget = [ordered]@{
    exitCode = $outside.exitCode
    rootCreated = $false
    output = $outside.output
}

$existingRoot = Join-Path $evidenceRoot 'existing-root'
$existingLogDirectory = Join-Path $existingRoot 'logs'
[IO.Directory]::CreateDirectory($existingLogDirectory) | Out-Null
$existingLog = Join-Path $existingLogDirectory 'setup.log'
[IO.File]::WriteAllText($existingLog, 'sentinel setup log', [Text.UTF8Encoding]::new($false))
$existingBefore = (Get-FileHash -LiteralPath $existingLog -Algorithm SHA256).Hash
$existing = Invoke-SetupExpectFailure $existingRoot
$existingAfter = (Get-FileHash -LiteralPath $existingLog -Algorithm SHA256).Hash
Assert-True ($existingBefore -eq $existingAfter) 'Existing-root refusal changed its setup log.'
$results.controls.existingRoot = [ordered]@{
    exitCode = $existing.exitCode
    logSha256Before = $existingBefore
    logSha256After = $existingAfter
    unchanged = $true
    output = $existing.output
}

$verifiedLog = Join-Path $verifiedRoot 'logs\setup.log'
$verifiedBefore = (Get-FileHash -LiteralPath $verifiedLog -Algorithm SHA256).Hash
$verified = Invoke-SetupExpectFailure $verifiedRoot
$verifiedAfter = (Get-FileHash -LiteralPath $verifiedLog -Algorithm SHA256).Hash
Assert-True ($verifiedBefore -eq $verifiedAfter) 'Verified existing-root refusal changed its final setup log.'
$results.controls.verifiedRoot = [ordered]@{
    exitCode = $verified.exitCode
    logSha256Before = $verifiedBefore
    logSha256After = $verifiedAfter
    unchanged = $true
}

$junctionDestination = Join-Path $evidenceRoot 'junction-destination'
$junctionPath = Join-Path $evidenceRoot 'junction-link'
[IO.Directory]::CreateDirectory($junctionDestination) | Out-Null
New-Item -ItemType Junction -Path $junctionPath -Target $junctionDestination | Out-Null
$junctionChild = Join-Path $junctionDestination 'should-not-exist'
$junction = Invoke-SetupExpectFailure (Join-Path $junctionPath 'should-not-exist')
Assert-True (-not (Test-Path -LiteralPath $junctionChild)) 'Junction refusal created a child before rejection.'
$results.controls.junction = [ordered]@{
    exitCode = $junction.exitCode
    childCreated = $false
    linkType = (Get-Item -LiteralPath $junctionPath).LinkType
    output = $junction.output
}

$sanitizedVariables = @(
    'CC', 'CL', '_CL_', 'CFLAGS', 'CPPFLAGS', 'CXX', 'CXXFLAGS', 'LDFLAGS',
    'CMAKE_GENERATOR', 'CMAKE_GENERATOR_INSTANCE', 'CMAKE_GENERATOR_PLATFORM',
    'CMAKE_GENERATOR_TOOLSET', 'CMAKE_PREFIX_PATH', 'CMAKE_TOOLCHAIN_FILE',
    'VCPKG_FEATURE_FLAGS', 'VCPKG_ROOT'
)

$stdoutPid = Join-Path $evidenceRoot 'stdout-child.pid'
$stdoutPidLiteral = $stdoutPid.Replace("'", "''")
$stdoutScript = "[IO.File]::WriteAllText('$stdoutPidLiteral',[string]`$PID); [Console]::Out.Write('x' * 1048576)"
$stdoutResult = [OcrBoundedProcess]::Run(
    $pwshPath,
    @('-NoProfile', '-Command', $stdoutScript),
    $repoRoot,
    $sanitizedVariables,
    5000,
    4096,
    4096,
    $null
)
Assert-True $stdoutResult.StdoutExceeded 'Fast-exit stdout overflow was not detected.'
Assert-True ($stdoutResult.Stdout.Length -le 4096) 'Stdout capture exceeded its configured cap.'
Assert-ProcessGone $stdoutPid
$results.controls.stdoutCapRace = [ordered]@{
    exceeded = $stdoutResult.StdoutExceeded
    capturedCharacters = $stdoutResult.Stdout.Length
    exitCode = $stdoutResult.ExitCode
    reaped = $true
}

$stderrPid = Join-Path $evidenceRoot 'stderr-child.pid'
$stderrPidLiteral = $stderrPid.Replace("'", "''")
$stderrScript = "[IO.File]::WriteAllText('$stderrPidLiteral',[string]`$PID); [Console]::Error.Write('e' * 1048576)"
$stderrResult = [OcrBoundedProcess]::Run(
    $pwshPath,
    @('-NoProfile', '-Command', $stderrScript),
    $repoRoot,
    $sanitizedVariables,
    5000,
    4096,
    4096,
    $null
)
Assert-True $stderrResult.StderrExceeded 'Fast-exit stderr overflow was not detected.'
Assert-True ($stderrResult.Stderr.Length -le 4096) 'Stderr capture exceeded its configured cap.'
Assert-ProcessGone $stderrPid
$results.controls.stderrCapRace = [ordered]@{
    exceeded = $stderrResult.StderrExceeded
    capturedCharacters = $stderrResult.Stderr.Length
    exitCode = $stderrResult.ExitCode
    reaped = $true
}

$timeoutPid = Join-Path $evidenceRoot 'timeout-child.pid'
$timeoutPidLiteral = $timeoutPid.Replace("'", "''")
$timeoutScript = "[IO.File]::WriteAllText('$timeoutPidLiteral',[string]`$PID); Start-Sleep -Seconds 30"
$timeoutResult = [OcrBoundedProcess]::Run(
    $pwshPath,
    @('-NoProfile', '-Command', $timeoutScript),
    $repoRoot,
    $sanitizedVariables,
    1500,
    4096,
    4096,
    $null
)
Assert-True $timeoutResult.TimedOut 'Timeout child was not reported as timed out.'
Assert-ProcessGone $timeoutPid
$results.controls.timeout = [ordered]@{
    timedOut = $timeoutResult.TimedOut
    elapsedMilliseconds = $timeoutResult.ElapsedMilliseconds
    reaped = $true
}

$tamperedPath = Join-Path $evidenceRoot 'tampered-download.bin'
[IO.File]::WriteAllBytes($tamperedPath, [Text.Encoding]::ASCII.GetBytes('evil'))
$expectedGoodHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::ASCII.GetBytes('good')))
$hashRejected = $false
try {
    Assert-FileHashAndSize $tamperedPath 4 $expectedGoodHash
} catch {
    $hashError = $_.Exception.Message
    Assert-True ($hashError -match 'SHA-256 mismatch') 'Tampered-file helper failed for an unexpected reason.'
    $hashRejected = $true
}
Assert-True $hashRejected 'A same-length tampered file passed hash verification.'
$results.controls.tamperedHashHelper = [ordered]@{
    bytes = 4
    expectedSha256 = $expectedGoodHash
    actualSha256 = (Get-FileHash -LiteralPath $tamperedPath -Algorithm SHA256).Hash
    rejected = $true
    output = $hashError
}

$script:logPath = Join-Path $evidenceRoot 'archive-controls.log'
[IO.File]::WriteAllText($script:logPath, '', [Text.UTF8Encoding]::new($false))
$script:maxExpandedArchiveBytes = 1GB

$traversalZip = Join-Path $evidenceRoot 'traversal.zip'
$traversalDestination = Join-Path $evidenceRoot 'traversal-output'
[IO.Directory]::CreateDirectory($traversalDestination) | Out-Null
New-TestZip $traversalZip Traversal
$traversalRejected = $false
try {
    Expand-PinnedZip $traversalZip $traversalDestination 'cmake-prefix/'
} catch {
    $traversalRejected = $true
    $traversalError = $_.Exception.Message
}
Assert-True $traversalRejected 'ZIP traversal entry was accepted.'
Assert-True ($traversalError -match 'unsafe path segment') 'ZIP traversal failed for an unexpected reason.'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $evidenceRoot 'escape.txt'))) 'ZIP traversal wrote outside its destination.'

$linkZip = Join-Path $evidenceRoot 'link.zip'
$linkDestination = Join-Path $evidenceRoot 'link-output'
[IO.Directory]::CreateDirectory($linkDestination) | Out-Null
New-TestZip $linkZip Link
$linkRejected = $false
try {
    Expand-PinnedZip $linkZip $linkDestination 'cmake-prefix/'
} catch {
    $linkRejected = $true
    $linkError = $_.Exception.Message
}
Assert-True $linkRejected 'ZIP link entry was accepted.'
Assert-True ($linkError -match 'ZIP link entries are not accepted') 'ZIP link failed for an unexpected reason.'

$oversizeZip = Join-Path $evidenceRoot 'oversize.zip'
$oversizeDestination = Join-Path $evidenceRoot 'oversize-output'
[IO.Directory]::CreateDirectory($oversizeDestination) | Out-Null
New-TestZip $oversizeZip Oversize
$script:maxExpandedArchiveBytes = 1024
$archiveCapRejected = $false
try {
    Expand-PinnedZip $oversizeZip $oversizeDestination 'cmake-prefix/'
} catch {
    $archiveCapRejected = $true
    $archiveCapError = $_.Exception.Message
}
Assert-True $archiveCapRejected 'ZIP expanded-byte cap was not enforced.'
Assert-True ($archiveCapError -match 'expanded data exceeds') 'ZIP expanded-byte cap failed for an unexpected reason.'
$results.controls.archiveGuards = [ordered]@{
    scope = 'Exact ZIP helper runtime controls; tar type/path checks are source-inspected only.'
    traversalRejected = $true
    traversalOutput = $traversalError
    linkRejected = $true
    linkOutput = $linkError
    expandedByteCapRejected = $true
    expandedByteCapOutput = $archiveCapError
}

$verifiedLogText = Get-Content -Raw -LiteralPath $verifiedLog
$exactSmokeStageCount = [regex]::Matches($verifiedLogText, '===== Exact OCR smoke =====').Count
Assert-True $verifiedManifest.verification.oversizeRejectedBeforeSpawn 'Verified manifest lacks the oversize pre-spawn result.'
Assert-True ($verifiedManifest.verification.oversizeInput.bytes -eq 16777217) 'Verified oversize control has the wrong byte length.'
Assert-True ($exactSmokeStageCount -eq 1) 'Verified log should contain one OCR process stage; oversize control may have spawned.'
$results.controls.oversizePnm = [ordered]@{
    bytes = [long]$verifiedManifest.verification.oversizeInput.bytes
    rejectedBeforeSpawn = $true
    exactOcrProcessStagesInFinalLog = $exactSmokeStageCount
    finalLogSha256 = (Get-FileHash -LiteralPath $verifiedLog -Algorithm SHA256).Hash
}

$resultPath = Join-Path $evidenceRoot 'negative-controls.json'
$json = $results | ConvertTo-Json -Depth 7
$stream = [IO.File]::Open($resultPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + [Environment]::NewLine)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
} finally {
    $stream.Dispose()
}

Write-Output 'OCR setup negative controls passed.'
Write-Output "Receipt: $resultPath"
Write-Output "SHA-256: $((Get-FileHash -LiteralPath $resultPath -Algorithm SHA256).Hash)"
