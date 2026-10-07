param([string]$ArchiveUri = 'https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7881/pdfium-win-x64.tgz', [switch]$SkipIfCurrent)
$ErrorActionPreference = 'Stop'
$archiveSha256 = '73CC0DE638AC2095E7445BF56A38200A5B7C7CA0E9F4BA144598F2457377AC08'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resourceRoot = Join-Path $projectRoot 'src-tauri\resources'
$archivePath = Join-Path $resourceRoot 'pdfium-win-x64.tgz'
$pdfiumRoot = Join-Path $resourceRoot 'pdfium'
$markerName = '.verified-archive'
function Get-VerifiedMarker([string]$Root) {
    $dll = Join-Path $Root 'bin\pdfium.dll'
    "archive-sha256=$archiveSha256`npdfium.dll-sha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $dll).Hash)`n"
}
if ($SkipIfCurrent) {
    $markerPath = Join-Path $pdfiumRoot $markerName
    if ((Test-Path -LiteralPath $markerPath -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $pdfiumRoot 'bin\pdfium.dll') -PathType Leaf)) {
        if ([IO.File]::ReadAllText($markerPath) -ceq (Get-VerifiedMarker $pdfiumRoot)) {
            Write-Output 'PDFium Chromium 7881 already extracted from the SHA-256 verified archive.'
            return
        }
    }
}
New-Item -ItemType Directory -Path $resourceRoot -Force | Out-Null
try {
    Invoke-WebRequest -Uri $ArchiveUri -OutFile $archivePath
    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
} catch {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    throw
}
if ($actualSha256 -ne $archiveSha256) {
    Remove-Item -LiteralPath $archivePath -Force
    throw "PDFium archive SHA-256 mismatch: expected $archiveSha256, got $actualSha256. The download was deleted and nothing was extracted."
}
$stagingRoot = Join-Path $resourceRoot ('.pdfium-staging-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $stagingRoot | Out-Null
    tar -xzf $archivePath -C $stagingRoot
    if ($LASTEXITCODE -ne 0) { throw 'PDFium extraction failed. The existing pdfium folder was left unchanged.' }
    if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot 'bin\pdfium.dll') -PathType Leaf)) { throw 'PDFium archive has no bin/pdfium.dll. The existing pdfium folder was left unchanged.' }
    [IO.File]::WriteAllText((Join-Path $stagingRoot $markerName), (Get-VerifiedMarker $stagingRoot))
    if (Test-Path -LiteralPath $pdfiumRoot) { Remove-Item -LiteralPath $pdfiumRoot -Recurse -Force }
    Move-Item -LiteralPath $stagingRoot -Destination $pdfiumRoot
} finally {
    if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Output 'PDFium Chromium 7881 (SHA-256 verified) extracted with its license notices.'
