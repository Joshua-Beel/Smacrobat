param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$Version
)

$package = Get-Content (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$packageLock = Get-Content (Join-Path $ProjectRoot 'package-lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
$lockRoot = $packageLock['packages']['']
$tauri = Get-Content (Join-Path $ProjectRoot 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cargo = Get-Content (Join-Path $ProjectRoot 'src-tauri/Cargo.toml') -Raw -Encoding UTF8
$cargoVersionMatch = [regex]::Match($cargo, '(?m)^version = "([^"]+)"\r?$')
$cargoLock = Get-Content (Join-Path $ProjectRoot 'src-tauri/Cargo.lock') -Raw -Encoding UTF8
$cargoLockMatches = [regex]::Matches($cargoLock, '(?m)^name = "pdf-workstation"\r?\nversion = "([^"]+)"\r?$')
if (-not $lockRoot -or -not $cargoVersionMatch.Success -or $cargoLockMatches.Count -ne 1) {
    throw 'Could not resolve every release version source exactly once.'
}
$versions = @($package.version, $packageLock.version, $lockRoot.version, $tauri.version, $cargoVersionMatch.Groups[1].Value, $cargoLockMatches[0].Groups[1].Value)
if (@($versions | Where-Object { $_ -cne $Version }).Count -ne 0) {
    throw 'Tag, npm, Cargo, lockfile, and Tauri versions must agree exactly.'
}
