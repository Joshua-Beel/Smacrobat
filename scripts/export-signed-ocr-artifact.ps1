[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
    [Parameter(Mandatory = $true)][string]$SourceRevision
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'ocr/installer-package.ps1')
. (Join-Path $PSScriptRoot 'ocr/windows-signing.ps1')

function Assert-ExactJsonProperties {
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

function Assert-ReceiptValue {
    param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$Kind)
    $bytes = [uint64]$Value.bytes
    $sha256 = [string]$Value.sha256
    if ($bytes -eq 0 -or $sha256 -cnotmatch '^[A-F0-9]{64}$') { throw "$Kind has an invalid byte or SHA-256 receipt." }
}

function Resolve-ArtifactRoot {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$MustExist
    )
    $repository = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $target = [IO.Path]::GetFullPath((Join-Path $repository 'target')).TrimEnd('\')
    $candidate = if ([IO.Path]::IsPathRooted($Path)) {
        [IO.Path]::GetFullPath($Path)
    } else {
        [IO.Path]::GetFullPath((Join-Path $repository $Path))
    }
    $candidate = $candidate.TrimEnd('\')
    if (-not $candidate.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Artifact paths must be distinct directories beneath this repository target directory.'
    }
    Assert-NoReparseAncestors -Path $candidate
    if ($MustExist -and -not (Test-Path -LiteralPath $candidate -PathType Container)) { throw 'Artifact source root is missing.' }
    if (-not $MustExist -and (Test-Path -LiteralPath $candidate)) { throw 'Artifact output root must be fresh.' }
    return $candidate
}

function Resolve-SafeReceiptFile {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Pattern
    )
    if ($RelativePath -cnotmatch $Pattern -or $RelativePath.Contains('..') -or $RelativePath.Contains('\') -or [IO.Path]::IsPathRooted($RelativePath)) {
        throw "$Kind path is unsafe or unexpected."
    }
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $candidate = [IO.Path]::GetFullPath((Join-Path $rootPath $RelativePath))
    if (-not $candidate.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "$Kind escaped the artifact source root." }
    Assert-NoReparseAncestors -Path $candidate
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "$Kind is missing." }
    return $candidate
}

function Assert-LiveReceiptFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)][string]$Kind
    )
    Assert-ReceiptValue -Value $Receipt -Kind $Kind
    $item = Get-Item -LiteralPath $Path
    if ([uint64]$item.Length -ne [uint64]$Receipt.bytes -or (Get-ExactSha256 -Path $Path) -cne [string]$Receipt.sha256) {
        throw "$Kind does not match its verification receipt."
    }
}

function Close-ArtifactReadLocks {
    param($Locks)
    if ($Locks) { foreach ($lock in $Locks) { $lock.Dispose() } }
}

function Export-SignedOcrArtifact {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$OutputRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
        [Parameter(Mandatory = $true)][string]$SourceRevision,
        [scriptblock]$SignatureProvider,
        [scriptblock]$BaseMapProvider
    )
    if ($ExpectedPublisher -cnotmatch "^[A-Za-z0-9][A-Za-z0-9 .,&'()/-]{0,127}$") { throw 'ExpectedPublisher is invalid.' }
    if ($SourceRevision -cnotmatch '^[a-f0-9]{40}$') { throw 'SourceRevision must be the exact lowercase 40-character git HEAD.' }
    $repository = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $headRevision = (& git -C $repository rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $headRevision -cne $SourceRevision) { throw 'SourceRevision does not match the current git HEAD.' }
    $source = Resolve-ArtifactRoot -ProjectRoot $repository -Path $SourceRoot -MustExist
    $output = Resolve-ArtifactRoot -ProjectRoot $repository -Path $OutputRoot
    if ($source.Equals($output, [StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact source and output roots must be distinct.' }

    $receiptPath = Join-Path $source 'installer-verification.json'
    Assert-NoReparseAncestors -Path $receiptPath
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf) -or (Get-Item -LiteralPath $receiptPath).Length -gt 2MB) {
        throw 'Installer verification receipt is missing or oversized.'
    }
    $receiptLock = [IO.File]::Open($receiptPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $claimedLocks = $null
    try {
        try { $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Installer verification receipt is invalid JSON.' }
        Assert-ExactJsonProperties -Value $receipt -Expected @('schemaVersion','scope','mode','sourceRevision','installer','application','archiveInventory','baseResources','ocr','signatures','config') -Kind 'Installer verification receipt'
        if ($receipt.schemaVersion -ne 1 -or [string]$receipt.mode -cne 'azure-signed-artifact-only-ocr' -or
            [string]$receipt.scope -cne 'Artifact-only Azure OCR installer extraction proof; no install, launch, update, workflow, or release claim.') {
            throw 'Installer verification receipt mode or scope is unsupported.'
        }
        if ([string]$receipt.sourceRevision -cne $SourceRevision) { throw 'Installer verification receipt is for a different source revision.' }

        Assert-ExactJsonProperties -Value $receipt.installer -Expected @('path','bytes','sha256') -Kind 'Installer receipt'
        Assert-ExactJsonProperties -Value $receipt.application -Expected @('path','bytes','sha256') -Kind 'Application receipt'
        Assert-ExactJsonProperties -Value $receipt.archiveInventory -Expected @('path','bytes','sha256') -Kind 'Archive inventory receipt'
        $installerPath = Resolve-SafeReceiptFile -Root $source -RelativePath ([string]$receipt.installer.path) -Kind 'Installer' -Pattern '^cargo-target/release/bundle/nsis/[A-Za-z0-9._ -]+_x64-setup\.exe$'
        $applicationPath = Resolve-SafeReceiptFile -Root $source -RelativePath ([string]$receipt.application.path) -Kind 'Packaged application' -Pattern '^extracted-installer/pdf-workstation\.exe$'
        $inventoryPath = Resolve-SafeReceiptFile -Root $source -RelativePath ([string]$receipt.archiveInventory.path) -Kind 'Archive inventory' -Pattern '^installer-inventory\.txt$'

        Assert-ExactJsonProperties -Value $receipt.signatures -Expected @('expectedPublisher','installer','application','engine','originalEngine') -Kind 'Signature receipt'
        if ([string]$receipt.signatures.expectedPublisher -cne $ExpectedPublisher -or
            [string]$receipt.signatures.installer -cne 'Valid' -or
            [string]$receipt.signatures.application -cne 'Valid' -or
            [string]$receipt.signatures.engine -cne 'Valid' -or
            [string]$receipt.signatures.originalEngine -cne 'NotSigned') {
            throw 'Signature receipt is incomplete or does not match ExpectedPublisher.'
        }
        Assert-ExactJsonProperties -Value $receipt.config -Expected @('ephemeral','retained','updaterArtifacts') -Kind 'Signing configuration receipt'
        if ($receipt.config.ephemeral -isnot [bool] -or $receipt.config.retained -isnot [bool] -or
            -not $receipt.config.ephemeral -or $receipt.config.retained -or @($receipt.config.updaterArtifacts).Count -ne 0) {
            throw 'Artifact-only signing configuration or updater isolation was not verified.'
        }

        $base = @($receipt.baseResources)
        $canonicalBase = if ($BaseMapProvider) { & $BaseMapProvider $repository } else { Get-BaseBundleResourceMap -ProjectRoot $repository }
        if ($base.Count -ne $canonicalBase.Count) { throw 'Base-resource verification receipt is incomplete.' }
        $canonicalByTarget = @{}
        foreach ($entry in $canonicalBase.Entries) { $canonicalByTarget[[string]$entry.Target] = $entry }
        $baseOutput = @()
        $baseTargets = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $pdfium = @()
        foreach ($entry in $base) {
            $hasUnsigned = $null -ne $entry.PSObject.Properties['unsignedSha256']
            Assert-ExactJsonProperties -Value $entry -Expected $(if ($hasUnsigned) { @('path','bytes','sha256','unsignedBytes','unsignedSha256') } else { @('path','bytes','sha256') }) -Kind 'Base-resource receipt'
            $target = [string]$entry.path
            if ($target -cnotmatch '^resources/[A-Za-z0-9._/-]+$' -or $target.Contains('..') -or -not $baseTargets.Add($target) -or
                -not $canonicalByTarget.ContainsKey($target) -or [string]$canonicalByTarget[$target].Target -cne $target) {
                throw 'Base-resource target is unsafe or duplicated.'
            }
            Assert-ReceiptValue -Value $entry -Kind 'Base resource'
            $canonical = $canonicalByTarget[$target]
            if ($target -ceq 'resources/pdfium/bin/pdfium.dll') {
                if (-not $hasUnsigned -or [uint64]$entry.unsignedBytes -ne [uint64]$canonical.Receipt.Bytes -or
                    [string]$entry.unsignedSha256 -cne [string]$canonical.Receipt.Sha256) { throw 'Signed PDFium receipt is incomplete.' }
                $pdfium += $entry
                $baseOutput += [ordered]@{ target = $target; bytes = [uint64]$entry.bytes; sha256 = [string]$entry.sha256; unsignedBytes = [uint64]$entry.unsignedBytes; unsignedSha256 = [string]$entry.unsignedSha256 }
            } elseif ($hasUnsigned) {
                throw 'Only the signed PDFium receipt may include an unsigned hash.'
            } elseif ([uint64]$entry.bytes -ne [uint64]$canonical.Receipt.Bytes -or [string]$entry.sha256 -cne [string]$canonical.Receipt.Sha256) {
                throw 'Base-resource receipt does not match the canonical source map.'
            } else {
                $baseOutput += [ordered]@{ target = $target; bytes = [uint64]$entry.bytes; sha256 = [string]$entry.sha256 }
            }
        }
        if ($pdfium.Count -ne 1) { throw 'Signed PDFium receipt is not unique.' }

        Assert-ExactJsonProperties -Value $receipt.ocr -Expected @('enabled','identity','setupManifestSha256','originalEngine','packagedResources','licensesArePackagedSidecarsNotNoticeDialogContent') -Kind 'OCR receipt'
        if ($receipt.ocr.enabled -isnot [bool] -or $receipt.ocr.licensesArePackagedSidecarsNotNoticeDialogContent -isnot [bool] -or
            -not $receipt.ocr.enabled -or -not $receipt.ocr.licensesArePackagedSidecarsNotNoticeDialogContent -or
            [string]$receipt.ocr.identity -cnotmatch '^[a-f0-9]{64}$' -or [string]$receipt.ocr.setupManifestSha256 -cnotmatch '^[A-F0-9]{64}$') {
            throw 'OCR verification receipt is incomplete.'
        }
        Assert-ExactJsonProperties -Value $receipt.ocr.originalEngine -Expected @('bytes','sha256') -Kind 'Original OCR engine receipt'
        Assert-ReceiptValue -Value $receipt.ocr.originalEngine -Kind 'Original OCR engine'
        $identity = [string]$receipt.ocr.identity
        $expectedSuffixRoles = [ordered]@{
            'bin/tesseract.exe' = 'engine'
            'tessdata/eng.traineddata' = 'model'
            'licenses/Tesseract-Apache-2.0.txt' = 'license'
            'licenses/Leptonica-BSD-2-Clause.txt' = 'license'
            'licenses/eng-fast-Apache-2.0.txt' = 'license'
        }
        $ocrResources = @($receipt.ocr.packagedResources)
        if ($ocrResources.Count -ne 5) { throw 'OCR resource verification receipt must contain exactly five entries.' }
        $ocrOutput = @()
        $ocrTargets = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $engineReceipt = $null
        foreach ($entry in $ocrResources) {
            Assert-ExactJsonProperties -Value $entry -Expected @('path','bytes','sha256','role') -Kind 'OCR resource receipt'
            Assert-ReceiptValue -Value $entry -Kind 'OCR resource'
            $prefix = "resources/ocr/$identity/"
            $target = [string]$entry.path
            if (-not $target.StartsWith($prefix, [StringComparison]::Ordinal) -or -not $ocrTargets.Add($target)) { throw 'OCR resource target is unsafe or duplicated.' }
            $suffix = $target.Substring($prefix.Length)
            if (-not $expectedSuffixRoles.Contains($suffix) -or [string]$entry.role -cne [string]$expectedSuffixRoles[$suffix]) {
                throw 'OCR resource suffix or role is unsupported.'
            }
            if ($suffix -ceq 'bin/tesseract.exe') { $engineReceipt = $entry }
            $ocrOutput += [ordered]@{ suffix = $suffix; role = [string]$entry.role; bytes = [uint64]$entry.bytes; sha256 = [string]$entry.sha256 }
        }
        if (-not $engineReceipt -or $ocrTargets.Count -ne $expectedSuffixRoles.Count) { throw 'OCR resource verification set is incomplete.' }
        if ($identity -cne ([string]$engineReceipt.sha256).ToLowerInvariant()) { throw 'OCR identity does not match the signed engine receipt.' }

        $bundleRoot = Join-Path $source 'cargo-target/release/bundle'
        Assert-NoReparseAncestors -Path $bundleRoot
        $bundleFiles = @(Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -Force)
        if ($bundleFiles.Count -ne 1 -or -not $bundleFiles[0].FullName.Equals($installerPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Signed artifact bundle must contain exactly the receipt-bound installer.'
        }
        $updaterArtifacts = @(Get-ChildItem -LiteralPath $source -Recurse -File -Force | Where-Object {
            $_.Name.Equals('latest.json', [StringComparison]::OrdinalIgnoreCase) -or $_.Extension.Equals('.sig', [StringComparison]::OrdinalIgnoreCase)
        })
        if ($updaterArtifacts.Count -ne 0) { throw 'Signed artifact proof contains an updater artifact.' }

        $extractedFiles = @(Get-ChildItem -LiteralPath (Join-Path $source 'extracted-installer') -Recurse -File -Force)
        $claimedPaths = @($installerPath, $applicationPath, $inventoryPath)
        foreach ($entry in $base + $ocrResources) {
            $match = Find-ExtractedResource -Files $extractedFiles -Target ([string]$entry.path)
            Assert-NoReparseAncestors -Path $match.FullName
            $claimedPaths += $match.FullName
        }
        $claimedLocks = Open-PathReadLocks -Paths $claimedPaths
        Assert-LiveReceiptFile -Path $installerPath -Receipt $receipt.installer -Kind 'Installer'
        Assert-LiveReceiptFile -Path $applicationPath -Receipt $receipt.application -Kind 'Packaged application'
        Assert-LiveReceiptFile -Path $inventoryPath -Receipt $receipt.archiveInventory -Kind 'Archive inventory'
        foreach ($entry in $base + $ocrResources) {
            $match = Find-ExtractedResource -Files $extractedFiles -Target ([string]$entry.path)
            Assert-NoReparseAncestors -Path $match.FullName
            Assert-LiveReceiptFile -Path $match.FullName -Receipt $entry -Kind 'Extracted resource'
        }
        $installerFacts = Assert-TrustedWindowsSignature -Path $installerPath -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher
        $applicationFacts = Assert-TrustedWindowsSignature -Path $applicationPath -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher
        $enginePath = (Find-ExtractedResource -Files $extractedFiles -Target ([string]$engineReceipt.path)).FullName
        $engineFacts = Assert-TrustedWindowsSignature -Path $enginePath -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher
        $pdfiumPath = (Find-ExtractedResource -Files $extractedFiles -Target ([string]$pdfium[0].path)).FullName
        $pdfiumFacts = Assert-TrustedWindowsSignature -Path $pdfiumPath -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher

        $receiptTime = (Get-Item -LiteralPath $receiptPath).LastWriteTimeUtc
        foreach ($path in $claimedPaths) {
            if ((Get-Item -LiteralPath $path).LastWriteTimeUtc -gt $receiptTime) { throw 'Installer verification receipt is stale.' }
        }

        [IO.Directory]::CreateDirectory($output) | Out-Null
        Assert-NoReparseAncestors -Path $output
        $installerName = [IO.Path]::GetFileName($installerPath)
        $exportedInstaller = Join-Path $output $installerName
        [IO.File]::Copy($installerPath, $exportedInstaller, $false)
        Assert-LiveReceiptFile -Path $exportedInstaller -Receipt $receipt.installer -Kind 'Exported installer'
        $null = Assert-TrustedWindowsSignature -Path $exportedInstaller -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher

        $record = [ordered]@{
            schemaVersion = 1
            scope = 'Manual artifact-only signed OCR installer verification; no installation, launch, update, or release behavior is established.'
            mode = 'azure-signed-artifact-only-ocr'
            sourceRevision = $SourceRevision
            installer = [ordered]@{ fileName = $installerName; bytes = [uint64]$receipt.installer.bytes; sha256 = [string]$receipt.installer.sha256 }
            packagedApplication = [ordered]@{ bytes = [uint64]$receipt.application.bytes; sha256 = [string]$receipt.application.sha256 }
            baseResources = $baseOutput
            ocr = [ordered]@{
                originalEngine = [ordered]@{ bytes = [uint64]$receipt.ocr.originalEngine.bytes; sha256 = [string]$receipt.ocr.originalEngine.sha256 }
                packagedResources = $ocrOutput
                licensesArePackagedSidecarsNotNoticeDialogContent = $true
            }
            signatures = [ordered]@{
                expectedPublisher = $ExpectedPublisher
                installer = [string]$installerFacts.Status
                application = [string]$applicationFacts.Status
                engine = [string]$engineFacts.Status
                pdfium = [string]$pdfiumFacts.Status
                originalEngine = 'NotSigned'
                trustedTimestampsRequired = $true
            }
            verification = [ordered]@{
                archiveInventory = [ordered]@{ bytes = [uint64]$receipt.archiveInventory.bytes; sha256 = [string]$receipt.archiveInventory.sha256 }
                extractedResourcesMatched = $true
                bundleContainsOnlyInstaller = $true
                updaterArtifacts = @()
                ephemeralSigningConfigurationRetained = $false
            }
        }
        $recordPath = Join-Path $output 'artifact-verification.json'
        [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $outputs = @(Get-ChildItem -LiteralPath $output -File -Force)
        if ($outputs.Count -ne 2 -or -not (Test-Path -LiteralPath $recordPath -PathType Leaf) -or -not (Test-Path -LiteralPath $exportedInstaller -PathType Leaf)) {
            throw 'Sanitized artifact export contains an unexpected file set.'
        }
        return [pscustomobject]@{
            Installer = $exportedInstaller
            Record = $recordPath
            InstallerSha256 = [string]$receipt.installer.sha256
            RecordSha256 = Get-ExactSha256 -Path $recordPath
        }
    } finally {
        Close-ArtifactReadLocks -Locks $claimedLocks
        $receiptLock.Dispose()
    }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$result = Export-SignedOcrArtifact `
    -ProjectRoot $projectRoot `
    -SourceRoot $SourceRoot `
    -OutputRoot $OutputRoot `
    -ExpectedPublisher $ExpectedPublisher `
    -SourceRevision $SourceRevision
Write-Output ("Exported installer SHA-256: " + $result.InstallerSha256)
Write-Output ("Exported verification record SHA-256: " + $result.RecordSha256)
