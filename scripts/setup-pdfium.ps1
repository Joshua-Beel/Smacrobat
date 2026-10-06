param([string]$ArchiveUri = 'https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7881/pdfium-win-x64.tgz')
$ErrorActionPreference = 'Stop'
$archiveSha256 = '73CC0DE638AC2095E7445BF56A38200A5B7C7CA0E9F4BA144598F2457377AC08'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resourceRoot = Join-Path $projectRoot 'src-tauri\resources'
$archivePath = Join-Path $resourceRoot 'pdfium-win-x64.tgz'
$pdfiumRoot = Join-Path $resourceRoot 'pdfium'
New-Item -ItemType Directory -Path $resourceRoot -Force | Out-Null
try {
    Invoke-WebRequest -Uri $ArchiveUri -OutFile $archivePath
    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
} catch {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    throw
}
if ($actualSha256 -cne $archiveSha256) {
    Remove-Item -LiteralPath $archivePath -Force
    throw "PDFium archive SHA-256 mismatch: expected $archiveSha256, got $actualSha256. The download was deleted and nothing was extracted."
}
New-Item -ItemType Directory -Path $pdfiumRoot -Force | Out-Null
tar -xzf $archivePath -C $pdfiumRoot
if ($LASTEXITCODE -ne 0) { throw 'PDFium extraction failed.' }
Write-Output 'PDFium Chromium 7881 (SHA-256 verified) extracted with its license notices.'
