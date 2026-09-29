[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BaselineInstaller,
    [Parameter(Mandatory = $true)][string]$SignedArtifactRoot,
    [Parameter(Mandatory = $true)][string]$WorkRoot,
    [Parameter(Mandatory = $true)][string]$OutputRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'ocr/installer-package.ps1')
. (Join-Path $PSScriptRoot 'ocr/windows-signing.ps1')

$script:Pins = [ordered]@{
    Repository = 'Joshua-Beel/Smacrobat'
    BaselineAssetId = [uint64]569181842
    BaselineName = 'PDF.Workstation_0.2.0_x64-setup.exe'
    BaselineBytes = [uint64]6418229
    BaselineSha256 = '17788CB82BB42DEAC35EA197A385A9BAFC8CD331422446A2B834E115A90C4D2E'
    SignedArtifactId = [uint64]11005152678
    SignedRunId = [uint64]36499724415
    SignedSourceRevision = '67d238218f4796ba7b8505d072868da0f397174a'
    SignedInstallerName = 'PDF Workstation_0.2.6_x64-setup.exe'
    SignedInstallerBytes = [uint64]10456616
    SignedInstallerSha256 = '8F7A167D1AED369D1A28B7C91692BAD8770E774FE9D8AFBBED970654144E428C'
    SignedRecordName = 'artifact-verification.json'
    SignedRecordBytes = [uint64]7386
    SignedRecordSha256 = '4ED82057155877F2677262479FF4F2B00398CF5F524C51302DB50275D315E205'
    ExpectedPublisher = 'Joshua Beel'
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Kind
    )
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $wanted = @($Expected | Sort-Object -CaseSensitive)
    if ($actual.Count -ne $wanted.Count -or (Compare-Object $wanted $actual -CaseSensitive)) {
        throw "$Kind has an unexpected or missing property."
    }
}

function Assert-FileReceipt {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][uint64]$Bytes,
        [Parameter(Mandatory = $true)][string]$Sha256,
        [Parameter(Mandatory = $true)][string]$Kind
    )
    Assert-NoReparseAncestors -Path $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Kind is missing." }
    $item = Get-Item -LiteralPath $Path
    if ([uint64]$item.Length -ne $Bytes -or (Get-ExactSha256 -Path $Path) -cne $Sha256) {
        throw "$Kind does not match its pinned byte and SHA-256 receipt."
    }
}

function Resolve-RunnerPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RunnerTemp,
        [switch]$MustExist,
        [switch]$MustBeFresh
    )
    $root = [IO.Path]::GetFullPath($RunnerTemp).TrimEnd('\')
    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $candidate.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Upgrade verification paths must stay beneath RUNNER_TEMP.'
    }
    Assert-NoReparseAncestors -Path $candidate
    if ($MustExist -and -not (Test-Path -LiteralPath $candidate)) { throw 'A required runner input path is missing.' }
    if ($MustBeFresh -and (Test-Path -LiteralPath $candidate)) { throw 'A runner proof path was not fresh.' }
    return $candidate
}

function Assert-HostedRunnerFacts {
    param([Parameter(Mandatory = $true)]$Facts)
    Assert-ExactProperties -Value $Facts -Expected @(
        'githubActions','runnerEnvironment','runnerOs','imageOs','eventName','ref','repository',
        'githubSha','headSha','trackedClean','indexClean','githubTokenPresent','ghTokenPresent',
        'ambientSigningConfigurationPresent'
    ) -Kind 'Hosted runner facts'
    if ([string]$Facts.githubActions -cne 'true' -or
        [string]$Facts.runnerEnvironment -cne 'github-hosted' -or
        [string]$Facts.runnerOs -cne 'Windows' -or
        [string]$Facts.imageOs -cne 'win22' -or
        [string]$Facts.eventName -cne 'workflow_dispatch' -or
        [string]$Facts.ref -cne 'refs/heads/master' -or
        [string]$Facts.repository -cne $script:Pins.Repository -or
        [string]$Facts.githubSha -cnotmatch '^[a-f0-9]{40}$' -or
        [string]$Facts.headSha -cne [string]$Facts.githubSha -or
        $Facts.trackedClean -isnot [bool] -or -not $Facts.trackedClean -or
        $Facts.indexClean -isnot [bool] -or -not $Facts.indexClean -or
        $Facts.githubTokenPresent -isnot [bool] -or $Facts.githubTokenPresent -or
        $Facts.ghTokenPresent -isnot [bool] -or $Facts.ghTokenPresent -or
        $Facts.ambientSigningConfigurationPresent -isnot [bool] -or $Facts.ambientSigningConfigurationPresent) {
        throw 'Upgrade verification is restricted to an exact clean GitHub-hosted Windows 2022 manual master run without signing credentials.'
    }
}

function Get-HostedRunnerFacts {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $head = (& git -C $ProjectRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the checked-out HEAD.' }
    & git -C $ProjectRoot diff --quiet --
    $trackedClean = $LASTEXITCODE -eq 0
    & git -C $ProjectRoot diff --cached --quiet --
    $indexClean = $LASTEXITCODE -eq 0
    $ambientNames = @(
        'AZURE_TENANT_ID','AZURE_CLIENT_ID','AZURE_CLIENT_SECRET','AZURE_SIGNING_ENDPOINT',
        'AZURE_SIGNING_ACCOUNT','AZURE_SIGNING_PROFILE','TAURI_SIGNING_PRIVATE_KEY',
        'TAURI_SIGNING_PRIVATE_KEY_PASSWORD','PDF_WORKSTATION_OCR_SETUP_ROOT',
        'PDF_WORKSTATION_EXPECTED_PUBLISHER'
    )
    $ambient = @($ambientNames | Where-Object { -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($_)) }).Count -ne 0
    return [pscustomobject]@{
        githubActions = $env:GITHUB_ACTIONS
        runnerEnvironment = $env:RUNNER_ENVIRONMENT
        runnerOs = $env:RUNNER_OS
        imageOs = $env:ImageOS
        eventName = $env:GITHUB_EVENT_NAME
        ref = $env:GITHUB_REF
        repository = $env:GITHUB_REPOSITORY
        githubSha = $env:GITHUB_SHA
        headSha = $head
        trackedClean = $trackedClean
        indexClean = $indexClean
        githubTokenPresent = -not [string]::IsNullOrEmpty($env:GITHUB_TOKEN)
        ghTokenPresent = -not [string]::IsNullOrEmpty($env:GH_TOKEN)
        ambientSigningConfigurationPresent = $ambient
    }
}

function Assert-FreshInstallFacts {
    param([Parameter(Mandatory = $true)]$Facts)
    Assert-ExactProperties -Value $Facts -Expected @('registryPresent','installRootPresent','settingsRootPresent','applicationProcessPresent','installerProcessPresent') -Kind 'Fresh runner install facts'
    foreach ($name in $Facts.PSObject.Properties.Name) {
        if ($Facts.$name -isnot [bool] -or $Facts.$name) { throw 'The GitHub-hosted runner is not fresh for current-user installer verification.' }
    }
}

function Get-ConflictingProcessFacts {
    param([string[]]$InstallerPaths)
    $appPresent = $false
    $installerPresent = $false
    foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
        if ($process.ProcessName.Equals('pdf-workstation', [StringComparison]::OrdinalIgnoreCase)) { $appPresent = $true }
        try {
            $processPath = [string]$process.Path
            if ($processPath -and @($InstallerPaths | Where-Object { $processPath.Equals([IO.Path]::GetFullPath($_), [StringComparison]::OrdinalIgnoreCase) }).Count -ne 0) {
                $installerPresent = $true
            }
        } catch { }
    }
    return [pscustomobject]@{ applicationProcessPresent = $appPresent; installerProcessPresent = $installerPresent }
}

function Get-FreshInstallFacts {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$SettingsRoot,
        [Parameter(Mandatory = $true)][string]$RegistryPath,
        [Parameter(Mandatory = $true)][string[]]$InstallerPaths
    )
    $processes = Get-ConflictingProcessFacts -InstallerPaths $InstallerPaths
    return [pscustomobject]@{
        registryPresent = Test-Path -LiteralPath $RegistryPath
        installRootPresent = Test-Path -LiteralPath $InstallRoot
        settingsRootPresent = Test-Path -LiteralPath $SettingsRoot
        applicationProcessPresent = [bool]$processes.applicationProcessPresent
        installerProcessPresent = [bool]$processes.installerProcessPresent
    }
}

function Assert-ReceiptValue {
    param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$Kind)
    if ([uint64]$Value.bytes -eq 0 -or [string]$Value.sha256 -cnotmatch '^[A-F0-9]{64}$') {
        throw "$Kind has an invalid receipt."
    }
}

function Assert-SignedArtifactReceipt {
    param([Parameter(Mandatory = $true)]$Receipt)
    Assert-ExactProperties -Value $Receipt -Expected @('schemaVersion','scope','mode','sourceRevision','installer','packagedApplication','baseResources','ocr','signatures','verification') -Kind 'Signed artifact record'
    if ($Receipt.schemaVersion -ne 1 -or
        [string]$Receipt.scope -cne 'Manual artifact-only signed OCR installer verification; no installation, launch, update, or release behavior is established.' -or
        [string]$Receipt.mode -cne 'azure-signed-artifact-only-ocr' -or
        [string]$Receipt.sourceRevision -cne $script:Pins.SignedSourceRevision) {
        throw 'Signed artifact record scope or source revision is unsupported.'
    }
    Assert-ExactProperties -Value $Receipt.installer -Expected @('fileName','bytes','sha256') -Kind 'Signed installer record'
    if ([string]$Receipt.installer.fileName -cne $script:Pins.SignedInstallerName -or
        [uint64]$Receipt.installer.bytes -ne $script:Pins.SignedInstallerBytes -or
        [string]$Receipt.installer.sha256 -cne $script:Pins.SignedInstallerSha256) {
        throw 'Signed installer record does not match the pinned artifact.'
    }
    Assert-ExactProperties -Value $Receipt.packagedApplication -Expected @('bytes','sha256') -Kind 'Packaged application record'
    Assert-ReceiptValue -Value $Receipt.packagedApplication -Kind 'Packaged application'

    $base = @($Receipt.baseResources)
    if ($base.Count -ne 26) { throw 'Signed artifact record must contain exactly 26 base resources.' }
    $baseTargets = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $pdfium = @()
    foreach ($entry in $base) {
        $hasUnsigned = $null -ne $entry.PSObject.Properties['unsignedSha256']
        Assert-ExactProperties -Value $entry -Expected $(if ($hasUnsigned) { @('target','bytes','sha256','unsignedBytes','unsignedSha256') } else { @('target','bytes','sha256') }) -Kind 'Base resource record'
        Assert-ReceiptValue -Value $entry -Kind 'Base resource'
        $target = [string]$entry.target
        if ($target -cnotmatch '^resources/[A-Za-z0-9._/-]+$' -or $target.Contains('..') -or -not $baseTargets.Add($target)) {
            throw 'Base resource target is unsafe or duplicated.'
        }
        if ($target -ceq 'resources/pdfium/bin/pdfium.dll') {
            if (-not $hasUnsigned -or [uint64]$entry.unsignedBytes -eq 0 -or [string]$entry.unsignedSha256 -cnotmatch '^[A-F0-9]{64}$') {
                throw 'Signed PDFium record is incomplete.'
            }
            $pdfium += $entry
        } elseif ($hasUnsigned) {
            throw 'Only PDFium may contain an unsigned receipt.'
        }
    }
    if ($pdfium.Count -ne 1) { throw 'Signed PDFium record is not unique.' }

    Assert-ExactProperties -Value $Receipt.ocr -Expected @('originalEngine','packagedResources','licensesArePackagedSidecarsNotNoticeDialogContent') -Kind 'OCR record'
    if ($Receipt.ocr.licensesArePackagedSidecarsNotNoticeDialogContent -isnot [bool] -or -not $Receipt.ocr.licensesArePackagedSidecarsNotNoticeDialogContent) {
        throw 'OCR license-sidecar record is invalid.'
    }
    Assert-ExactProperties -Value $Receipt.ocr.originalEngine -Expected @('bytes','sha256') -Kind 'Original OCR engine record'
    Assert-ReceiptValue -Value $Receipt.ocr.originalEngine -Kind 'Original OCR engine'
    $expectedRoles = [ordered]@{
        'bin/tesseract.exe' = 'engine'
        'tessdata/eng.traineddata' = 'model'
        'licenses/Tesseract-Apache-2.0.txt' = 'license'
        'licenses/Leptonica-BSD-2-Clause.txt' = 'license'
        'licenses/eng-fast-Apache-2.0.txt' = 'license'
    }
    $ocr = @($Receipt.ocr.packagedResources)
    if ($ocr.Count -ne 5) { throw 'OCR record must contain exactly five resources.' }
    $ocrSuffixes = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $engine = @()
    foreach ($entry in $ocr) {
        Assert-ExactProperties -Value $entry -Expected @('suffix','role','bytes','sha256') -Kind 'OCR resource record'
        Assert-ReceiptValue -Value $entry -Kind 'OCR resource'
        $suffix = [string]$entry.suffix
        if (-not $expectedRoles.Contains($suffix) -or [string]$entry.role -cne [string]$expectedRoles[$suffix] -or -not $ocrSuffixes.Add($suffix)) {
            throw 'OCR resource suffix or role is unsafe, unsupported, or duplicated.'
        }
        if ($suffix -ceq 'bin/tesseract.exe') { $engine += $entry }
    }
    if ($engine.Count -ne 1 -or $ocrSuffixes.Count -ne $expectedRoles.Count) { throw 'OCR resource record is incomplete.' }
    if ([string]$engine[0].sha256 -cne ([string]$engine[0].sha256).ToUpperInvariant()) { throw 'OCR engine SHA-256 must be uppercase.' }

    Assert-ExactProperties -Value $Receipt.signatures -Expected @('expectedPublisher','installer','application','engine','pdfium','originalEngine','trustedTimestampsRequired') -Kind 'Signature record'
    if ([string]$Receipt.signatures.expectedPublisher -cne $script:Pins.ExpectedPublisher -or
        [string]$Receipt.signatures.installer -cne 'Valid' -or
        [string]$Receipt.signatures.application -cne 'Valid' -or
        [string]$Receipt.signatures.engine -cne 'Valid' -or
        [string]$Receipt.signatures.pdfium -cne 'Valid' -or
        [string]$Receipt.signatures.originalEngine -cne 'NotSigned' -or
        $Receipt.signatures.trustedTimestampsRequired -isnot [bool] -or -not $Receipt.signatures.trustedTimestampsRequired) {
        throw 'Signed artifact signature record is incomplete.'
    }
    Assert-ExactProperties -Value $Receipt.verification -Expected @('archiveInventory','extractedResourcesMatched','bundleContainsOnlyInstaller','updaterArtifacts','ephemeralSigningConfigurationRetained') -Kind 'Artifact verification record'
    Assert-ExactProperties -Value $Receipt.verification.archiveInventory -Expected @('bytes','sha256') -Kind 'Archive inventory record'
    Assert-ReceiptValue -Value $Receipt.verification.archiveInventory -Kind 'Archive inventory'
    if ($Receipt.verification.extractedResourcesMatched -isnot [bool] -or -not $Receipt.verification.extractedResourcesMatched -or
        $Receipt.verification.bundleContainsOnlyInstaller -isnot [bool] -or -not $Receipt.verification.bundleContainsOnlyInstaller -or
        @($Receipt.verification.updaterArtifacts).Count -ne 0 -or
        $Receipt.verification.ephemeralSigningConfigurationRetained -isnot [bool] -or $Receipt.verification.ephemeralSigningConfigurationRetained) {
        throw 'Signed artifact isolation record is incomplete.'
    }
    return [pscustomobject]@{ Base = $base; Ocr = $ocr; Pdfium = $pdfium[0]; Engine = $engine[0] }
}

function Expand-InstallerProof {
    param(
        [Parameter(Mandatory = $true)][string]$Installer,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (Test-Path -LiteralPath $Destination) { throw 'Installer extraction destination must be fresh.' }
    Assert-NoReparseAncestors -Path $Destination
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    $extractor = Get-InstallerExtractor
    & $extractor.FullName x $Installer "-o$Destination" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Pinned installer extraction failed.' }
    Assert-NoReparseAncestors -Path $Destination
    return @(Get-ChildItem -LiteralPath $Destination -Recurse -File -Force)
}

function Get-UniqueResource {
    param(
        [Parameter(Mandatory = $true)][object[]]$Files,
        [Parameter(Mandatory = $true)][string]$Suffix,
        [Parameter(Mandatory = $true)][string]$Kind
    )
    $shape = $Suffix.Replace('\','/')
    $matches = @($Files | Where-Object {
        $relative = $_.FullName.Replace('\','/')
        $relative.Equals($shape, [StringComparison]::OrdinalIgnoreCase) -or $relative.EndsWith('/' + $shape, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -ne 1) { throw "$Kind is missing or duplicated." }
    Assert-NoReparseAncestors -Path $matches[0].FullName
    return $matches[0]
}

function Assert-ReceiptFileObject {
    param(
        [Parameter(Mandatory = $true)]$File,
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)][string]$Kind
    )
    Assert-ReceiptValue -Value $Receipt -Kind $Kind
    if ([uint64]$File.Length -ne [uint64]$Receipt.bytes -or (Get-ExactSha256 -Path $File.FullName) -cne [string]$Receipt.sha256) {
        throw "$Kind does not match the signed artifact record."
    }
}

function Assert-ExtractedSignedArtifact {
    param(
        [Parameter(Mandatory = $true)][object[]]$Files,
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)]$ReceiptSets,
        [scriptblock]$SignatureProvider
    )
    if ($Files.Count -ne 38) { throw 'Signed installer extraction must contain exactly 38 files.' }
    $updaters = @($Files | Where-Object { $_.Name.Equals('latest.json', [StringComparison]::OrdinalIgnoreCase) -or $_.Extension.Equals('.sig', [StringComparison]::OrdinalIgnoreCase) })
    if ($updaters.Count -ne 0) { throw 'Signed installer extraction contains an updater artifact.' }
    $app = Get-UniqueResource -Files $Files -Suffix 'pdf-workstation.exe' -Kind 'Packaged application'
    Assert-ReceiptFileObject -File $app -Receipt $Receipt.packagedApplication -Kind 'Packaged application'
    $null = Assert-TrustedWindowsSignature -Path $app.FullName -SignatureProvider $SignatureProvider -ExpectedPublisher $script:Pins.ExpectedPublisher
    foreach ($entry in $ReceiptSets.Base) {
        $match = Get-UniqueResource -Files $Files -Suffix ([string]$entry.target) -Kind 'Base resource'
        Assert-ReceiptFileObject -File $match -Receipt $entry -Kind 'Base resource'
    }
    foreach ($entry in $ReceiptSets.Ocr) {
        $matches = @($Files | Where-Object {
            $shape = $_.FullName.Replace('\','/')
            $shape -match '/resources/ocr/[a-f0-9]{64}/' -and $shape.EndsWith('/' + [string]$entry.suffix, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($matches.Count -ne 1) { throw 'OCR resource is missing or duplicated.' }
        Assert-NoReparseAncestors -Path $matches[0].FullName
        Assert-ReceiptFileObject -File $matches[0] -Receipt $entry -Kind 'OCR resource'
    }
    $engine = @($Files | Where-Object { $_.FullName.Replace('\','/') -match '/resources/ocr/[a-f0-9]{64}/bin/tesseract\.exe$' })
    if ($engine.Count -ne 1) { throw 'Signed OCR engine is missing or duplicated.' }
    $pdfium = Get-UniqueResource -Files $Files -Suffix 'resources/pdfium/bin/pdfium.dll' -Kind 'Signed PDFium'
    $null = Assert-TrustedWindowsSignature -Path $engine[0].FullName -SignatureProvider $SignatureProvider -ExpectedPublisher $script:Pins.ExpectedPublisher
    $null = Assert-TrustedWindowsSignature -Path $pdfium.FullName -SignatureProvider $SignatureProvider -ExpectedPublisher $script:Pins.ExpectedPublisher
    return [pscustomobject]@{ Application = $app; Pdfium = $pdfium; Engine = $engine[0] }
}

function Invoke-BoundedSilentInstaller {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$TimeoutMilliseconds = 240000,
        [scriptblock]$ProcessProvider
    )
    if ($ProcessProvider) {
        $result = & $ProcessProvider $Path '/S' $TimeoutMilliseconds
        if ($result.TimedOut -isnot [bool] -or $result.ExitCode -isnot [int] -or $result.TimedOut -or $result.ExitCode -ne 0) {
            throw 'Silent installer process did not complete successfully.'
        }
        return
    }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Path
    $startInfo.ArgumentList.Add('/S')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Silent installer process did not start.' }
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill($true) } catch { }
            throw 'Silent installer process exceeded its bounded timeout.'
        }
        if ($process.ExitCode -ne 0) { throw 'Silent installer process returned a nonzero exit code.' }
    } finally {
        $process.Dispose()
    }
}

function Convert-RegistryFilePath {
    param([Parameter(Mandatory = $true)][string]$Value)
    return [IO.Path]::GetFullPath($Value.Trim().Trim('"')).TrimEnd('\')
}

function Get-InstallFacts {
    param(
        [Parameter(Mandatory = $true)][string]$RegistryPath,
        [Parameter(Mandatory = $true)][string]$ExpectedInstallRoot
    )
    if (-not (Test-Path -LiteralPath $RegistryPath)) { throw 'PDF Workstation uninstall registry entry is missing.' }
    $registry = Get-ItemProperty -LiteralPath $RegistryPath
    $root = Convert-RegistryFilePath -Value ([string]$registry.InstallLocation)
    $uninstall = Convert-RegistryFilePath -Value ([string]$registry.UninstallString)
    $appPath = Join-Path $ExpectedInstallRoot 'pdf-workstation.exe'
    if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw 'Installed application is missing.' }
    $item = Get-Item -LiteralPath $appPath
    $signature = Get-WindowsSignatureFacts -Path $appPath
    return [pscustomobject]@{
        displayName = [string]$registry.DisplayName
        displayVersion = [string]$registry.DisplayVersion
        installLocation = $root
        uninstallPath = $uninstall
        appBytes = [uint64]$item.Length
        appSha256 = Get-ExactSha256 -Path $appPath
        fileVersion = [string]$item.VersionInfo.FileVersion
        productVersion = [string]$item.VersionInfo.ProductVersion
        signatureStatus = [string]$signature.Status
        publisher = [string]$signature.Publisher
        hasTimestamp = [bool]$signature.HasTimestamp
    }
}

function Assert-InstallFacts {
    param(
        [Parameter(Mandatory = $true)]$Facts,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedInstallRoot,
        [Parameter(Mandatory = $true)]$ExpectedApplication,
        [Parameter(Mandatory = $true)][string]$ExpectedSignatureStatus,
        [string]$ExpectedPublisher,
        [bool]$ExpectedTimestamp = $false
    )
    Assert-ExactProperties -Value $Facts -Expected @('displayName','displayVersion','installLocation','uninstallPath','appBytes','appSha256','fileVersion','productVersion','signatureStatus','publisher','hasTimestamp') -Kind 'Installed application facts'
    $expectedUninstall = Join-Path $ExpectedInstallRoot 'uninstall.exe'
    if ([string]$Facts.displayName -cne 'PDF Workstation' -or
        [string]$Facts.displayVersion -cne $ExpectedVersion -or
        -not ([string]$Facts.installLocation).Equals($ExpectedInstallRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$Facts.uninstallPath).Equals($expectedUninstall, [StringComparison]::OrdinalIgnoreCase) -or
        [uint64]$Facts.appBytes -ne [uint64]$ExpectedApplication.bytes -or
        [string]$Facts.appSha256 -cne [string]$ExpectedApplication.sha256 -or
        [string]$Facts.fileVersion -cne $ExpectedVersion -or
        [string]$Facts.productVersion -cne $ExpectedVersion -or
        [string]$Facts.signatureStatus -cne $ExpectedSignatureStatus -or
        [string]$Facts.publisher -cne [string]$ExpectedPublisher -or
        $Facts.hasTimestamp -isnot [bool] -or [bool]$Facts.hasTimestamp -ne $ExpectedTimestamp) {
        throw 'Installed application facts do not match the expected current-user installation.'
    }
}

function Assert-InstalledSignedResources {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)]$ReceiptSets,
        [scriptblock]$SignatureProvider
    )
    $files = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Force)
    foreach ($entry in $ReceiptSets.Base) {
        $match = Get-UniqueResource -Files $files -Suffix ([string]$entry.target) -Kind 'Installed base resource'
        Assert-ReceiptFileObject -File $match -Receipt $entry -Kind 'Installed base resource'
    }
    foreach ($entry in $ReceiptSets.Ocr) {
        $matches = @($files | Where-Object {
            $shape = $_.FullName.Replace('\','/')
            $shape -match '/resources/ocr/[a-f0-9]{64}/' -and $shape.EndsWith('/' + [string]$entry.suffix, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($matches.Count -ne 1) { throw 'Installed OCR resource is missing or duplicated.' }
        Assert-NoReparseAncestors -Path $matches[0].FullName
        Assert-ReceiptFileObject -File $matches[0] -Receipt $entry -Kind 'Installed OCR resource'
    }
    $pdfium = Get-UniqueResource -Files $files -Suffix 'resources/pdfium/bin/pdfium.dll' -Kind 'Installed PDFium'
    $engine = @($files | Where-Object { $_.FullName.Replace('\','/') -match '/resources/ocr/[a-f0-9]{64}/bin/tesseract\.exe$' })
    if ($engine.Count -ne 1) { throw 'Installed signed OCR engine is missing or duplicated.' }
    $app = Get-UniqueResource -Files $files -Suffix 'pdf-workstation.exe' -Kind 'Installed application'
    $null = Assert-TrustedWindowsSignature -Path $app.FullName -SignatureProvider $SignatureProvider -ExpectedPublisher $script:Pins.ExpectedPublisher
    $null = Assert-TrustedWindowsSignature -Path $pdfium.FullName -SignatureProvider $SignatureProvider -ExpectedPublisher $script:Pins.ExpectedPublisher
    $null = Assert-TrustedWindowsSignature -Path $engine[0].FullName -SignatureProvider $SignatureProvider -ExpectedPublisher $script:Pins.ExpectedPublisher
    $updaters = @($files | Where-Object { $_.Name.Equals('latest.json', [StringComparison]::OrdinalIgnoreCase) -or $_.Extension.Equals('.sig', [StringComparison]::OrdinalIgnoreCase) })
    if ($updaters.Count -ne 0) { throw 'Installed application contains an updater artifact.' }
}

function Assert-SentinelReceipts {
    param(
        [Parameter(Mandatory = $true)][string]$SettingsPath,
        [Parameter(Mandatory = $true)][string]$SettingsSha256,
        [Parameter(Mandatory = $true)][string]$DocumentPath,
        [Parameter(Mandatory = $true)][string]$DocumentSha256
    )
    Assert-NoReparseAncestors -Path $SettingsPath
    Assert-NoReparseAncestors -Path $DocumentPath
    if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf) -or (Get-ExactSha256 -Path $SettingsPath) -cne $SettingsSha256 -or
        -not (Test-Path -LiteralPath $DocumentPath -PathType Leaf) -or (Get-ExactSha256 -Path $DocumentPath) -cne $DocumentSha256) {
        throw 'Synthetic runner-only settings or PDF sentinel changed during upgrade.'
    }
}

function Write-SanitizedUpgradeRecord {
    param(
        [Parameter(Mandatory = $true)][string]$OutputRoot,
        [Parameter(Mandatory = $true)][string]$WorkflowSourceRevision,
        [Parameter(Mandatory = $true)]$Receipt
    )
    if (Test-Path -LiteralPath $OutputRoot) { throw 'Sanitized output root must be fresh.' }
    [IO.Directory]::CreateDirectory($OutputRoot) | Out-Null
    Assert-NoReparseAncestors -Path $OutputRoot
    $record = [ordered]@{
        schemaVersion = 1
        scope = 'Ephemeral GitHub-hosted silent NSIS installation and manual upgrade verification; application launch and updater behavior are not established.'
        mode = 'ephemeral-current-user-silent-manual-upgrade'
        workflowSourceRevision = $WorkflowSourceRevision
        signedArtifactSourceRevision = $script:Pins.SignedSourceRevision
        baseline = [ordered]@{
            version = '0.2.0'
            installer = [ordered]@{ fileName = $script:Pins.BaselineName; bytes = $script:Pins.BaselineBytes; sha256 = $script:Pins.BaselineSha256; signature = 'NotSigned' }
        }
        upgrade = [ordered]@{
            version = '0.2.6'
            installer = [ordered]@{ fileName = $script:Pins.SignedInstallerName; bytes = $script:Pins.SignedInstallerBytes; sha256 = $script:Pins.SignedInstallerSha256 }
            installedApplication = [ordered]@{ bytes = [uint64]$Receipt.packagedApplication.bytes; sha256 = [string]$Receipt.packagedApplication.sha256 }
            publisher = $script:Pins.ExpectedPublisher
            signatures = [ordered]@{ installer = 'Valid'; application = 'Valid'; pdfium = 'Valid'; engine = 'Valid'; trustedTimestampsRequired = $true }
        }
        verification = [ordered]@{
            runner = 'github-hosted-windows-2022'
            ephemeral = $true
            baselineSilentInstall = $true
            signedSilentManualUpgrade = $true
            registryVersionUpdated = $true
            installedReceiptsMatched = $true
            settingsSentinelPreserved = $true
            documentSentinelPreserved = $true
            applicationProcessStarted = $false
            guiVerified = $false
            realPreferencesVerified = $false
            ocrExecutionVerified = $false
            inAppUpdaterVerified = $false
            updaterArtifacts = @()
        }
    }
    $json = $record | ConvertTo-Json -Depth 12
    if ($json -match '(?i)([A-Z]:\\|\\Users\\|runneradmin|GITHUB_TOKEN|GH_TOKEN|AZURE_|TAURI_SIGNING|11005152678|36499724415|569181842|raw\.log)') {
        throw 'Sanitized upgrade record contains a host path, token, credential identifier, artifact identifier, or raw log reference.'
    }
    $path = Join-Path $OutputRoot 'upgrade-verification.json'
    [IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))
    $files = @(Get-ChildItem -LiteralPath $OutputRoot -File -Force)
    if ($files.Count -ne 1 -or -not $files[0].FullName.Equals($path, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Sanitized upgrade output must contain exactly one JSON record.'
    }
    return $path
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$runnerFacts = Get-HostedRunnerFacts -ProjectRoot $projectRoot
Assert-HostedRunnerFacts -Facts $runnerFacts

$runnerTemp = [string]$env:RUNNER_TEMP
if ([string]::IsNullOrWhiteSpace($runnerTemp)) { throw 'RUNNER_TEMP is unavailable.' }
$baselinePath = Resolve-RunnerPath -Path $BaselineInstaller -RunnerTemp $runnerTemp -MustExist
$signedRoot = Resolve-RunnerPath -Path $SignedArtifactRoot -RunnerTemp $runnerTemp -MustExist
$work = Resolve-RunnerPath -Path $WorkRoot -RunnerTemp $runnerTemp -MustBeFresh
$output = Resolve-RunnerPath -Path $OutputRoot -RunnerTemp $runnerTemp -MustBeFresh

$installRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'PDF Workstation')).TrimEnd('\')
$settingsRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'local.pdfworkstation.desktop')).TrimEnd('\')
$registryPath = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF Workstation'
Assert-NoReparseAncestors -Path $installRoot
Assert-NoReparseAncestors -Path $settingsRoot

Assert-FileReceipt -Path $baselinePath -Bytes $script:Pins.BaselineBytes -Sha256 $script:Pins.BaselineSha256 -Kind 'Published 0.2.0 installer'
$baselineSignature = Get-WindowsSignatureFacts -Path $baselinePath
if ([string]$baselineSignature.Status -cne 'NotSigned') { throw 'Published 0.2.0 baseline installer is not exactly Authenticode NotSigned.' }

$signedFiles = @(Get-ChildItem -LiteralPath $signedRoot -Recurse -File -Force)
$signedInstaller = Join-Path $signedRoot $script:Pins.SignedInstallerName
$recordPath = Join-Path $signedRoot $script:Pins.SignedRecordName
if ($signedFiles.Count -ne 2 -or -not (Test-Path -LiteralPath $signedInstaller -PathType Leaf) -or -not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
    throw 'Downloaded signed artifact must contain exactly the installer and sanitized record.'
}
Assert-FileReceipt -Path $signedInstaller -Bytes $script:Pins.SignedInstallerBytes -Sha256 $script:Pins.SignedInstallerSha256 -Kind 'Signed 0.2.6 installer'
Assert-FileReceipt -Path $recordPath -Bytes $script:Pins.SignedRecordBytes -Sha256 $script:Pins.SignedRecordSha256 -Kind 'Signed artifact verification record'
$null = Assert-TrustedWindowsSignature -Path $signedInstaller -ExpectedPublisher $script:Pins.ExpectedPublisher
$recordText = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8
if ($recordText -match '(?i)([A-Z]:\\|\\Users\\|GITHUB_TOKEN|GH_TOKEN|AZURE_|TAURI_SIGNING|raw\.log)') { throw 'Downloaded artifact record is not sanitized.' }
$receipt = $recordText | ConvertFrom-Json
$receiptSets = Assert-SignedArtifactReceipt -Receipt $receipt

$freshFacts = Get-FreshInstallFacts -InstallRoot $installRoot -SettingsRoot $settingsRoot -RegistryPath $registryPath -InstallerPaths @($baselinePath,$signedInstaller)
Assert-FreshInstallFacts -Facts $freshFacts

[IO.Directory]::CreateDirectory($work) | Out-Null
Assert-NoReparseAncestors -Path $work
$baselineFiles = Expand-InstallerProof -Installer $baselinePath -Destination (Join-Path $work 'baseline-extracted')
$baselineApp = Get-UniqueResource -Files $baselineFiles -Suffix 'pdf-workstation.exe' -Kind 'Baseline packaged application'
$baselineAppSignature = Get-WindowsSignatureFacts -Path $baselineApp.FullName
if ([string]$baselineAppSignature.Status -cne 'NotSigned') { throw 'Baseline packaged application is not exactly Authenticode NotSigned.' }
$baselineAppReceipt = [pscustomobject]@{ bytes = [uint64]$baselineApp.Length; sha256 = Get-ExactSha256 -Path $baselineApp.FullName }
$signedExtracted = Expand-InstallerProof -Installer $signedInstaller -Destination (Join-Path $work 'signed-extracted')
$null = Assert-ExtractedSignedArtifact -Files $signedExtracted -Receipt $receipt -ReceiptSets $receiptSets

Invoke-BoundedSilentInstaller -Path $baselinePath
$processFacts = Get-ConflictingProcessFacts -InstallerPaths @($baselinePath,$signedInstaller)
if ($processFacts.applicationProcessPresent -or $processFacts.installerProcessPresent) { throw 'Baseline silent install left an application or installer process running.' }
$baselineInstalled = Get-InstallFacts -RegistryPath $registryPath -ExpectedInstallRoot $installRoot
Assert-InstallFacts -Facts $baselineInstalled -ExpectedVersion '0.2.0' -ExpectedInstallRoot $installRoot -ExpectedApplication $baselineAppReceipt -ExpectedSignatureStatus 'NotSigned'

if (Test-Path -LiteralPath $settingsRoot) { throw 'Baseline installer unexpectedly created the application settings root without launching the app.' }
[IO.Directory]::CreateDirectory($settingsRoot) | Out-Null
Assert-NoReparseAncestors -Path $settingsRoot
$settingsSentinel = Join-Path $settingsRoot 'upgrade-sentinel.json'
[IO.File]::WriteAllText($settingsSentinel, '{"kind":"ephemeral-upgrade-sentinel","version":1}', [Text.UTF8Encoding]::new($false))
$settingsSentinelSha256 = Get-ExactSha256 -Path $settingsSentinel
$documentSentinel = Join-Path $work 'document-sentinel.pdf'
$fixture = Join-Path $projectRoot 'src-tauri/tests/fixtures/reportlab-plain-fields.pdf'
Assert-NoReparseAncestors -Path $fixture
[IO.File]::Copy($fixture, $documentSentinel, $false)
$documentSentinelSha256 = Get-ExactSha256 -Path $documentSentinel

Invoke-BoundedSilentInstaller -Path $signedInstaller
$processFacts = Get-ConflictingProcessFacts -InstallerPaths @($baselinePath,$signedInstaller)
if ($processFacts.applicationProcessPresent -or $processFacts.installerProcessPresent) { throw 'Signed silent upgrade left an application or installer process running.' }
$upgraded = Get-InstallFacts -RegistryPath $registryPath -ExpectedInstallRoot $installRoot
Assert-InstallFacts -Facts $upgraded -ExpectedVersion '0.2.6' -ExpectedInstallRoot $installRoot -ExpectedApplication $receipt.packagedApplication -ExpectedSignatureStatus 'Valid' -ExpectedPublisher $script:Pins.ExpectedPublisher -ExpectedTimestamp $true
Assert-InstalledSignedResources -InstallRoot $installRoot -Receipt $receipt -ReceiptSets $receiptSets
Assert-SentinelReceipts -SettingsPath $settingsSentinel -SettingsSha256 $settingsSentinelSha256 -DocumentPath $documentSentinel -DocumentSha256 $documentSentinelSha256

$record = Write-SanitizedUpgradeRecord -OutputRoot $output -WorkflowSourceRevision ([string]$runnerFacts.githubSha) -Receipt $receipt
Write-Output 'Ephemeral silent installer upgrade verification succeeded.'
Write-Output ('Sanitized record SHA-256: ' + (Get-ExactSha256 -Path $record))
