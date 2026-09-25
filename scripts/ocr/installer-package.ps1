$ErrorActionPreference = 'Stop'

$script:OcrRecipePaths = @(
    'scripts/setup-ocr.ps1',
    'scripts/ocr/pins.json',
    'scripts/ocr/tesseract-options.cmake',
    'scripts/ocr/generate-smoke.ps1'
)
$script:OcrLicensePaths = @(
    'engine/licenses/Tesseract-Apache-2.0.txt',
    'engine/licenses/Leptonica-BSD-2-Clause.txt',
    'engine/licenses/eng-fast-Apache-2.0.txt'
)
$script:OcrModelBytes = 4113088
$script:OcrModelSha256 = '7D4322BD2A7749724879683FC3912CB542F19906C83BCC1A52132556427170B2'

function Get-ExactSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '') }
        finally { $algorithm.Dispose() }
    } finally { $stream.Dispose() }
}

function Assert-NoReparseAncestors {
    param([Parameter(Mandatory = $true)][string]$Path)
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Installer packaging paths cannot contain reparse points.'
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if (-not $parent) { break }
        $cursor = $parent.FullName
    }
}

function Resolve-FreshInstallerOutput {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$OutputRoot
    )
    $repository = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $target = [IO.Path]::GetFullPath((Join-Path $repository 'target')).TrimEnd('\')
    $candidate = if ([IO.Path]::IsPathRooted($OutputRoot)) {
        [IO.Path]::GetFullPath($OutputRoot)
    } else {
        [IO.Path]::GetFullPath((Join-Path $repository $OutputRoot))
    }
    if (-not $candidate.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installer OutputRoot must be a new directory beneath this repository target directory.'
    }
    Assert-NoReparseAncestors -Path $candidate
    if (Test-Path -LiteralPath $candidate) { throw 'Installer OutputRoot already exists.' }
    [IO.Directory]::CreateDirectory($candidate) | Out-Null
    Assert-NoReparseAncestors -Path $candidate
    return $candidate
}

function Get-InstallerExtractor {
    $path = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
    Assert-NoReparseAncestors -Path $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'Install 7-Zip in Program Files before running bounded installer extraction verification.'
    }
    return Get-Item -LiteralPath $path
}

function Convert-OcrReceipt {
    param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$Name)
    $path = [string]$Value.path
    $bytes = [uint64]$Value.bytes
    $sha256 = ([string]$Value.sha256).ToUpperInvariant()
    if ($path -cnotmatch '^[A-Za-z0-9._/-]+$' -or $path.Contains('..') -or [IO.Path]::IsPathRooted($path)) {
        throw "Invalid OCR $Name receipt path."
    }
    if ($bytes -eq 0 -or $sha256 -cnotmatch '^[A-F0-9]{64}$') { throw "Invalid OCR $Name receipt." }
    return [pscustomobject]@{ Path = $path; Bytes = $bytes; Sha256 = $sha256 }
}

function Assert-ReceiptFile {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)][string]$Kind
    )
    $path = [IO.Path]::GetFullPath((Join-Path $Root $Receipt.Path))
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $path.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "OCR $Kind escaped its root." }
    Assert-NoReparseAncestors -Path $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "OCR $Kind is missing." }
    $file = Get-Item -LiteralPath $path
    if ([uint64]$file.Length -ne [uint64]$Receipt.Bytes -or (Get-ExactSha256 -Path $path) -cne $Receipt.Sha256) {
        throw "OCR $Kind receipt mismatch."
    }
    return $path
}

function Assert-ExactReceiptPaths {
    param([Parameter(Mandatory = $true)][object[]]$Receipts, [Parameter(Mandatory = $true)][string[]]$Expected, [string]$Kind)
    $actual = @($Receipts | ForEach-Object Path | Sort-Object -CaseSensitive)
    $wanted = @($Expected | Sort-Object -CaseSensitive)
    if ($actual.Count -ne $wanted.Count -or (Compare-Object $wanted $actual -CaseSensitive)) {
        throw "OCR $Kind receipts do not match the exact expected set."
    }
}

function Get-VerifiedOcrSetup {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$SetupRoot
    )
    $repository = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $root = if ([IO.Path]::IsPathRooted($SetupRoot)) { [IO.Path]::GetFullPath($SetupRoot) } else { [IO.Path]::GetFullPath((Join-Path $repository $SetupRoot)) }
    Assert-NoReparseAncestors -Path $root
    $manifestPath = Join-Path $root 'engine/ocr-engine-manifest.json'
    Assert-NoReparseAncestors -Path $manifestPath
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'OCR setup manifest is missing.' }
    if ((Get-Item -LiteralPath $manifestPath).Length -gt 1MB) { throw 'OCR setup manifest is too large.' }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'OCR setup manifest is invalid JSON.' }
    if ($manifest.schemaVersion -ne 1 -or $manifest.versions.recipe -cne '1' -or
        $manifest.versions.tesseract.version -cne '5.5.3' -or $manifest.versions.tesseract.commit -cne 'db0ec62f81b0737fbbe184d8fea40af5738f8eef' -or
        $manifest.versions.leptonica.version -cne '1.87.0' -or $manifest.versions.leptonica.commit -cne '13275a278eb55b5746e33f95fbf5a2c8f604b3ab' -or
        $manifest.versions.model.language -cne 'eng' -or $manifest.versions.model.variant -cne 'fast' -or
        $manifest.versions.model.version -cne '4.1.0' -or $manifest.versions.model.commit -cne '65727574dfcd264acbb0c3e07860e4e9e9b22185' -or
        $manifest.build.architecture -cne 'x64' -or $manifest.build.configuration -cne 'Release' -or
        $manifest.build.runtimeLibrary -cne 'MultiThreaded' -or $manifest.build.tesseractCompileDefinition -cne 'TESSERACT_DISABLE_DEBUG_FONTS') {
        throw 'OCR setup identity or build configuration is unsupported.'
    }
    $engine = Convert-OcrReceipt -Value $manifest.artifacts.executable -Name 'engine'
    $model = Convert-OcrReceipt -Value $manifest.artifacts.model -Name 'model'
    $recipes = @($manifest.artifacts.recipeInputs | ForEach-Object { Convert-OcrReceipt -Value $_ -Name 'recipe input' })
    $licenses = @($manifest.artifacts.licenses | ForEach-Object { Convert-OcrReceipt -Value $_ -Name 'license' })
    if ($engine.Path -cne 'engine/bin/tesseract.exe' -or $engine.Bytes -gt 64MB) { throw 'OCR engine receipt is unsupported.' }
    if ($model.Path -cne 'engine/tessdata/eng.traineddata' -or $model.Bytes -ne $script:OcrModelBytes -or $model.Sha256 -cne $script:OcrModelSha256) { throw 'OCR model receipt is unsupported.' }
    Assert-ExactReceiptPaths -Receipts $recipes -Expected $script:OcrRecipePaths -Kind 'recipe input'
    Assert-ExactReceiptPaths -Receipts $licenses -Expected $script:OcrLicensePaths -Kind 'license'
    foreach ($receipt in $recipes) { $null = Assert-ReceiptFile -Root $repository -Receipt $receipt -Kind 'recipe input' }
    $enginePath = Assert-ReceiptFile -Root $root -Receipt $engine -Kind 'engine'
    $modelPath = Assert-ReceiptFile -Root $root -Receipt $model -Kind 'model'
    $files = @(
        [pscustomobject]@{ Role = 'engine'; Receipt = $engine; Source = $enginePath; Suffix = 'bin/tesseract.exe' },
        [pscustomobject]@{ Role = 'model'; Receipt = $model; Source = $modelPath; Suffix = 'tessdata/eng.traineddata' }
    )
    foreach ($license in $licenses) {
        $source = Assert-ReceiptFile -Root $root -Receipt $license -Kind 'license'
        $files += [pscustomobject]@{ Role = 'license'; Receipt = $license; Source = $source; Suffix = 'licenses/' + [IO.Path]::GetFileName($license.Path) }
    }
    return [pscustomobject]@{
        Root = $root
        ManifestPath = $manifestPath
        ManifestSha256 = Get-ExactSha256 -Path $manifestPath
        Engine = $engine
        Model = $model
        Licenses = $licenses
        Files = $files
        Identity = $engine.Sha256.ToLowerInvariant()
    }
}

function Open-OcrReadLocks {
    param([Parameter(Mandatory = $true)]$Plan)
    $locks = New-Object Collections.Generic.List[IO.FileStream]
    try {
        foreach ($file in $Plan.Files) {
            $locks.Add([IO.File]::Open($file.Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        }
        return ,$locks
    } catch {
        foreach ($lock in $locks) { $lock.Dispose() }
        throw
    }
}

function Open-PathReadLocks {
    param([Parameter(Mandatory = $true)][string[]]$Paths)
    $locks = New-Object Collections.Generic.List[IO.FileStream]
    try {
        foreach ($path in $Paths) {
            $locks.Add([IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        }
        return ,$locks
    } catch {
        foreach ($lock in $locks) { $lock.Dispose() }
        throw
    }
}

function Copy-OcrPackageFiles {
    param([Parameter(Mandatory = $true)]$Plan, [Parameter(Mandatory = $true)][string]$CargoTarget)
    $root = Join-Path $CargoTarget ("release/resources/ocr/" + $Plan.Identity)
    Assert-NoReparseAncestors -Path $root
    if (Test-Path -LiteralPath $root) { throw 'OCR package resource identity already exists.' }
    foreach ($file in $Plan.Files) {
        $destination = Join-Path $root $file.Suffix
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        Assert-NoReparseAncestors -Path $destination
        [IO.File]::Copy($file.Source, $destination, $false)
    }
    return Assert-OcrPackageFiles -Plan $Plan -ResourceRoot $root
}

function Assert-OcrPackageFiles {
    param([Parameter(Mandatory = $true)]$Plan, [Parameter(Mandatory = $true)][string]$ResourceRoot)
    Assert-NoReparseAncestors -Path $ResourceRoot
    $actual = @(Get-ChildItem -LiteralPath $ResourceRoot -Recurse -File | ForEach-Object { $_.FullName.Substring($ResourceRoot.Length).TrimStart('\').Replace('\', '/') })
    $expected = @($Plan.Files | ForEach-Object Suffix)
    if ($actual.Count -ne 5 -or (Compare-Object ($expected | Sort-Object) ($actual | Sort-Object) -CaseSensitive)) { throw 'OCR package resource set is not exactly five files.' }
    $entries = @()
    foreach ($file in $Plan.Files) {
        $path = Join-Path $ResourceRoot $file.Suffix
        $null = Assert-ReceiptFile -Root $ResourceRoot -Receipt ([pscustomobject]@{ Path = $file.Suffix; Bytes = $file.Receipt.Bytes; Sha256 = $file.Receipt.Sha256 }) -Kind 'package resource'
        $entries += [pscustomobject]@{ Source = $path; Target = "resources/ocr/$($Plan.Identity)/$($file.Suffix)"; Role = $file.Role; Receipt = $file.Receipt }
    }
    return $entries
}

function Get-OcrBundleEntries {
    param([Parameter(Mandatory = $true)]$Plan)
    $entries = @()
    foreach ($file in $Plan.Files) {
        $entries += [pscustomobject]@{
            Source = $file.Source
            Target = "resources/ocr/$($Plan.Identity)/$($file.Suffix)"
            Role = $file.Role
            Receipt = $file.Receipt
        }
    }
    return $entries
}

function Get-BaseBundleResourceMap {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $srcTauri = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'src-tauri')).TrimEnd('\')
    $configPath = Join-Path $srcTauri 'tauri.conf.json'
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not ($config.bundle.resources -is [Array])) { throw 'Base Tauri resources must remain an array before installer expansion.' }
    $map = [ordered]@{}
    $sourceKeys = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $targets = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entryValue in @($config.bundle.resources)) {
        $entry = [string]$entryValue
        if ($entry -cnotmatch '^resources/[A-Za-z0-9._/*?-]+$' -or $entry.Contains('..') -or [IO.Path]::IsPathRooted($entry)) { throw 'Base Tauri resource entry is unsafe.' }
        $pattern = Join-Path $srcTauri $entry
        $hasWildcard = $entry.IndexOfAny([char[]]'*?[') -ge 0
        if ($hasWildcard) {
            $files = @(Get-ChildItem -Path $pattern -File -ErrorAction Stop)
        } elseif (Test-Path -LiteralPath $pattern -PathType Container) {
            $files = @(Get-ChildItem -LiteralPath $pattern -Recurse -File)
        } elseif (Test-Path -LiteralPath $pattern -PathType Leaf) {
            $files = @(Get-Item -LiteralPath $pattern)
        } else {
            $files = @()
        }
        if ($files.Count -eq 0) { throw 'Base Tauri resource entry expanded to no files.' }
        foreach ($file in $files) {
            Assert-NoReparseAncestors -Path $file.FullName
            $relative = $file.FullName.Substring($srcTauri.Length + 1).Replace('\', '/')
            if (-not $relative.StartsWith('resources/', [StringComparison]::Ordinal)) { throw 'Base Tauri resource escaped resources.' }
            if (-not $sourceKeys.Add($file.FullName) -or -not $targets.Add($relative)) { throw 'Base Tauri resource expansion has a duplicate or case collision.' }
            $map[$file.FullName] = $relative
        }
    }
    $entries = @()
    foreach ($source in $map.Keys) {
        $item = Get-Item -LiteralPath $source
        $entries += [pscustomobject]@{
            Source = $source
            Target = $map[$source]
            Receipt = [pscustomobject]@{ Bytes = [uint64]$item.Length; Sha256 = Get-ExactSha256 -Path $source }
        }
    }
    return [pscustomobject]@{ Map = $map; SourceKeys = $sourceKeys; Targets = $targets; Count = $map.Count; Entries = $entries }
}

function Assert-BaseResourceMapStable {
    param([Parameter(Mandatory = $true)]$Before, [Parameter(Mandatory = $true)]$After)
    $beforePairs = @($Before.Entries | ForEach-Object { $_.Source + '|' + $_.Target } | Sort-Object -CaseSensitive)
    $afterPairs = @($After.Entries | ForEach-Object { $_.Source + '|' + $_.Target } | Sort-Object -CaseSensitive)
    if ($Before.Count -ne $After.Count -or (Compare-Object $beforePairs $afterPairs -CaseSensitive)) {
        throw 'Base Tauri resource set changed while acquiring read locks.'
    }
}

function Add-OcrBundleResources {
    param(
        [Parameter(Mandatory = $true)]$Base,
        [Parameter(Mandatory = $true)][object[]]$Entries,
        [Parameter(Mandatory = $true)][string]$Identity
    )
    if ($Identity -cnotmatch '^[a-f0-9]{64}$') { throw 'OCR package identity is invalid.' }
    if ($Entries.Count -ne 5) { throw 'Exactly five OCR package entries are required.' }
    foreach ($entry in $Entries) {
        if ($entry.Target -cnotmatch '^resources/ocr/[a-f0-9]{64}/(bin/tesseract\.exe|tessdata/eng\.traineddata|licenses/(Tesseract-Apache-2\.0\.txt|Leptonica-BSD-2-Clause\.txt|eng-fast-Apache-2\.0\.txt))$') { throw 'OCR package target is invalid.' }
        if (-not $entry.Target.StartsWith("resources/ocr/$Identity/", [StringComparison]::Ordinal)) { throw 'OCR package target identity is incorrect.' }
        if ($entry.Source.IndexOfAny([char[]]'*?[') -ge 0 -or -not (Test-Path -LiteralPath $entry.Source -PathType Leaf)) { throw 'OCR package source is invalid.' }
        if (-not $Base.SourceKeys.Add([IO.Path]::GetFullPath($entry.Source)) -or -not $Base.Targets.Add($entry.Target)) { throw 'OCR package resource collides with another resource.' }
        $Base.Map[[IO.Path]::GetFullPath($entry.Source)] = $entry.Target
    }
    return $Base.Map
}

function New-InstallerOverrideConfig {
    param($SignCommand, [switch]$UnsignedLocal, $ResourceMap)
    $bundle = [ordered]@{}
    if ($UnsignedLocal) { $bundle.createUpdaterArtifacts = $false }
    if ($SignCommand) { $bundle.windows = @{ signCommand = $SignCommand } }
    if ($ResourceMap) { $bundle.resources = $ResourceMap }
    return @{ bundle = $bundle }
}

function Convert-SevenZipInventory {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Lines)
    $paths = @()
    $entriesStarted = $false
    foreach ($line in $Lines) {
        if ($line -ceq '----------') { $entriesStarted = $true; continue }
        if ($entriesStarted -and $line -cmatch '^Path = (.+)$') {
            $path = $Matches[1].Replace('\', '/')
            if ($path -match '^[A-Za-z]:/' -or $path.StartsWith('/') -or $path.Contains(':') -or $path -match '(^|/)\.\.(/|$)') {
                throw 'Installer archive contains an unsafe path.'
            }
            $paths += $path
        }
    }
    if ($paths.Count -eq 0) { throw 'Installer archive inventory is empty.' }
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $paths) {
        if (-not $seen.Add($path)) { throw 'Installer archive contains a duplicate or case-colliding path.' }
    }
    return $paths
}

function Assert-ArchiveResourceInventory {
    param(
        [Parameter(Mandatory = $true)][string[]]$ArchivePaths,
        [Parameter(Mandatory = $true)][object[]]$BaseEntries,
        $OcrPlan
    )
    foreach ($entry in $BaseEntries) {
        $matches = @($ArchivePaths | Where-Object { Test-ArchiveTargetMatch -ArchivePath $_ -Target $entry.Target })
        if ($matches.Count -ne 1) { throw 'Installer archive lost or duplicated a base resource path.' }
    }
    $ocrPaths = @($ArchivePaths | Where-Object { $_.StartsWith('resources/ocr/', [StringComparison]::OrdinalIgnoreCase) -or $_.ToLowerInvariant().Contains('/resources/ocr/') })
    if (-not $OcrPlan) {
        if ($ocrPaths.Count -ne 0) { throw 'Default installer archive unexpectedly contains OCR resources.' }
        return
    }
    $expected = @($OcrPlan.Files | ForEach-Object { "resources/ocr/$($OcrPlan.Identity)/$($_.Suffix)" })
    if ($ocrPaths.Count -ne 5) { throw 'Installer archive OCR resource count is not exactly five.' }
    foreach ($path in $expected) {
        if (@($ocrPaths | Where-Object { Test-ArchiveTargetMatch -ArchivePath $_ -Target $path }).Count -ne 1) {
            throw 'Installer archive OCR identity or resource path is incorrect.'
        }
    }
}

function Test-ArchiveTargetMatch {
    param([Parameter(Mandatory = $true)][string]$ArchivePath, [Parameter(Mandatory = $true)][string]$Target)
    return $ArchivePath.Equals($Target, [StringComparison]::OrdinalIgnoreCase) -or $ArchivePath.EndsWith('/' + $Target, [StringComparison]::OrdinalIgnoreCase)
}

function Find-ExtractedResource {
    param([Parameter(Mandatory = $true)][object[]]$Files, [Parameter(Mandatory = $true)][string]$Target)
    $matches = @($Files | Where-Object {
        $relativeShape = $_.FullName.Replace('\', '/')
        $relativeShape.Equals($Target, [StringComparison]::OrdinalIgnoreCase) -or $relativeShape.EndsWith('/' + $Target, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -ne 1) { throw 'Extracted installer resource path is missing or duplicated.' }
    return $matches[0]
}

function Assert-ExtractedBaseResources {
    param([Parameter(Mandatory = $true)][string]$ExtractionRoot, [Parameter(Mandatory = $true)][object[]]$Entries)
    $all = @(Get-ChildItem -LiteralPath $ExtractionRoot -Recurse -File)
    $receipts = @()
    foreach ($entry in $Entries) {
        $match = Find-ExtractedResource -Files $all -Target $entry.Target
        if ([uint64]$match.Length -ne [uint64]$entry.Receipt.Bytes -or (Get-ExactSha256 -Path $match.FullName) -cne $entry.Receipt.Sha256) {
            throw 'Extracted base resource receipt mismatch.'
        }
        $receipts += [pscustomobject]@{ path = $entry.Target; bytes = [uint64]$match.Length; sha256 = $entry.Receipt.Sha256 }
    }
    return $receipts
}

function Assert-ExtractedOcrPackage {
    param([Parameter(Mandatory = $true)][string]$ExtractionRoot, $Plan)
    $all = @(Get-ChildItem -LiteralPath $ExtractionRoot -Recurse -File)
    $ocr = @($all | Where-Object {
        $shape = $_.FullName.Replace('\', '/')
        $shape.StartsWith('resources/ocr/', [StringComparison]::OrdinalIgnoreCase) -or $shape.ToLowerInvariant().Contains('/resources/ocr/')
    })
    if (-not $Plan) {
        if ($ocr.Count -ne 0) { throw 'Default installer unexpectedly contains OCR resources.' }
        return @()
    }
    $expected = @($Plan.Files | ForEach-Object { "resources/ocr/$($Plan.Identity)/$($_.Suffix)" })
    if ($ocr.Count -ne 5) { throw 'Extracted installer OCR resource count is not exactly five.' }
    $receipts = @()
    foreach ($file in $Plan.Files) {
        $suffix = "resources/ocr/$($Plan.Identity)/$($file.Suffix)"
        $match = Find-ExtractedResource -Files $ocr -Target $suffix
        if ($match.Length -ne $file.Receipt.Bytes -or (Get-ExactSha256 -Path $match.FullName) -cne $file.Receipt.Sha256) { throw 'Extracted installer OCR resource receipt mismatch.' }
        $receipts += [pscustomobject]@{ path = $suffix; bytes = [uint64]$match.Length; sha256 = $file.Receipt.Sha256; role = $file.Role }
    }
    $actual = @($receipts | ForEach-Object path | Sort-Object)
    if (Compare-Object ($expected | Sort-Object) $actual -CaseSensitive) { throw 'Extracted installer OCR resource set is incorrect.' }
    return $receipts
}

function Test-ExecutableContainsAscii {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Marker)
    $text = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($Path))
    return $text.Contains($Marker)
}
