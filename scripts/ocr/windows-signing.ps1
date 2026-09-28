$ErrorActionPreference = 'Stop'

function Get-SigningSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '') }
        finally { $algorithm.Dispose() }
    } finally { $stream.Dispose() }
}

function Get-SigningRangeSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes, [Parameter(Mandatory = $true)][int]$Offset, [Parameter(Mandatory = $true)][int]$Count)
    if ($Offset -lt 0 -or $Count -lt 0 -or $Offset + $Count -gt $Bytes.Length) { throw 'Signing comparison range is invalid.' }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes, $Offset, $Count))).Replace('-', '') }
    finally { $algorithm.Dispose() }
}

function Get-WindowsSignatureFacts {
    param([Parameter(Mandatory = $true)][string]$Path, [scriptblock]$SignatureProvider)
    if ($SignatureProvider) { return & $SignatureProvider $Path }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $publisher = if ($signature.SignerCertificate) {
        $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    } else { $null }
    return [pscustomobject]@{
        Status = $signature.Status.ToString()
        Publisher = $publisher
        HasTimestamp = [bool]$signature.TimeStamperCertificate
    }
}

function Assert-TrustedWindowsSignature {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$SignatureProvider,
        [string]$ExpectedPublisher = 'Joshua Beel'
    )
    $facts = Get-WindowsSignatureFacts -Path $Path -SignatureProvider $SignatureProvider
    if ([string]$facts.Status -cne 'Valid') { throw 'Authenticode signature is not valid.' }
    if ([string]$facts.Publisher -cne $ExpectedPublisher) { throw 'Authenticode signature publisher is not trusted.' }
    if (-not [bool]$facts.HasTimestamp) { throw 'Authenticode signature has no trusted timestamp.' }
    return $facts
}

function Assert-UnsignedWindowsFile {
    param([Parameter(Mandatory = $true)][string]$Path, [scriptblock]$SignatureProvider)
    $facts = Get-WindowsSignatureFacts -Path $Path -SignatureProvider $SignatureProvider
    if ([string]$facts.Status -cne 'NotSigned') { throw 'Original OCR engine must be exactly Authenticode NotSigned.' }
}

function Invoke-OcrAwareTauriSigner {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ExpectedOcrEnginePath,
        [uint64]$ExpectedOcrEngineBytes,
        [string]$ExpectedOcrEngineSha256,
        [scriptblock]$Signer,
        [scriptblock]$SignatureProvider,
        [string]$ExpectedPublisher = 'Joshua Beel'
    )
    $candidate = [IO.Path]::GetFullPath($Path)
    Assert-NoReparseAncestors -Path $candidate
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'Tauri signing candidate is missing.' }

    $hasOcrExpectation = -not [string]::IsNullOrWhiteSpace($ExpectedOcrEnginePath)
    if ($hasOcrExpectation) {
        if ($ExpectedOcrEngineSha256 -cnotmatch '^[A-F0-9]{64}$' -or $ExpectedOcrEngineBytes -eq 0) {
            throw 'Trusted OCR engine receipt is invalid.'
        }
        $trusted = [IO.Path]::GetFullPath($ExpectedOcrEnginePath)
        Assert-NoReparseAncestors -Path $trusted
        if (-not [IO.Path]::GetFileName($trusted).Equals('tesseract.exe', [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $trusted -PathType Leaf)) {
            throw 'Trusted OCR engine path is invalid.'
        }
        if ([IO.Path]::GetFileName($candidate).Equals('tesseract.exe', [StringComparison]::OrdinalIgnoreCase)) {
            if (-not $candidate.Equals($trusted, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Unexpected Tesseract signing candidate was refused.'
            }
            $file = Get-Item -LiteralPath $candidate
            if ([uint64]$file.Length -ne $ExpectedOcrEngineBytes -or (Get-SigningSha256 -Path $candidate) -cne $ExpectedOcrEngineSha256) {
                throw 'Pre-signed OCR engine receipt changed before Tauri signing.'
            }
            $null = Assert-TrustedWindowsSignature -Path $candidate -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher
            return 'SkippedTrustedOcrEngine'
        }
    }

    if (-not $Signer) { throw 'Windows signer callback is required.' }
    $exitCode = & $Signer $candidate
    if ($null -ne $exitCode -and [int]$exitCode -ne 0) { throw 'Windows signer failed.' }
    return 'Signed'
}

function New-SignedOcrSetup {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)]$OriginalPlan,
        [Parameter(Mandatory = $true)][string]$OutputRoot,
        [Parameter(Mandatory = $true)][scriptblock]$Signer,
        [scriptblock]$SignatureProvider,
        [scriptblock]$PlanVerifier,
        [string]$ExpectedPublisher = 'Joshua Beel'
    )
    $output = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
    $stage = Join-Path $output 'signed-ocr-setup'
    Assert-NoReparseAncestors -Path $output
    if (-not (Test-Path -LiteralPath $output -PathType Container)) { throw 'Signed OCR output root is missing.' }
    if (Test-Path -LiteralPath $stage) { throw 'Signed OCR staging root already exists.' }

    $engine = @($OriginalPlan.Files | Where-Object Role -CEQ 'engine')
    if ($engine.Count -ne 1) { throw 'Original OCR plan has no unique engine.' }
    Assert-UnsignedWindowsFile -Path $engine[0].Source -SignatureProvider $SignatureProvider
    $originalBytes = [uint64](Get-Item -LiteralPath $engine[0].Source).Length
    $originalSha256 = Get-SigningSha256 -Path $engine[0].Source
    if ($originalBytes -ne [uint64]$engine[0].Receipt.Bytes -or $originalSha256 -cne [string]$engine[0].Receipt.Sha256) {
        throw 'Original OCR engine changed before staging.'
    }

    [IO.Directory]::CreateDirectory($stage) | Out-Null
    Assert-NoReparseAncestors -Path $stage
    foreach ($file in $OriginalPlan.Files) {
        $sourceItem = Get-Item -LiteralPath $file.Source
        if ([uint64]$sourceItem.Length -ne [uint64]$file.Receipt.Bytes -or (Get-SigningSha256 -Path $file.Source) -cne [string]$file.Receipt.Sha256) {
            throw 'Original OCR setup changed before staging.'
        }
        $destination = Join-Path $stage $file.Receipt.Path
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        [IO.File]::Copy($file.Source, $destination, $false)
    }
    $manifestDestination = Join-Path $stage 'engine/ocr-engine-manifest.json'
    [IO.File]::Copy($OriginalPlan.ManifestPath, $manifestDestination, $false)

    $stagedEngine = Join-Path $stage 'engine/bin/tesseract.exe'
    $exitCode = & $Signer $stagedEngine
    if ($null -ne $exitCode -and [int]$exitCode -ne 0) { throw 'OCR engine signer failed.' }
    $null = Assert-TrustedWindowsSignature -Path $stagedEngine -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher
    $signedItem = Get-Item -LiteralPath $stagedEngine
    if ([uint64]$signedItem.Length -gt 64MB) { throw 'Signed OCR engine exceeds the supported size.' }
    $signedSha256 = Get-SigningSha256 -Path $stagedEngine

    try { $manifest = Get-Content -LiteralPath $manifestDestination -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Staged OCR manifest is invalid JSON.' }
    $manifest.artifacts.executable.bytes = [uint64]$signedItem.Length
    $manifest.artifacts.executable.sha256 = $signedSha256
    [IO.File]::WriteAllText($manifestDestination, ($manifest | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))

    $derived = if ($PlanVerifier) {
        & $PlanVerifier $ProjectRoot $stage
    } else {
        Get-VerifiedOcrSetup -ProjectRoot $ProjectRoot -SetupRoot $stage
    }
    if ($derived.Identity -cne $signedSha256.ToLowerInvariant() -or
        [uint64]$derived.Engine.Bytes -ne [uint64]$signedItem.Length -or
        [string]$derived.Engine.Sha256 -cne $signedSha256) {
        throw 'Derived OCR plan does not bind the signed engine identity.'
    }
    if ((Get-SigningSha256 -Path $engine[0].Source) -cne $originalSha256 -or [uint64](Get-Item -LiteralPath $engine[0].Source).Length -ne $originalBytes) {
        throw 'Original OCR engine changed while deriving the signed setup.'
    }
    Assert-UnsignedWindowsFile -Path $engine[0].Source -SignatureProvider $SignatureProvider
    return $derived
}

function Get-PeSigningLayout {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    if ($Bytes.Length -lt 256 -or $Bytes[0] -ne 0x4d -or $Bytes[1] -ne 0x5a) { throw 'PE image has an invalid DOS header.' }
    $peOffset = [BitConverter]::ToUInt32($Bytes, 0x3c)
    if ($peOffset -lt 0x40 -or [uint64]$peOffset + 24 -gt [uint64]$Bytes.Length) { throw 'PE header offset is out of bounds.' }
    if ($Bytes[$peOffset] -ne 0x50 -or $Bytes[$peOffset + 1] -ne 0x45 -or $Bytes[$peOffset + 2] -ne 0 -or $Bytes[$peOffset + 3] -ne 0) { throw 'PE signature is invalid.' }
    $optionalBytes = [BitConverter]::ToUInt16($Bytes, $peOffset + 20)
    $optionalOffset = [uint32]$peOffset + 24
    if ([uint64]$optionalOffset + $optionalBytes -gt [uint64]$Bytes.Length) { throw 'PE optional header is out of bounds.' }
    $magic = [BitConverter]::ToUInt16($Bytes, $optionalOffset)
    if ($magic -eq 0x20b) { $directoryCountOffset = $optionalOffset + 108; $directoryOffset = $optionalOffset + 112 }
    elseif ($magic -eq 0x10b) { $directoryCountOffset = $optionalOffset + 92; $directoryOffset = $optionalOffset + 96 }
    else { throw 'PE optional header format is unsupported.' }
    $securityOffset = $directoryOffset + 32
    if ($optionalBytes -lt ($securityOffset + 8 - $optionalOffset) -or $directoryCountOffset + 4 -gt $Bytes.Length) { throw 'PE data directories are truncated.' }
    if ([BitConverter]::ToUInt32($Bytes, $directoryCountOffset) -lt 5) { throw 'PE security directory is absent.' }
    return [pscustomobject]@{
        PeOffset = [uint32]$peOffset
        OptionalOffset = [uint32]$optionalOffset
        OptionalBytes = [uint16]$optionalBytes
        Magic = [uint16]$magic
        ChecksumOffset = [uint32]($optionalOffset + 64)
        SecurityOffset = [uint32]$securityOffset
        CertificateOffset = [uint32][BitConverter]::ToUInt32($Bytes, $securityOffset)
        CertificateBytes = [uint32][BitConverter]::ToUInt32($Bytes, $securityOffset + 4)
    }
}

function Assert-SignedPeBodyEquivalent {
    param([Parameter(Mandatory = $true)][string]$UnsignedPath, [Parameter(Mandatory = $true)][string]$SignedPath)
    $unsigned = [IO.File]::ReadAllBytes($UnsignedPath)
    $signed = [IO.File]::ReadAllBytes($SignedPath)
    $before = Get-PeSigningLayout -Bytes $unsigned
    $after = Get-PeSigningLayout -Bytes $signed
    if ($before.PeOffset -ne $after.PeOffset -or $before.OptionalOffset -ne $after.OptionalOffset -or
        $before.OptionalBytes -ne $after.OptionalBytes -or $before.Magic -ne $after.Magic -or
        $before.ChecksumOffset -ne $after.ChecksumOffset -or $before.SecurityOffset -ne $after.SecurityOffset) {
        throw 'Signed PE layout changed.'
    }
    if ($before.CertificateOffset -ne 0 -or $before.CertificateBytes -ne 0) { throw 'Unsigned PE already has a certificate table.' }
    $certificateOffset = [uint64]$after.CertificateOffset
    $certificateBytes = [uint64]$after.CertificateBytes
    if ($certificateOffset -lt [uint64]$unsigned.Length -or $certificateOffset % 8 -ne 0 -or
        $certificateOffset - [uint64]$unsigned.Length -gt 7 -or $certificateBytes -lt 8 -or
        $certificateOffset + $certificateBytes -ne [uint64]$signed.Length) {
        throw 'Signed PE certificate table bounds are invalid.'
    }
    $ranges = @(
        @([int]0, [int]$before.ChecksumOffset),
        @([int]($before.ChecksumOffset + 4), [int]($before.SecurityOffset - ($before.ChecksumOffset + 4))),
        @([int]($before.SecurityOffset + 8), [int]($unsigned.Length - ($before.SecurityOffset + 8)))
    )
    foreach ($range in $ranges) {
        if ((Get-SigningRangeSha256 -Bytes $unsigned -Offset $range[0] -Count $range[1]) -cne
            (Get-SigningRangeSha256 -Bytes $signed -Offset $range[0] -Count $range[1])) {
            throw 'Signed PE changed bytes outside Authenticode fields.'
        }
    }
    for ($index = $unsigned.Length; $index -lt [int]$certificateOffset; $index++) {
        if ($signed[$index] -ne 0) { throw 'Signed PE alignment gap is not zero-filled.' }
    }
    $certificateLength = [uint64][BitConverter]::ToUInt32($signed, [int]$certificateOffset)
    $revision = [BitConverter]::ToUInt16($signed, [int]$certificateOffset + 4)
    $certificateType = [BitConverter]::ToUInt16($signed, [int]$certificateOffset + 6)
    $alignedLength = ($certificateLength + 7) -band (-bnot [uint64]7)
    if ($certificateLength -lt 8 -or $alignedLength -ne $certificateBytes -or $revision -ne 0x0200 -or $certificateType -ne 0x0002) {
        throw 'Signed PE WIN_CERTIFICATE is invalid.'
    }
    for ($index = [int]($certificateOffset + $certificateLength); $index -lt $signed.Length; $index++) {
        if ($signed[$index] -ne 0) { throw 'Signed PE certificate padding is not zero-filled.' }
    }
}

function Assert-SignedPdfiumEquivalent {
    param(
        [Parameter(Mandatory = $true)][string]$UnsignedPath,
        [Parameter(Mandatory = $true)][string]$SignedPath,
        [scriptblock]$SignatureProvider,
        [string]$ExpectedPublisher = 'Joshua Beel'
    )
    Assert-SignedPeBodyEquivalent -UnsignedPath $UnsignedPath -SignedPath $SignedPath
    $null = Assert-TrustedWindowsSignature -Path $SignedPath -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher
}
