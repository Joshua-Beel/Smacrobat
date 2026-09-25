param(
    [switch]$AzureSigning,
    [switch]$UnsignedLocal,
    [string]$OcrSetupRoot,
    [string]$OutputRoot
)
$ErrorActionPreference = 'Stop'

function New-AzureSigningConfig {
    param([string]$Endpoint, [string]$Account, [string]$Profile)
    foreach ($entry in @(@('AZURE_SIGNING_ENDPOINT', $Endpoint), @('AZURE_SIGNING_ACCOUNT', $Account), @('AZURE_SIGNING_PROFILE', $Profile))) {
        if ([string]::IsNullOrWhiteSpace($entry[1])) { throw "Missing required signing setting: $($entry[0])" }
    }
    if ($Endpoint -cnotmatch '^https://[a-z0-9-]+\.codesigning\.azure\.net/?$') { throw 'Invalid AZURE_SIGNING_ENDPOINT: use an HTTPS Azure code-signing service endpoint without credentials, query, or custom path.' }
    foreach ($entry in @(@('AZURE_SIGNING_ACCOUNT', $Account), @('AZURE_SIGNING_PROFILE', $Profile))) {
        if ($entry[1] -cnotmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,127}$') { throw "Invalid signing identifier: $($entry[0])" }
    }
    return @{ bundle = @{ windows = @{ signCommand = @{ cmd = 'artifact-signing-cli'; args = @('-e', $Endpoint, '-a', $Account, '-c', $Profile, '-d', 'PDF Workstation', '%1') } } } }
}

function Write-JsonUtf8 {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
}

function Assert-NotPublisherSigned {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ((Get-AuthenticodeSignature -LiteralPath $Path).Status -ne 'NotSigned') { throw 'Unsigned-local artifact is not exactly Authenticode NotSigned.' }
}

function Close-ReadLocks {
    param($Locks)
    if ($Locks) { foreach ($lock in $Locks) { $lock.Dispose() } }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'ocr/installer-package.ps1')

# OCR is enabled only by the explicit parameter. An ambient variable must never
# change the default installer or release workflow.
Remove-Item Env:PDF_WORKSTATION_OCR_SETUP_ROOT -ErrorAction SilentlyContinue

if ($AzureSigning -and $UnsignedLocal) { throw 'AzureSigning and UnsignedLocal cannot be combined.' }
if ($AzureSigning -and $OcrSetupRoot) { throw 'Azure-signed OCR installers are disabled until the pre-signed engine can bypass Tauri resource re-signing without changing its embedded hash.' }
if ($OcrSetupRoot -and -not ($AzureSigning -or $UnsignedLocal)) { throw 'OcrSetupRoot requires AzureSigning or UnsignedLocal.' }
if ($OcrSetupRoot -and [string]::IsNullOrWhiteSpace($OutputRoot)) { throw 'OcrSetupRoot requires a fresh OutputRoot beneath target.' }
if ($UnsignedLocal -and [string]::IsNullOrWhiteSpace($OutputRoot)) { throw 'UnsignedLocal requires a fresh OutputRoot beneath target.' }
if ($OutputRoot -and -not ($UnsignedLocal -or $OcrSetupRoot)) { throw 'OutputRoot is supported only for an explicit unsigned-local or OCR build.' }

$resolvedOutput = $null
$cargoTarget = $null
if ($OutputRoot) {
    if ([Environment]::GetEnvironmentVariable('CARGO_TARGET_DIR')) { throw 'Remove the ambient CARGO_TARGET_DIR before a bounded installer proof.' }
    $resolvedOutput = Resolve-FreshInstallerOutput -ProjectRoot $projectRoot -OutputRoot $OutputRoot
    $cargoTarget = Join-Path $resolvedOutput 'cargo-target'
    $env:CARGO_TARGET_DIR = $cargoTarget
}

if ($UnsignedLocal) {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

$env:PATH = (Join-Path $env:USERPROFILE '.cargo\bin') + ';' + $env:PATH
if ($AzureSigning) {
    foreach ($name in @('AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE')) {
        $setting = [Environment]::GetEnvironmentVariable($name)
        if ($env:GITHUB_ACTIONS -eq 'true' -and $setting) {
            $mask = $setting.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
            Write-Output "::add-mask::$mask"
        }
    }
    $azureConfig = New-AzureSigningConfig -Endpoint $env:AZURE_SIGNING_ENDPOINT -Account $env:AZURE_SIGNING_ACCOUNT -Profile $env:AZURE_SIGNING_PROFILE
    foreach ($name in @('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET')) {
        if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing required signing credential: $name" }
    }
    if (-not (Get-Command artifact-signing-cli -ErrorAction SilentlyContinue)) { throw 'Install artifact-signing-cli 0.11.0 before an Azure-signed build.' }
}

# UnsignedLocal intentionally neither reads nor requires either updater key
# variable. All other existing installer modes keep the updater-key behavior.
if (-not $UnsignedLocal -and -not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $signingFile = Join-Path $env:LOCALAPPDATA 'PDFWorkstation\signing\updater.key'
    if (-not (Test-Path -LiteralPath $signingFile)) { throw 'Set TAURI_SIGNING_PRIVATE_KEY to the release signing key path.' }
    $env:TAURI_SIGNING_PRIVATE_KEY = $signingFile
}

$sourceLocks = $null
$baseLocks = $null
$ocrPlan = $null
$ocrEntries = $null
$originalEngineReceipt = $null
$originalEngineStatus = $null
try {
    if ($OcrSetupRoot) {
        $originalPlan = Get-VerifiedOcrSetup -ProjectRoot $projectRoot -SetupRoot $OcrSetupRoot
        $originalEngineStatus = (Get-AuthenticodeSignature -LiteralPath ($originalPlan.Files | Where-Object Role -CEQ 'engine').Source).Status.ToString()
        if ($originalEngineStatus -cne 'NotSigned') { throw 'Unsigned-local OCR requires an engine whose Authenticode status is exactly NotSigned.' }
        $sourceLocks = Open-OcrReadLocks -Plan $originalPlan
        $originalPlan = Get-VerifiedOcrSetup -ProjectRoot $projectRoot -SetupRoot $OcrSetupRoot
        $originalEngineReceipt = [pscustomobject]@{ bytes = $originalPlan.Engine.Bytes; sha256 = $originalPlan.Engine.Sha256 }
        $ocrPlan = $originalPlan
        $ocrEntries = Get-OcrBundleEntries -Plan $ocrPlan
        $env:PDF_WORKSTATION_OCR_SETUP_ROOT = $ocrPlan.Root
    }

    if (-not (Test-Path 'src-tauri/resources/pdfium/bin/pdfium.dll')) { & "$PSScriptRoot/setup-pdfium.ps1" }
    cargo fetch --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch locked dependencies for notice verification.' }
    node scripts/mpl-source-archives.mjs --check
    if ($LASTEXITCODE -ne 0) { throw 'Exact MPL source archives are missing or stale. Regenerate and review them before building an installer.' }
    node scripts/dependency-notices.mjs --check
    if ($LASTEXITCODE -ne 0) { throw 'Dependency notices are missing or stale. Regenerate and review them before building an installer.' }

    $baseResources = if ($resolvedOutput -or $ocrPlan) { Get-BaseBundleResourceMap -ProjectRoot $projectRoot } else { $null }
    if ($baseResources) {
        $unlockedBaseResources = $baseResources
        $baseLocks = Open-PathReadLocks -Paths @($baseResources.Entries | ForEach-Object Source)
        $baseResources = Get-BaseBundleResourceMap -ProjectRoot $projectRoot
        Assert-BaseResourceMapStable -Before $unlockedBaseResources -After $baseResources
    }
    $resourceMap = $null
    if ($ocrPlan) {
        $resourceMap = Add-OcrBundleResources -Base $baseResources -Entries $ocrEntries -Identity $ocrPlan.Identity
        if ($resourceMap.Count -ne ($baseResources.Count + 5)) { throw 'OCR resource map did not preserve a base-resource bijection.' }
    }
    $signCommand = if ($azureConfig) { $azureConfig.bundle.windows.signCommand } else { $null }
    $override = if ($UnsignedLocal -or $signCommand -or $resourceMap) { New-InstallerOverrideConfig -SignCommand $signCommand -UnsignedLocal:$UnsignedLocal -ResourceMap $resourceMap } else { $null }

    $configPath = $null
    $deleteConfig = $false
    if ($override) {
        if ($resolvedOutput) {
            $configPath = Join-Path $resolvedOutput 'tauri-installer-override.json'
        } else {
            $configDirectory = Join-Path $projectRoot 'src-tauri/target/signing-config'
            New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
            $configPath = Join-Path $configDirectory ([Guid]::NewGuid().ToString('N') + '.json')
            $deleteConfig = $true
        }
        Write-JsonUtf8 -Path $configPath -Value $override
    }

    if ($deleteConfig) {
        try {
            npm.cmd run tauri -- build --ci --bundles nsis --config $configPath
            $buildExitCode = $LASTEXITCODE
        } finally {
            if (Test-Path -LiteralPath $configPath -PathType Leaf) { Remove-Item -LiteralPath $configPath }
        }
    } else {
        if ($configPath) { npm.cmd run tauri -- build --ci --bundles nsis --config $configPath } else { npm.cmd run tauri -- build --ci --bundles nsis }
        $buildExitCode = $LASTEXITCODE
    }
    if ($buildExitCode -ne 0) { throw 'Installer build failed.' }

    $targetRoot = if ($cargoTarget) { $cargoTarget } else { Join-Path $projectRoot 'src-tauri/target' }
    $installerDirectory = Join-Path $targetRoot 'release/bundle/nsis'
    if ($resolvedOutput) {
        $installers = @(Get-ChildItem -LiteralPath $installerDirectory -File | Where-Object Name -Like '*_x64-setup.exe')
        if ($installers.Count -ne 1) { throw 'Expected exactly one x64 NSIS installer in the fresh proof root.' }
        $installer = $installers[0].FullName
    } else {
        $version = (Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw -Encoding UTF8 | ConvertFrom-Json).version
        $installer = Join-Path $installerDirectory "PDF Workstation_${version}_x64-setup.exe"
        if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'The current-version x64 NSIS installer is missing.' }
        $installers = @(Get-Item -LiteralPath $installer)
    }

    if ($resolvedOutput) {
        $bundleRoot = Join-Path $targetRoot 'release/bundle'
        $unexpectedUpdaterArtifacts = @(Get-ChildItem -LiteralPath $bundleRoot -Recurse -File | Where-Object { $_.Name -CEQ 'latest.json' -or $_.Extension -CEQ '.sig' })
        if ($UnsignedLocal -and $unexpectedUpdaterArtifacts.Count -ne 0) { throw 'Unsigned-local bundle unexpectedly contains updater signature artifacts.' }
        $extractor = Get-InstallerExtractor
        $inventoryLines = @(& $extractor.FullName l -slt $installer)
        if ($LASTEXITCODE -ne 0) { throw 'Could not inventory the installer archive.' }
        $inventoryPath = Join-Path $resolvedOutput 'installer-inventory.txt'
        [IO.File]::WriteAllLines($inventoryPath, $inventoryLines, [Text.UTF8Encoding]::new($false))
        $archivePaths = @(Convert-SevenZipInventory -Lines $inventoryLines)
        Assert-ArchiveResourceInventory -ArchivePaths $archivePaths -BaseEntries $baseResources.Entries -OcrPlan $ocrPlan
        $extractionDirectory = Join-Path $resolvedOutput 'extracted-installer'
        if (Test-Path -LiteralPath $extractionDirectory) { throw 'Installer extraction directory already exists.' }
        New-Item -ItemType Directory -Path $extractionDirectory | Out-Null
        & $extractor.FullName x $installer "-o$extractionDirectory" -y
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract the installer for resource verification.' }
        $baseReceipts = @(Assert-ExtractedBaseResources -ExtractionRoot $extractionDirectory -Entries $baseResources.Entries)
        $ocrReceipts = @(Assert-ExtractedOcrPackage -ExtractionRoot $extractionDirectory -Plan $ocrPlan)
        $packagedApplications = @(Get-ChildItem -LiteralPath $extractionDirectory -Recurse -File | Where-Object Name -CEQ 'pdf-workstation.exe')
        if ($packagedApplications.Count -ne 1) { throw 'The installer must contain exactly one application executable.' }
        $packagedApplication = $packagedApplications[0].FullName
        if ($ocrPlan -and -not (Test-ExecutableContainsAscii -Path $packagedApplication -Marker $ocrPlan.Engine.Sha256)) { throw 'Packaged application does not embed the packaged OCR engine identity.' }

        Assert-NotPublisherSigned -Path $installer
        Assert-NotPublisherSigned -Path $packagedApplication
        $installerStatus = (Get-AuthenticodeSignature -LiteralPath $installer).Status.ToString()
        $applicationStatus = (Get-AuthenticodeSignature -LiteralPath $packagedApplication).Status.ToString()
        $engineStatus = $null
        if ($ocrPlan) {
            $engineReceipt = $ocrReceipts | Where-Object path -Like '*/bin/tesseract.exe'
            $extractedEngine = Find-ExtractedResource -Files @(Get-ChildItem -LiteralPath $extractionDirectory -Recurse -File) -Target $engineReceipt.path
            Assert-NotPublisherSigned -Path $extractedEngine.FullName
            $engineStatus = (Get-AuthenticodeSignature -LiteralPath $extractedEngine.FullName).Status.ToString()
        }

        $receipt = [ordered]@{
            schemaVersion = 1
            scope = if ($ocrPlan) { 'Opt-in OCR installer extraction proof; no install, launch, update, or release claim.' } else { 'Default installer extraction proof; no install, launch, update, or release claim.' }
            mode = if ($ocrPlan) { 'unsigned-local-ocr' } else { 'unsigned-local-default' }
            installer = @{ path = $installer.Substring($resolvedOutput.Length + 1).Replace('\', '/'); bytes = [uint64]$installers[0].Length; sha256 = Get-ExactSha256 -Path $installer }
            application = @{ path = $packagedApplication.Substring($resolvedOutput.Length + 1).Replace('\', '/'); bytes = [uint64]$packagedApplications[0].Length; sha256 = Get-ExactSha256 -Path $packagedApplication }
            archiveInventory = @{ path = 'installer-inventory.txt'; bytes = [uint64](Get-Item -LiteralPath $inventoryPath).Length; sha256 = Get-ExactSha256 -Path $inventoryPath }
            baseResources = $baseReceipts
            ocr = @{ enabled = [bool]$ocrPlan; identity = if ($ocrPlan) { $ocrPlan.Identity } else { $null }; setupManifestSha256 = if ($ocrPlan) { $ocrPlan.ManifestSha256 } else { $null }; originalEngine = $originalEngineReceipt; packagedResources = $ocrReceipts; licensesArePackagedSidecarsNotNoticeDialogContent = [bool]$ocrPlan }
            signatures = @{ installer = $installerStatus; application = $applicationStatus; engine = $engineStatus; originalEngine = $originalEngineStatus }
            config = @{ path = $configPath.Substring($resolvedOutput.Length + 1).Replace('\', '/'); sha256 = Get-ExactSha256 -Path $configPath; updaterArtifacts = @() }
        }
        Write-JsonUtf8 -Path (Join-Path $resolvedOutput 'installer-verification.json') -Value $receipt
    } elseif ($AzureSigning) {
        & "$PSScriptRoot/verify-windows-signatures.ps1" -Paths @($installer)
        $extractor = Get-Command 7z -ErrorAction Stop
        $verificationDirectory = Join-Path $projectRoot ("src-tauri/target/signature-checks/" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $verificationDirectory -Force | Out-Null
        & $extractor.Source e $installer "-o$verificationDirectory" -r -y 'pdf-workstation.exe'
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract the packaged application for signature verification.' }
        $packagedApplication = Join-Path $verificationDirectory 'pdf-workstation.exe'
        if (-not (Test-Path -LiteralPath $packagedApplication -PathType Leaf)) { throw 'The installer does not contain the expected application executable.' }
        & "$PSScriptRoot/verify-windows-signatures.ps1" -Paths @($packagedApplication)
    }

    if (-not $UnsignedLocal -and -not $OcrSetupRoot) {
        node scripts/release-manifest.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Update manifest generation failed.' }
    }
} finally {
    Close-ReadLocks -Locks $baseLocks
    Close-ReadLocks -Locks $sourceLocks
}
