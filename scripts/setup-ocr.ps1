[CmdletBinding()]
param(
    [string] $OutputRoot,
    [ValidateRange(1, 4)]
    [int] $Jobs = 4
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'target'))
$recipeRoot = Join-Path $PSScriptRoot 'ocr'
$pinsPath = Join-Path $recipeRoot 'pins.json'
$compileOptionsPath = Join-Path $recipeRoot 'tesseract-options.cmake'
$smokeGeneratorPath = Join-Path $recipeRoot 'generate-smoke.ps1'
$maxDownloadBytes = 256MB
$maxExpandedArchiveBytes = 1GB
$maxSmokeInputBytes = 16MB
$maxSmokeStdoutChars = 1MB
$maxSmokeStderrChars = 64KB
$maxProcessStdoutChars = 32MB
$maxProcessStderrChars = 8MB
$sanitizedEnvironmentVariables = @(
    'CC',
    'CL',
    '_CL_',
    'CFLAGS',
    'CPPFLAGS',
    'CXX',
    'CXXFLAGS',
    'LDFLAGS',
    'CMAKE_GENERATOR',
    'CMAKE_GENERATOR_INSTANCE',
    'CMAKE_GENERATOR_PLATFORM',
    'CMAKE_GENERATOR_TOOLSET',
    'CMAKE_PREFIX_PATH',
    'CMAKE_TOOLCHAIN_FILE',
    'VCPKG_FEATURE_FLAGS',
    'VCPKG_ROOT'
)
$fixedSmokeText = @(
    'Receipt #A-17: Coffee & Tea, $12.50.',
    'Mixed case: 3rd Avenue; ready.'
) -join [string][char]10

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class OcrBoundedReadResult
{
    public string Text { get; set; }
    public bool Exceeded { get; set; }
}

public sealed class OcrBoundedProcessResult
{
    public string Stdout { get; set; }
    public string Stderr { get; set; }
    public int ExitCode { get; set; }
    public int ElapsedMilliseconds { get; set; }
    public bool TimedOut { get; set; }
    public bool StdoutExceeded { get; set; }
    public bool StderrExceeded { get; set; }
}

public static class OcrBoundedProcess
{
    private static async Task<OcrBoundedReadResult> ReadAsync(StreamReader reader, int maximum)
    {
        var result = new OcrBoundedReadResult();
        var text = new StringBuilder(Math.Min(maximum, 65536));
        var buffer = new char[4096];
        while (true)
        {
            int read = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
            if (read == 0)
                break;
            int remaining = maximum - text.Length;
            if (read > remaining)
            {
                if (remaining > 0)
                    text.Append(buffer, 0, remaining);
                result.Exceeded = true;
                break;
            }
            text.Append(buffer, 0, read);
        }
        result.Text = text.ToString();
        return result;
    }

    public static OcrBoundedProcessResult Run(
        string filePath,
        string[] arguments,
        string workingDirectory,
        string[] removeEnvironmentVariables,
        int timeoutMilliseconds,
        int maximumStdoutCharacters,
        int maximumStderrCharacters,
        byte[] standardInput)
    {
        var startInfo = new ProcessStartInfo {
            FileName = filePath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = standardInput != null,
            StandardOutputEncoding = new UTF8Encoding(false, true),
            StandardErrorEncoding = new UTF8Encoding(false, true)
        };
        if (!String.IsNullOrWhiteSpace(workingDirectory))
            startInfo.WorkingDirectory = workingDirectory;
        foreach (string variable in removeEnvironmentVariables)
            startInfo.Environment.Remove(variable);
        foreach (string argument in arguments)
            startInfo.ArgumentList.Add(argument);

        using (var process = new Process { StartInfo = startInfo })
        {
            if (!process.Start())
                throw new InvalidOperationException("Process did not start.");
            var stopwatch = Stopwatch.StartNew();
            Task<OcrBoundedReadResult> stdoutTask = ReadAsync(process.StandardOutput, maximumStdoutCharacters);
            Task<OcrBoundedReadResult> stderrTask = ReadAsync(process.StandardError, maximumStderrCharacters);
            if (standardInput != null)
            {
                process.StandardInput.BaseStream.Write(standardInput, 0, standardInput.Length);
                process.StandardInput.BaseStream.Flush();
                process.StandardInput.Close();
            }

            bool timedOut = false;
            while (!process.HasExited)
            {
                if (stdoutTask.IsFaulted || stderrTask.IsFaulted)
                {
                    TryKill(process);
                    break;
                }
                if ((stdoutTask.IsCompleted && stdoutTask.Result.Exceeded) ||
                    (stderrTask.IsCompleted && stderrTask.Result.Exceeded))
                {
                    TryKill(process);
                    break;
                }
                if (stopwatch.ElapsedMilliseconds > timeoutMilliseconds)
                {
                    timedOut = true;
                    TryKill(process);
                    break;
                }
                Thread.Sleep(25);
            }
            process.WaitForExit();
            OcrBoundedReadResult stdout = stdoutTask.GetAwaiter().GetResult();
            OcrBoundedReadResult stderr = stderrTask.GetAwaiter().GetResult();
            return new OcrBoundedProcessResult {
                Stdout = stdout.Text,
                Stderr = stderr.Text,
                ExitCode = process.ExitCode,
                ElapsedMilliseconds = checked((int)Math.Min(stopwatch.ElapsedMilliseconds, Int32.MaxValue)),
                TimedOut = timedOut,
                StdoutExceeded = stdout.Exceeded,
                StderrExceeded = stderr.Exceeded
            };
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            process.Kill(true);
        }
        catch
        {
        }
    }
}
'@

function Assert-WindowsX64 {
    if (-not $IsWindows) {
        throw 'The OCR setup recipe supports Windows only.'
    }
    if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) {
        throw 'The OCR setup recipe supports x64 Windows only.'
    }
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        throw 'The OCR setup recipe requires PowerShell 7 or newer.'
    }
}

function Assert-NoReparsePoint([string] $Path, [string] $Label) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label must not be a reparse point: $Path"
    }
}

function Assert-ContainedPath([string] $Root, [string] $Candidate, [string] $Label) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidateFull = [IO.Path]::GetFullPath($Candidate)
    $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escapes its allowed root: $candidateFull"
    }
}

function Assert-ExistingAncestorsSafe([string] $Path, [string] $StopAt) {
    $stopFull = [IO.Path]::GetFullPath($StopAt).TrimEnd('\', '/')
    $current = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            Assert-NoReparsePoint $current 'OCR output ancestor'
        }
        if ($current.Equals($stopFull, [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent.Equals($current, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Could not reach the target root while checking output ancestors: $Path"
        }
        $current = $parent
    }
}

function Write-NewUtf8([string] $Path, [string] $Content) {
    $encoding = [Text.UTF8Encoding]::new($false)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = $encoding.GetBytes($Content)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
}

function Add-SetupLog([string] $Text) {
    [IO.File]::AppendAllText($script:logPath, $Text + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Format-Command([string] $FilePath, [string[]] $Arguments) {
    $quoted = foreach ($argument in $Arguments) {
        if ($argument -match '[\s"]') {
            '"' + $argument.Replace('"', '\"') + '"'
        } else {
            $argument
        }
    }
    return $FilePath + ' ' + ($quoted -join ' ')
}

function Invoke-LoggedProcess {
    param(
        [Parameter(Mandatory)]
        [string] $Stage,
        [Parameter(Mandatory)]
        [string] $FilePath,
        [string[]] $Arguments = @(),
        [int] $TimeoutMilliseconds = 1200000,
        [int] $MaximumStdoutCharacters = $maxProcessStdoutChars,
        [int] $MaximumStderrCharacters = $maxProcessStderrChars,
        [string] $WorkingDirectory,
        [byte[]] $StandardInputBytes
    )

    Add-SetupLog ''
    Add-SetupLog "===== $Stage ====="
    Add-SetupLog (Format-Command $FilePath $Arguments)
    $result = [OcrBoundedProcess]::Run(
        $FilePath,
        $Arguments,
        $WorkingDirectory,
        $sanitizedEnvironmentVariables,
        $TimeoutMilliseconds,
        $MaximumStdoutCharacters,
        $MaximumStderrCharacters,
        $StandardInputBytes
    )
    Add-SetupLog "--- stdout ---"
    Add-SetupLog $result.Stdout.TrimEnd()
    Add-SetupLog "--- stderr ---"
    Add-SetupLog $result.Stderr.TrimEnd()
    Add-SetupLog "exit=$($result.ExitCode) elapsedMs=$($result.ElapsedMilliseconds)"
    if ($result.TimedOut) {
        throw "$Stage timed out after $TimeoutMilliseconds ms and its process tree was terminated."
    }
    if ($result.StdoutExceeded) {
        throw "$Stage exceeded its $MaximumStdoutCharacters-character stdout cap and its process tree was terminated."
    }
    if ($result.StderrExceeded) {
        throw "$Stage exceeded its $MaximumStderrCharacters-character stderr cap and its process tree was terminated."
    }
    if ($result.ExitCode -ne 0) {
        throw "$Stage failed with exit code $($result.ExitCode). See $script:logPath"
    }
    return [ordered]@{
        stdout = $result.Stdout
        stderr = $result.Stderr
        exitCode = $result.ExitCode
        elapsedMs = $result.ElapsedMilliseconds
    }
}

function Assert-FileHashAndSize {
    param(
        [Parameter(Mandatory)]
        [string] $Path,
        [Parameter(Mandatory)]
        [long] $ExpectedBytes,
        [Parameter(Mandatory)]
        [string] $ExpectedSha256
    )
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -ne $ExpectedBytes) {
        throw "Byte-length mismatch for $($Path): expected $ExpectedBytes, got $($item.Length)."
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $ExpectedSha256) {
        throw "SHA-256 mismatch for $($Path): expected $ExpectedSha256, got $actual."
    }
}

function Receive-PinnedFile {
    param(
        [Parameter(Mandatory)]
        [object] $Pin,
        [Parameter(Mandatory)]
        [string] $Destination
    )
    if (-not ([Uri]$Pin.url).Scheme.Equals('https', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Pinned download is not HTTPS: $($Pin.url)"
    }
    if ([long]$Pin.bytes -gt $maxDownloadBytes) {
        throw "Pinned download exceeds the recipe cap: $($Pin.file)"
    }
    if ([string]::IsNullOrWhiteSpace([string]$Pin.file) -or
        [IO.Path]::GetFileName([string]$Pin.file) -ne [string]$Pin.file) {
        throw "Pinned download file name is not a single path leaf: $($Pin.file)"
    }
    $part = $Destination + '.part'
    if ((Test-Path -LiteralPath $Destination) -or (Test-Path -LiteralPath $part)) {
        throw "Download destination already exists: $Destination"
    }

    Add-SetupLog "Downloading $($Pin.url)"
    $handler = [Net.Http.HttpClientHandler]::new()
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('PDF-Workstation-OCR-Setup/1')
    $cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMinutes(10))
    try {
        $response = $client.GetAsync(
            [string]$Pin.url,
            [Net.Http.HttpCompletionOption]::ResponseHeadersRead,
            $cancellation.Token
        ).GetAwaiter().GetResult()
        try {
            $null = $response.EnsureSuccessStatusCode()
            if ($null -ne $response.Content.Headers.ContentLength -and
                $response.Content.Headers.ContentLength -ne [long]$Pin.bytes) {
                throw "Content-Length mismatch for $($Pin.file)."
            }
            $input = $response.Content.ReadAsStream()
            $output = [IO.File]::Open($part, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = [byte[]]::new(1MB)
                [long]$total = 0
                while (($read = $input.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
                    $total += $read
                    if ($total -gt [long]$Pin.bytes -or $total -gt $maxDownloadBytes) {
                        throw "Download exceeded its pinned byte length: $($Pin.file)"
                    }
                    $output.Write($buffer, 0, $read)
                }
                $output.Flush($true)
            } finally {
                $output.Dispose()
                $input.Dispose()
            }
        } finally {
            $response.Dispose()
        }
    } finally {
        $cancellation.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
    Assert-FileHashAndSize $part ([long]$Pin.bytes) ([string]$Pin.sha256)
    [IO.File]::Move($part, $Destination, $false)
    Add-SetupLog "Verified $($Pin.file): $($Pin.bytes) bytes, SHA-256 $($Pin.sha256)"
}

function Assert-SafeArchiveName([string] $Name, [string] $ExpectedPrefix) {
    $normalized = $Name.Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($normalized) -or
        $normalized.StartsWith('/') -or
        $normalized -match '^[A-Za-z]:' -or
        -not $normalized.StartsWith($ExpectedPrefix, [StringComparison]::Ordinal)) {
        throw "Archive entry is outside the expected prefix '$ExpectedPrefix': $Name"
    }
    foreach ($segment in $normalized.Split('/', [StringSplitOptions]::RemoveEmptyEntries)) {
        if ($segment -eq '.' -or $segment -eq '..') {
            throw "Archive entry contains an unsafe path segment: $Name"
        }
    }
    return $normalized
}

function Expand-PinnedZip {
    param(
        [Parameter(Mandatory)]
        [string] $Archive,
        [Parameter(Mandatory)]
        [string] $Destination,
        [Parameter(Mandatory)]
        [string] $ExpectedPrefix
    )
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::OpenRead($Archive)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read)
    try {
        [long]$expanded = 0
        foreach ($entry in $zip.Entries) {
            $normalized = Assert-SafeArchiveName $entry.FullName $ExpectedPrefix
            $mode = (($entry.ExternalAttributes -shr 16) -band 0xF000)
            if ($mode -eq 0xA000) {
                throw "ZIP link entries are not accepted: $($entry.FullName)"
            }
            $expanded += $entry.Length
            if ($expanded -gt $maxExpandedArchiveBytes) {
                throw 'ZIP expanded data exceeds the recipe cap.'
            }
            $relative = $normalized.Replace('/', [IO.Path]::DirectorySeparatorChar)
            $outputPath = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
            Assert-ContainedPath $Destination $outputPath 'ZIP entry'
            if ($normalized.EndsWith('/')) {
                [IO.Directory]::CreateDirectory($outputPath) | Out-Null
                continue
            }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $outputPath)) | Out-Null
            $entryStream = $entry.Open()
            $output = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $entryStream.CopyTo($output)
                $output.Flush($true)
            } finally {
                $output.Dispose()
                $entryStream.Dispose()
            }
        }
    } finally {
        $zip.Dispose()
        $stream.Dispose()
    }
    Add-SetupLog "Safely extracted ZIP $Archive"
}

function Expand-PinnedTarGz {
    param(
        [Parameter(Mandatory)]
        [string] $CMakePath,
        [Parameter(Mandatory)]
        [string] $Archive,
        [Parameter(Mandatory)]
        [string] $Destination,
        [Parameter(Mandatory)]
        [string] $ExpectedPrefix
    )
    $names = Invoke-LoggedProcess -Stage "List archive $(Split-Path -Leaf $Archive)" -FilePath $CMakePath -Arguments @('-E', 'tar', 'tf', $Archive)
    foreach ($name in ($names.stdout -split '\r?\n')) {
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            $null = Assert-SafeArchiveName $name $ExpectedPrefix
        }
    }
    $verbose = Invoke-LoggedProcess -Stage "Inspect archive types $(Split-Path -Leaf $Archive)" -FilePath $CMakePath -Arguments @('-E', 'tar', 'tvf', $Archive)
    [long]$expandedFileBytes = 0
    foreach ($line in ($verbose.stdout -split '\r?\n')) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        if ($line[0] -ne '-' -and $line[0] -ne 'd') {
            throw "Tar link or special entry is not accepted: $line"
        }
        if ($line -notmatch '^[\-d]\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+') {
            throw "Could not read the expanded byte length from tar metadata: $line"
        }
        $expandedFileBytes += [long]$Matches[1]
        if ($expandedFileBytes -gt $maxExpandedArchiveBytes) {
            throw 'Tar expanded file data exceeds the recipe cap.'
        }
    }
    $archiveItem = Get-Item -LiteralPath $Archive
    if ($archiveItem.Length -gt $maxDownloadBytes) {
        throw "Tar archive exceeds the recipe cap: $Archive"
    }
    $null = Invoke-LoggedProcess -Stage "Extract archive $(Split-Path -Leaf $Archive)" -FilePath $CMakePath -Arguments @('-E', 'tar', 'xzf', $Archive) -WorkingDirectory $Destination
    $top = Join-Path $Destination $ExpectedPrefix.TrimEnd('/')
    if (-not (Test-Path -LiteralPath $top -PathType Container)) {
        throw "Expected extracted source directory is missing: $top"
    }
}

function Copy-NewVerified {
    param(
        [Parameter(Mandatory)]
        [string] $Source,
        [Parameter(Mandatory)]
        [string] $Destination,
        [Parameter(Mandatory)]
        [long] $ExpectedBytes,
        [Parameter(Mandatory)]
        [string] $ExpectedSha256
    )
    Assert-FileHashAndSize $Source $ExpectedBytes $ExpectedSha256
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Destination)) | Out-Null
    $input = [IO.File]::OpenRead($Source)
    $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $input.CopyTo($output)
        $output.Flush($true)
    } finally {
        $output.Dispose()
        $input.Dispose()
    }
    Assert-FileHashAndSize $Destination $ExpectedBytes $ExpectedSha256
}

function Get-CacheValues([string] $Path) {
    $values = @{}
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        if ($line -match '^([^#/][^:]*):[^=]+=(.*)$') {
            $values[$Matches[1]] = $Matches[2]
        }
    }
    return $values
}

function Assert-CacheValues([string] $Path, [hashtable] $Expected) {
    $values = Get-CacheValues $Path
    foreach ($key in $Expected.Keys) {
        if (-not $values.ContainsKey($key)) {
            throw "CMake cache is missing $key in $Path"
        }
        if ($values[$key] -ne $Expected[$key]) {
            throw "CMake cache $key is '$($values[$key])', expected '$($Expected[$key])'."
        }
    }
}

function Assert-GeneratedCompilerIdentity {
    param(
        [Parameter(Mandatory)]
        [string] $BuildDirectory,
        [Parameter(Mandatory)]
        [ValidateSet('C', 'CXX')]
        [string] $Language,
        [Parameter(Mandatory)]
        [string] $ExpectedVisualStudioRoot,
        [Parameter(Mandatory)]
        [string] $ExpectedCompilerPath,
        [Parameter(Mandatory)]
        [string] $ExpectedCompilerVersion
    )
    $cache = Get-CacheValues (Join-Path $BuildDirectory 'CMakeCache.txt')
    if ($cache.CMAKE_GENERATOR -ne 'Visual Studio 17 2022' -or $cache.CMAKE_GENERATOR_PLATFORM -ne 'x64') {
        throw "CMake selected an unexpected generator or platform in $BuildDirectory"
    }
    $actualInstance = [IO.Path]::GetFullPath(([string]$cache.CMAKE_GENERATOR_INSTANCE).Replace('/', '\')).TrimEnd('\')
    $expectedInstance = [IO.Path]::GetFullPath($ExpectedVisualStudioRoot).TrimEnd('\')
    if (-not $actualInstance.Equals($expectedInstance, [StringComparison]::OrdinalIgnoreCase)) {
        throw "CMake selected Visual Studio instance '$actualInstance', expected '$expectedInstance'."
    }
    $compilerFile = Join-Path $BuildDirectory "CMakeFiles\$($pins.cmake.version)\CMake$($Language)Compiler.cmake"
    $compilerText = Get-Content -Raw -LiteralPath $compilerFile
    if ($compilerText -notmatch ('set\(CMAKE_' + $Language + '_COMPILER "([^"]+)"\)')) {
        throw "CMake generated compiler path is missing from $compilerFile"
    }
    $actualCompiler = [IO.Path]::GetFullPath($Matches[1].Replace('/', '\'))
    if (-not $actualCompiler.Equals([IO.Path]::GetFullPath($ExpectedCompilerPath), [StringComparison]::OrdinalIgnoreCase)) {
        throw "CMake selected compiler '$actualCompiler', expected '$ExpectedCompilerPath'."
    }
    if ($compilerText -notmatch ('set\(CMAKE_' + $Language + '_COMPILER_VERSION "([^"]+)"\)')) {
        throw "CMake generated compiler version is missing from $compilerFile"
    }
    if ($Matches[1] -ne $ExpectedCompilerVersion) {
        throw "CMake reported compiler version '$($Matches[1])', expected '$ExpectedCompilerVersion'."
    }
    return [ordered]@{
        language = $Language
        version = $Matches[1]
        generatorInstanceMatchedVswhere = $true
    }
}

function Assert-ReleaseProject {
    param(
        [Parameter(Mandatory)]
        [string] $Path,
        [switch] $RequireExceptions,
        [switch] $RequireDebugFontGuard
    )
    [xml]$project = Get-Content -Raw -LiteralPath $Path
    $group = @($project.Project.ItemDefinitionGroup) |
        Where-Object { [string]$_.Condition -match 'Release\|x64' } |
        Select-Object -First 1
    if ($null -eq $group -or $null -eq $group.ClCompile) {
        throw "Release|x64 compiler settings are missing from $Path"
    }
    if ([string]$group.ClCompile.RuntimeLibrary -ne 'MultiThreaded') {
        throw "Static /MT runtime is not configured in $Path"
    }
    if ($RequireExceptions -and [string]$group.ClCompile.ExceptionHandling -ne 'Sync') {
        throw "Synchronous C++ exception handling is not configured in $Path"
    }
    if ($RequireDebugFontGuard -and
        -not ([string]$group.ClCompile.PreprocessorDefinitions).Contains('TESSERACT_DISABLE_DEBUG_FONTS')) {
        throw "TESSERACT_DISABLE_DEBUG_FONTS is missing from $Path"
    }
}

function Get-RelativeOutputPath([string] $Path) {
    $relative = [IO.Path]::GetRelativePath($script:outputRoot, [IO.Path]::GetFullPath($Path)).Replace('\', '/')
    if ($relative -eq '..' -or $relative.StartsWith('../', [StringComparison]::Ordinal)) {
        throw "Manifest artifact escapes the output root: $Path"
    }
    return $relative
}

function Get-ArtifactReceipt([string] $Path) {
    $item = Get-Item -LiteralPath $Path
    return [ordered]@{
        path = Get-RelativeOutputPath $item.FullName
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    }
}

function Get-RecipeInputReceipt([string] $Path) {
    $item = Get-Item -LiteralPath $Path
    $relative = [IO.Path]::GetRelativePath($repoRoot, $item.FullName).Replace('\', '/')
    if ($relative -eq '..' -or $relative.StartsWith('../', [StringComparison]::Ordinal)) {
        throw "Recipe input escapes the repository: $Path"
    }
    return [ordered]@{
        path = $relative
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    }
}

function Normalize-SmokeText([string] $Text) {
    return ($Text -replace '\r\n?', [string][char]10).Trim()
}

function Invoke-BoundedSmoke {
    param(
        [Parameter(Mandatory)]
        [string] $Engine,
        [Parameter(Mandatory)]
        [string] $InputPath,
        [Parameter(Mandatory)]
        [string] $TessdataPath
    )
    $input = Get-Item -LiteralPath $InputPath
    if ($input.Length -gt $maxSmokeInputBytes) {
        throw "Smoke input exceeds $maxSmokeInputBytes bytes and was rejected before process start."
    }
    $bytes = [IO.File]::ReadAllBytes($InputPath)
    $script:ocrProcessStarts++
    $result = Invoke-LoggedProcess -Stage 'Exact OCR smoke' -FilePath $Engine -Arguments @(
        'stdin',
        'stdout',
        '--tessdata-dir', $TessdataPath,
        '-l', 'eng',
        '--oem', '1',
        '--psm', '6',
        '--dpi', '150',
        '--loglevel', 'ERROR'
    ) -TimeoutMilliseconds 30000 -MaximumStdoutCharacters $maxSmokeStdoutChars -MaximumStderrCharacters $maxSmokeStderrChars -StandardInputBytes $bytes
    if (-not [string]::IsNullOrWhiteSpace($result.stderr)) {
        throw "OCR smoke wrote stderr: $($result.stderr.Trim())"
    }
    return $result
}

Assert-WindowsX64
foreach ($required in @($pinsPath, $compileOptionsPath, $smokeGeneratorPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required recipe file is missing: $required"
    }
}
$pins = Get-Content -Raw -LiteralPath $pinsPath | ConvertFrom-Json
if ($pins.schemaVersion -ne 1 -or $pins.recipeVersion -ne '1') {
    throw 'Unsupported OCR pin-manifest schema or recipe version.'
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = 'target\ocr\5.5.3-eng-fast-4.1.0'
}
if (-not [IO.Path]::IsPathFullyQualified($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot $OutputRoot
}
$script:outputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')
Assert-ContainedPath $targetRoot $script:outputRoot 'OCR output root'
if (Test-Path -LiteralPath $script:outputRoot) {
    throw "OCR output root already exists; choose a new path: $script:outputRoot"
}
if (-not (Test-Path -LiteralPath $targetRoot)) {
    [IO.Directory]::CreateDirectory($targetRoot) | Out-Null
}
Assert-NoReparsePoint $targetRoot 'Repository target directory'
$outputParent = Split-Path -Parent $script:outputRoot
Assert-ExistingAncestorsSafe $outputParent $targetRoot
[IO.Directory]::CreateDirectory($outputParent) | Out-Null
Assert-ExistingAncestorsSafe $outputParent $targetRoot
New-Item -ItemType Directory -Path $script:outputRoot -ErrorAction Stop | Out-Null
Assert-NoReparsePoint $script:outputRoot 'OCR output root'

$downloads = Join-Path $script:outputRoot 'downloads'
$toolsRoot = Join-Path $script:outputRoot 'tools'
$sourceRoot = Join-Path $script:outputRoot 'source'
$buildRoot = Join-Path $script:outputRoot 'build'
$stageRoot = Join-Path $script:outputRoot 'stage'
$engineRoot = Join-Path $script:outputRoot 'engine'
$logsRoot = Join-Path $script:outputRoot 'logs'
$smokeRoot = Join-Path $script:outputRoot 'smoke'
foreach ($directory in @($downloads, $toolsRoot, $sourceRoot, $buildRoot, $stageRoot, $engineRoot, $logsRoot, $smokeRoot)) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
}
$script:logPath = Join-Path $logsRoot 'setup.log'
$initialLog = @('OCR SETUP START', "recipeVersion=$($pins.recipeVersion)", "jobs=$Jobs") -join [Environment]::NewLine
Write-NewUtf8 $script:logPath ($initialLog + [Environment]::NewLine)

try {
    $downloadPins = @(
        $pins.cmake.archive,
        $pins.cmake.checksums,
        $pins.tesseract.archive,
        $pins.leptonica.archive,
        $pins.model.data,
        $pins.model.license
    )
    $downloaded = @{}
    foreach ($pin in $downloadPins) {
        $path = Join-Path $downloads ([string]$pin.file)
        Receive-PinnedFile $pin $path
        $downloaded[[string]$pin.file] = $path
    }

    $checksumText = [IO.File]::ReadAllText($downloaded[[string]$pins.cmake.checksums.file], [Text.Encoding]::UTF8)
    $expectedChecksumLine = ([string]$pins.cmake.archive.sha256).ToLowerInvariant() + '  ' + [string]$pins.cmake.archive.file
    if (-not (($checksumText -split '\r?\n') -contains $expectedChecksumLine)) {
        throw 'The verified official CMake checksum file does not authenticate the pinned CMake archive.'
    }
    Add-SetupLog "Official CMake checksum entry verified: $expectedChecksumLine"

    Expand-PinnedZip -Archive $downloaded[[string]$pins.cmake.archive.file] -Destination $toolsRoot -ExpectedPrefix ([string]$pins.cmake.archivePrefix)
    $cmake = Join-Path $toolsRoot (($pins.cmake.archivePrefix.TrimEnd('/') -replace '/', '\') + '\bin\cmake.exe')
    if (-not (Test-Path -LiteralPath $cmake -PathType Leaf)) {
        throw "Pinned CMake executable is missing after extraction: $cmake"
    }
    $cmakeVersion = Invoke-LoggedProcess -Stage 'Pinned CMake version' -FilePath $cmake -Arguments @('--version')
    if ($cmakeVersion.stdout -notmatch ('cmake version ' + [regex]::Escape([string]$pins.cmake.version))) {
        throw 'Extracted CMake version does not match the pin manifest.'
    }

    Expand-PinnedTarGz -CMakePath $cmake -Archive $downloaded[[string]$pins.leptonica.archive.file] -Destination $sourceRoot -ExpectedPrefix ([string]$pins.leptonica.archivePrefix)
    Expand-PinnedTarGz -CMakePath $cmake -Archive $downloaded[[string]$pins.tesseract.archive.file] -Destination $sourceRoot -ExpectedPrefix ([string]$pins.tesseract.archivePrefix)

    $leptonicaSource = Join-Path $sourceRoot $pins.leptonica.archivePrefix.TrimEnd('/')
    $tesseractSource = Join-Path $sourceRoot $pins.tesseract.archivePrefix.TrimEnd('/')
    $leptonicaLicense = Join-Path $leptonicaSource ([string]$pins.leptonica.license.source)
    $tesseractLicense = Join-Path $tesseractSource ([string]$pins.tesseract.license.source)
    Assert-FileHashAndSize $leptonicaLicense ([long]$pins.leptonica.license.bytes) ([string]$pins.leptonica.license.sha256)
    Assert-FileHashAndSize $tesseractLicense ([long]$pins.tesseract.license.bytes) ([string]$pins.tesseract.license.sha256)

    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
        throw 'Visual Studio Installer vswhere.exe was not found.'
    }
    $vsResult = Invoke-LoggedProcess -Stage 'Locate Visual Studio C++ tools' -FilePath $vswhere -Arguments @(
        '-latest',
        '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath'
    )
    $vsRoot = @($vsResult.stdout -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })[0].Trim()
    if (-not (Test-Path -LiteralPath $vsRoot -PathType Container)) {
        throw 'Visual Studio C++ tools were not located.'
    }
    $vsVersionResult = Invoke-LoggedProcess -Stage 'Read Visual Studio version' -FilePath $vswhere -Arguments @(
        '-latest',
        '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationVersion'
    )
    $vsVersion = @($vsVersionResult.stdout -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })[0].Trim()
    $msvcVersionDirectory = Get-ChildItem -LiteralPath (Join-Path $vsRoot 'VC\Tools\MSVC') -Directory |
        Sort-Object { [Version]$_.Name } -Descending |
        Select-Object -First 1
    if ($null -eq $msvcVersionDirectory) {
        throw 'No MSVC toolset directory was found.'
    }
    $dumpbin = Join-Path $msvcVersionDirectory.FullName 'bin\Hostx64\x64\dumpbin.exe'
    $compiler = Join-Path $msvcVersionDirectory.FullName 'bin\Hostx64\x64\cl.exe'
    if (-not (Test-Path -LiteralPath $dumpbin -PathType Leaf)) {
        throw 'The x64 dumpbin.exe tool was not found.'
    }
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
        throw 'The x64 cl.exe compiler was not found.'
    }
    $compilerVersion = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion

    $leptonicaBuild = Join-Path $buildRoot 'leptonica'
    $tesseractBuild = Join-Path $buildRoot 'tesseract'
    $leptonicaConfigure = Invoke-LoggedProcess -Stage 'Configure Leptonica' -FilePath $cmake -Arguments @(
        '-S', $leptonicaSource,
        '-B', $leptonicaBuild,
        '-G', 'Visual Studio 17 2022',
        '-A', 'x64',
        "-DCMAKE_INSTALL_PREFIX=$stageRoot",
        '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
        '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DBUILD_PROG=OFF',
        '-DSW_BUILD=OFF',
        '-DSTRICT_CONF=ON',
        '-DENABLE_ZLIB=OFF',
        '-DENABLE_PNG=OFF',
        '-DENABLE_GIF=OFF',
        '-DENABLE_JPEG=OFF',
        '-DENABLE_TIFF=OFF',
        '-DENABLE_WEBP=OFF',
        '-DENABLE_OPENJPEG=OFF'
    )
    if (($leptonicaConfigure.stdout + $leptonicaConfigure.stderr) -match 'Manually-specified variables were not used') {
        throw 'Leptonica configure did not consume every requested build variable.'
    }
    $null = Invoke-LoggedProcess -Stage 'Build and stage Leptonica' -FilePath $cmake -Arguments @(
        '--build', $leptonicaBuild,
        '--config', 'Release',
        '--target', 'install',
        '--parallel', [string]$Jobs
    )

    $tesseractConfigure = Invoke-LoggedProcess -Stage 'Configure Tesseract' -FilePath $cmake -Arguments @(
        '-S', $tesseractSource,
        '-B', $tesseractBuild,
        '-G', 'Visual Studio 17 2022',
        '-A', 'x64',
        "-DCMAKE_INSTALL_PREFIX=$stageRoot",
        "-DCMAKE_PREFIX_PATH=$stageRoot",
        "-DLeptonica_DIR=$(Join-Path $stageRoot 'lib\cmake\leptonica')",
        '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
        "-DCMAKE_PROJECT_INCLUDE=$compileOptionsPath",
        '-DBUILD_SHARED_LIBS=OFF',
        '-DOPENMP_BUILD=OFF',
        '-DGRAPHICS_DISABLED=ON',
        '-DDISABLED_LEGACY_ENGINE=ON',
        '-DENABLE_LTO=OFF',
        '-DENABLE_NATIVE=OFF',
        '-DBUILD_TRAINING_TOOLS=OFF',
        '-DBUILD_TESTS=OFF',
        '-DDISABLE_TIFF=ON',
        '-DDISABLE_ARCHIVE=ON',
        '-DDISABLE_CURL=ON',
        '-DINSTALL_CONFIGS=OFF',
        '-DENABLE_CCACHE=OFF',
        '-DENABLE_UNITY_BUILD=OFF'
    )
    if (($tesseractConfigure.stdout + $tesseractConfigure.stderr) -match 'Manually-specified variables were not used') {
        throw 'Tesseract configure did not consume every requested build variable.'
    }
    $null = Invoke-LoggedProcess -Stage 'Build and stage Tesseract' -FilePath $cmake -Arguments @(
        '--build', $tesseractBuild,
        '--config', 'Release',
        '--target', 'install',
        '--parallel', [string]$Jobs
    )

    Assert-CacheValues (Join-Path $leptonicaBuild 'CMakeCache.txt') @{
        CMAKE_MSVC_RUNTIME_LIBRARY = 'MultiThreaded'
        BUILD_SHARED_LIBS = 'OFF'
        BUILD_PROG = 'OFF'
        SW_BUILD = 'OFF'
        STRICT_CONF = 'ON'
        ENABLE_ZLIB = 'OFF'
        ENABLE_PNG = 'OFF'
        ENABLE_GIF = 'OFF'
        ENABLE_JPEG = 'OFF'
        ENABLE_TIFF = 'OFF'
        ENABLE_WEBP = 'OFF'
        ENABLE_OPENJPEG = 'OFF'
    }
    Assert-CacheValues (Join-Path $tesseractBuild 'CMakeCache.txt') @{
        CMAKE_MSVC_RUNTIME_LIBRARY = 'MultiThreaded'
        BUILD_SHARED_LIBS = 'OFF'
        OPENMP_BUILD = 'OFF'
        GRAPHICS_DISABLED = 'ON'
        DISABLED_LEGACY_ENGINE = 'ON'
        ENABLE_LTO = 'OFF'
        ENABLE_NATIVE = 'OFF'
        BUILD_TRAINING_TOOLS = 'OFF'
        BUILD_TESTS = 'OFF'
        DISABLE_TIFF = 'ON'
        DISABLE_ARCHIVE = 'ON'
        DISABLE_CURL = 'ON'
        INSTALL_CONFIGS = 'OFF'
        ENABLE_CCACHE = 'OFF'
        ENABLE_UNITY_BUILD = 'OFF'
    }
    $leptonicaCompilerIdentity = Assert-GeneratedCompilerIdentity -BuildDirectory $leptonicaBuild -Language C -ExpectedVisualStudioRoot $vsRoot -ExpectedCompilerPath $compiler -ExpectedCompilerVersion $compilerVersion
    $tesseractCompilerIdentity = Assert-GeneratedCompilerIdentity -BuildDirectory $tesseractBuild -Language CXX -ExpectedVisualStudioRoot $vsRoot -ExpectedCompilerPath $compiler -ExpectedCompilerVersion $compilerVersion
    Assert-ReleaseProject (Join-Path $leptonicaBuild 'src\leptonica.vcxproj')
    Assert-ReleaseProject (Join-Path $tesseractBuild 'libtesseract.vcxproj') -RequireExceptions -RequireDebugFontGuard
    Assert-ReleaseProject (Join-Path $tesseractBuild 'tesseract.vcxproj') -RequireExceptions -RequireDebugFontGuard
    Add-SetupLog 'Verified Release|x64 /MT projects, Tesseract /EHsc, and TESSERACT_DISABLE_DEBUG_FONTS.'

    $engineBin = Join-Path $engineRoot 'bin'
    $engineTessdata = Join-Path $engineRoot 'tessdata'
    $engineLicenses = Join-Path $engineRoot 'licenses'
    foreach ($directory in @($engineBin, $engineTessdata, $engineLicenses)) {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    $stagedEngine = Join-Path $stageRoot 'bin\tesseract.exe'
    $engine = Join-Path $engineBin 'tesseract.exe'
    $stagedEngineItem = Get-Item -LiteralPath $stagedEngine
    Copy-NewVerified $stagedEngine $engine $stagedEngineItem.Length ((Get-FileHash -LiteralPath $stagedEngine -Algorithm SHA256).Hash)
    Copy-NewVerified $downloaded[[string]$pins.model.data.file] (Join-Path $engineTessdata 'eng.traineddata') ([long]$pins.model.data.bytes) ([string]$pins.model.data.sha256)
    Copy-NewVerified $tesseractLicense (Join-Path $engineLicenses ([string]$pins.tesseract.license.output)) ([long]$pins.tesseract.license.bytes) ([string]$pins.tesseract.license.sha256)
    Copy-NewVerified $leptonicaLicense (Join-Path $engineLicenses ([string]$pins.leptonica.license.output)) ([long]$pins.leptonica.license.bytes) ([string]$pins.leptonica.license.sha256)
    Copy-NewVerified $downloaded[[string]$pins.model.license.file] (Join-Path $engineLicenses ([string]$pins.model.license.output)) ([long]$pins.model.license.bytes) ([string]$pins.model.license.sha256)

    $dlls = @(Get-ChildItem -LiteralPath $engineRoot -Recurse -File -Filter '*.dll')
    if ($dlls.Count -ne 0) {
        throw 'The final OCR engine unexpectedly contains DLL files.'
    }
    $version = Invoke-LoggedProcess -Stage 'Verify Tesseract and Leptonica versions' -FilePath $engine -Arguments @('--version')
    $versionText = $version.stdout + $version.stderr
    if ($versionText -notmatch 'tesseract 5\.5\.3' -or $versionText -notmatch 'leptonica-1\.87\.0') {
        throw 'The built engine did not report the pinned Tesseract and Leptonica versions.'
    }

    $dependents = Invoke-LoggedProcess -Stage 'Inspect executable imports' -FilePath $dumpbin -Arguments @('/dependents', $engine)
    $imports = @([regex]::Matches($dependents.stdout, '(?im)^\s+([A-Z0-9._-]+\.dll)\s*$') |
        ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() } |
        Sort-Object -Unique)
    if ($imports.Count -ne 1 -or $imports[0] -ne 'KERNEL32.DLL') {
        throw "Unexpected OCR executable imports: $($imports -join ', ')"
    }
    $headers = Invoke-LoggedProcess -Stage 'Inspect executable security headers' -FilePath $dumpbin -Arguments @('/headers', $engine)
    foreach ($requiredHeader in @('machine \(x64\)', 'High Entropy Virtual Addresses', 'Dynamic base', 'NX compatible')) {
        if ($headers.stdout -notmatch $requiredHeader) {
            throw "Required executable header evidence is missing: $requiredHeader"
        }
    }

    $smokePath = Join-Path $smokeRoot 'known-text.pnm'
    $smokeDescription = & $smokeGeneratorPath -OutputPath $smokePath
    if ((Normalize-SmokeText ([string]$smokeDescription.expectedText)) -ne (Normalize-SmokeText $fixedSmokeText)) {
        throw 'The smoke generator metadata does not match the setup recipe fixed-text oracle.'
    }
    $script:ocrProcessStarts = 0
    $smokeResult = Invoke-BoundedSmoke -Engine $engine -InputPath $smokePath -TessdataPath $engineTessdata
    $actualText = Normalize-SmokeText $smokeResult.stdout
    if ($actualText -ne (Normalize-SmokeText $fixedSmokeText)) {
        throw "OCR smoke output mismatch. Expected '$fixedSmokeText'; got '$actualText'."
    }
    $oversizePath = Join-Path $smokeRoot 'oversize-control.pnm'
    $oversizeStream = [IO.File]::Open($oversizePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $oversizeStream.SetLength($maxSmokeInputBytes + 1)
        $oversizeStream.Flush($true)
    } finally {
        $oversizeStream.Dispose()
    }
    $startsBeforeControl = $script:ocrProcessStarts
    $oversizeRejected = $false
    try {
        $null = Invoke-BoundedSmoke -Engine $engine -InputPath $oversizePath -TessdataPath $engineTessdata
    } catch {
        if ($_.Exception.Message -notmatch 'rejected before process start') {
            throw
        }
        $oversizeRejected = $true
        Add-SetupLog $_.Exception.Message
    }
    if (-not $oversizeRejected -or $script:ocrProcessStarts -ne $startsBeforeControl) {
        throw 'The oversize smoke control did not fail before process start.'
    }

    $downloadReceipts = foreach ($pin in $downloadPins) {
        Get-ArtifactReceipt $downloaded[[string]$pin.file]
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        scope = 'Opt-in local Windows OCR engine setup only; no application, installer, or release integration.'
        reproducibility = 'Sources, build inputs, and options are pinned and verified. Executable bytes are not claimed to be bit-reproducible across toolchain or operating-system updates.'
        versions = [ordered]@{
            recipe = [string]$pins.recipeVersion
            cmake = [string]$pins.cmake.version
            tesseract = [ordered]@{
                version = [string]$pins.tesseract.version
                tagObject = [string]$pins.tesseract.tagObject
                commit = [string]$pins.tesseract.commit
            }
            leptonica = [ordered]@{
                version = [string]$pins.leptonica.version
                commit = [string]$pins.leptonica.commit
            }
            model = [ordered]@{
                language = [string]$pins.model.language
                variant = [string]$pins.model.variant
                version = [string]$pins.model.version
                tagObject = [string]$pins.model.tagObject
                commit = [string]$pins.model.commit
            }
            msvcToolset = $msvcVersionDirectory.Name
            powershell = $PSVersionTable.PSVersion.ToString()
        }
        sourcePins = [ordered]@{
            cmake = [ordered]@{ url = [string]$pins.cmake.archive.url; bytes = [long]$pins.cmake.archive.bytes; sha256 = [string]$pins.cmake.archive.sha256 }
            cmakeChecksums = [ordered]@{ url = [string]$pins.cmake.checksums.url; bytes = [long]$pins.cmake.checksums.bytes; sha256 = [string]$pins.cmake.checksums.sha256 }
            tesseract = [ordered]@{ url = [string]$pins.tesseract.archive.url; bytes = [long]$pins.tesseract.archive.bytes; sha256 = [string]$pins.tesseract.archive.sha256 }
            leptonica = [ordered]@{ url = [string]$pins.leptonica.archive.url; bytes = [long]$pins.leptonica.archive.bytes; sha256 = [string]$pins.leptonica.archive.sha256 }
            model = [ordered]@{ url = [string]$pins.model.data.url; bytes = [long]$pins.model.data.bytes; sha256 = [string]$pins.model.data.sha256 }
            modelLicense = [ordered]@{ url = [string]$pins.model.license.url; bytes = [long]$pins.model.license.bytes; sha256 = [string]$pins.model.license.sha256 }
        }
        build = [ordered]@{
            architecture = 'x64'
            configuration = 'Release'
            generator = 'Visual Studio 17 2022'
            visualStudioVersion = $vsVersion
            msvcCompilerFileVersion = $compilerVersion
            generatedCompilerIdentities = @($leptonicaCompilerIdentity, $tesseractCompilerIdentity)
            jobs = $Jobs
            runtimeLibrary = 'MultiThreaded'
            tesseractCompileDefinition = 'TESSERACT_DISABLE_DEBUG_FONTS'
            linkedImports = @('KERNEL32.dll')
            note = 'The import table shows no codec or network DLL linked; it does not prove the executable can never load another DLL or start a process.'
            sanitizedEnvironmentVariables = @($sanitizedEnvironmentVariables)
            disabled = @(
                'shared libraries',
                'Leptonica programs and codecs',
                'OpenMP',
                'graphics and debug fonts',
                'legacy OCR engine',
                'LTO and native tuning',
                'training tools and tests',
                'TIFF, libarchive, curl',
                'ccache and unity builds'
            )
        }
        bounds = [ordered]@{
            jobsMaximum = 4
            downloadBytesMaximum = $maxDownloadBytes
            expandedArchiveFileBytesMaximum = $maxExpandedArchiveBytes
            processStdoutCharactersMaximum = $maxProcessStdoutChars
            processStderrCharactersMaximum = $maxProcessStderrChars
            smokeInputBytesMaximum = $maxSmokeInputBytes
            smokeStdoutCharactersMaximum = $maxSmokeStdoutChars
            smokeStderrCharactersMaximum = $maxSmokeStderrChars
            smokeTimeoutMilliseconds = 30000
        }
        verification = [ordered]@{
            cmakeOfficialChecksumEntry = $expectedChecksumLine
            exactSmokeText = $actualText
            smokeInput = Get-ArtifactReceipt $smokePath
            oversizeInput = Get-ArtifactReceipt $oversizePath
            oversizeRejectedBeforeSpawn = $true
            executableHeaders = @('x64', 'ASLR', 'high-entropy VA', 'NX compatible')
        }
        artifacts = [ordered]@{
            recipeInputs = @(
                Get-RecipeInputReceipt $PSCommandPath
                Get-RecipeInputReceipt $pinsPath
                Get-RecipeInputReceipt $compileOptionsPath
                Get-RecipeInputReceipt $smokeGeneratorPath
            )
            executable = Get-ArtifactReceipt $engine
            model = Get-ArtifactReceipt (Join-Path $engineTessdata 'eng.traineddata')
            licenses = @(
                Get-ArtifactReceipt (Join-Path $engineLicenses ([string]$pins.tesseract.license.output))
                Get-ArtifactReceipt (Join-Path $engineLicenses ([string]$pins.leptonica.license.output))
                Get-ArtifactReceipt (Join-Path $engineLicenses ([string]$pins.model.license.output))
            )
            downloads = @($downloadReceipts)
        }
    }
    $manifestPath = Join-Path $engineRoot 'ocr-engine-manifest.json'
    Write-NewUtf8 $manifestPath (($manifest | ConvertTo-Json -Depth 9) + [Environment]::NewLine)
    Add-SetupLog ''
    Add-SetupLog 'OCR SETUP COMPLETE'
    Add-SetupLog "manifest=$(Get-RelativeOutputPath $manifestPath)"
    Add-SetupLog "engine=$(Get-RelativeOutputPath $engine)"
    Add-SetupLog "model=$(Get-RelativeOutputPath (Join-Path $engineTessdata 'eng.traineddata'))"

    Write-Output 'OCR engine setup completed.'
    Write-Output "Output: $script:outputRoot"
    Write-Output "Manifest: $manifestPath"
    Write-Output "Log: $script:logPath"
} catch {
    Add-SetupLog ''
    Add-SetupLog "OCR SETUP FAILED: $($_.Exception.Message)"
    throw
}
