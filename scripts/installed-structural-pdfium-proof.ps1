[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PdfiumPath,
    [Parameter(Mandatory = $true)][string]$PdfPath,
    [Parameter(Mandatory = $true)][ValidateRange(1,64)][int]$ExpectedPages,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

try {
    . (Join-Path $PSScriptRoot 'installed-structural-page-tools.ps1')
    foreach ($path in @($PdfiumPath,$PdfPath)) {
        Assert-NoReparseAncestors -Path $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A structural PDFium child input is missing.' }
    }
    Assert-NoReparseAncestors -Path $OutputPath
    if (Test-Path -LiteralPath $OutputPath) { throw 'Structural PDFium child output must be fresh.' }
    $parent = Split-Path -Parent $OutputPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Structural PDFium child output parent is missing.' }
    $proof = Get-StructuralPdfiumProofInProcess -PdfiumPath $PdfiumPath -PdfPath $PdfPath -ExpectedPages $ExpectedPages
    $record = [ordered]@{pages=[int]$proof.Pages;widthPoints=[double[]]$proof.WidthPoints;heightPoints=[double[]]$proof.HeightPoints;pageFingerprintSha256=[string[]]$proof.PageFingerprintSha256}
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Depth 4 -Compress))
    if ($bytes.Length -le 0 -or $bytes.Length -gt $script:StructuralPins.PdfiumProofRecordBytesMaximum) { throw 'Structural PDFium child output exceeded its exact byte cap.' }
    $stream = [IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
} catch {
    exit 1
}
