param([string]$ArchiveUri = 'https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7881/pdfium-win-x64.tgz', [switch]$SkipIfCurrent, [switch]$TestOnlyFailStagingMove)
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
$swapId = [guid]::NewGuid().ToString('N')
$stagingRoot = Join-Path $resourceRoot ".pdfium-staging-$swapId"
$backupRoot = Join-Path $resourceRoot ".pdfium-backup-$swapId"
$swapped = $false
try {
    New-Item -ItemType Directory -Path $stagingRoot | Out-Null
    tar -xzf $archivePath -C $stagingRoot
    if ($LASTEXITCODE -ne 0) { throw 'PDFium extraction failed. The existing pdfium folder was left unchanged.' }
    if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot 'bin\pdfium.dll') -PathType Leaf)) { throw 'PDFium archive has no bin/pdfium.dll. The existing pdfium folder was left unchanged.' }
    [IO.File]::WriteAllText((Join-Path $stagingRoot $markerName), (Get-VerifiedMarker $stagingRoot))
    if (Test-Path -LiteralPath $pdfiumRoot) {
        try { [IO.Directory]::Move($pdfiumRoot, $backupRoot) }
        catch { throw "Could not move the existing pdfium folder aside ($($_.Exception.Message)). The existing pdfium folder was left unchanged." }
    }
    try {
        if ($TestOnlyFailStagingMove) { throw 'Test-only injected failure moving the staged PDFium folder into place.' }
        [IO.Directory]::Move($stagingRoot, $pdfiumRoot)
    } catch {
        $moveError = $_
        if (Test-Path -LiteralPath $backupRoot) {
            try { [IO.Directory]::Move($backupRoot, $pdfiumRoot) }
            catch { throw "Moving the staged PDFium folder into place failed ($($moveError.Exception.Message)) and the previous pdfium folder could not be restored ($($_.Exception.Message)). It is preserved at $backupRoot." }
        }
        throw "Moving the staged PDFium folder into place failed ($($moveError.Exception.Message)). The previous pdfium folder was restored unchanged."
    }
    $swapped = $true
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        try { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
        catch { Write-Warning "Could not remove PDFium staging folder ${stagingRoot}: $($_.Exception.Message)" }
    }
    if ($swapped -and (Test-Path -LiteralPath $backupRoot)) {
        try { Remove-Item -LiteralPath $backupRoot -Recurse -Force }
        catch { Write-Warning "Could not remove previous PDFium folder backup ${backupRoot}: $($_.Exception.Message)" }
    }
}
Write-Output 'PDFium Chromium 7881 (SHA-256 verified) extracted with its license notices.'
