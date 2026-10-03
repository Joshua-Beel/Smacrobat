param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputPath = (Join-Path $env:RUNNER_TEMP 'default-comments-forms-native-evidence.json'),
    [string]$CargoPath = 'cargo',
    [int]$TestTimeoutMilliseconds = 900000
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($TestTimeoutMilliseconds -lt 1000 -or $TestTimeoutMilliseconds -gt 900000) {
    throw 'The native evidence timeout is outside its fixed bounds.'
}

if (-not ('SmacrobatBoundedNativeTest' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
public static class SmacrobatBoundedNativeTest {
  static async Task<string> Read(System.IO.StreamReader reader, int cap, Action kill) {
    var result = new StringBuilder(); var buffer = new char[4096];
    while (true) { var count = await reader.ReadAsync(buffer, 0, buffer.Length); if (count == 0) break;
      if (result.Length + count > cap) { kill(); throw new InvalidOperationException("Native test output exceeded its fixed cap."); }
      result.Append(buffer, 0, count); }
    return result.ToString();
  }
  public static string Run(string executable, string[] arguments, string workingDirectory, int timeoutMilliseconds) {
    var start = new ProcessStartInfo { FileName=executable, WorkingDirectory=workingDirectory, UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true };
    foreach (var value in arguments) start.ArgumentList.Add(value);
    using (var process = new Process { StartInfo=start }) {
      if (!process.Start()) throw new InvalidOperationException("Native test process did not start.");
      Action kill = () => { try { if (!process.HasExited) process.Kill(true); } catch {} };
      var stdout = Read(process.StandardOutput, 1048576, kill); var stderr = Read(process.StandardError, 1048576, kill);
      var completion = Task.WhenAll(stdout, stderr, process.WaitForExitAsync());
      try { if (!completion.Wait(timeoutMilliseconds)) { kill(); throw new TimeoutException("Native test process exceeded its fixed deadline."); } completion.GetAwaiter().GetResult(); }
      catch { kill(); throw; }
      var output = stdout.Result + "\n" + stderr.Result;
      if (process.ExitCode != 0) throw new InvalidOperationException("Native evidence test failed with exit code " + process.ExitCode + ".\n" + output);
      return output;
    }
  }
}
'@
}

function Assert-ExactNativeTestResult {
    param([string]$Output, [string]$Name)
    if (-not $Output.Contains("test $Name ... ok", [StringComparison]::Ordinal)) {
        throw "The exact native evidence test did not report success: $Name"
    }
    if ($Output -notmatch '(?m)^test result: ok\. 1 passed; 0 failed; [0-9]+ ignored; 0 measured; [0-9]+ filtered out; finished in ') {
        throw "The exact native evidence test footer was missing: $Name"
    }
}

function Assert-NoReparseAncestors {
    param([string]$Path, [string]$StopAt)
    $current = Get-Item -LiteralPath $Path -Force
    $stop = (Resolve-Path -LiteralPath $StopAt).Path.TrimEnd('\')
    while ($null -ne $current) {
        if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A native evidence input has a reparse ancestor.' }
        if ($current.FullName.TrimEnd('\') -ceq $stop) { return }
        $current = if ($current -is [IO.DirectoryInfo]) { $current.Parent } else { $current.Directory }
    }
    throw 'A native evidence input escaped the project root.'
}

$tests = @(
    [pscustomobject][ordered]@{ id='comments-undo'; name='comments::tests::comments_undo_redo_saved_baseline_noops_and_source_remain_consistent' },
    [pscustomobject][ordered]@{ id='sticky-render'; name='service::tests::comments_rotations_inherited_crop_pixels_unicode_reopen_and_print_snapshots_agree' },
    [pscustomobject][ordered]@{ id='area-highlight-render'; name='service::tests::highlights_all_rotations_inherited_crop_multiply_pixels_unicode_reopen_and_print_isolation' },
    [pscustomobject][ordered]@{ id='selected-text-render'; name='service::tests::text_highlights_multiline_unicode_all_rotations_crops_pixels_reopen_and_print_isolation' },
    [pscustomobject][ordered]@{ id='forms-engine'; name='service::tests::forms_reportlab_engine_crops_rotations_values_print_and_source_preservation' },
    [pscustomobject][ordered]@{ id='forms-round-trip'; name='forms::tests::forms_reportlab_values_appearances_and_styles_round_trip_and_clear' }
)

$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$manifest = Join-Path $resolvedRoot 'src-tauri\Cargo.toml'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'The native evidence Cargo manifest is missing.' }
if (Test-Path -LiteralPath $OutputPath) { throw 'The native evidence output must be fresh.' }
$outputParent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) { throw 'The native evidence output parent is missing.' }

$head = (& git -C $resolvedRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') { throw 'The native evidence source revision is unavailable.' }
if (-not [string]::IsNullOrEmpty($env:PDF_WORKSTATION_OCR_SETUP_ROOT)) { throw 'The optional OCR build input must be disabled for native evidence.' }
$allowedOverride = 'src-tauri/resources/third-party-licenses/THIRD-PARTY-NOTICES.txt'
$status = @(& git -C $resolvedRoot status --porcelain=v1 --untracked-files=all -- Cargo.lock src-tauri)
if ($LASTEXITCODE -ne 0) { throw 'The native test input closure status is unavailable.' }
$overrides = @()
foreach ($line in $status) {
    if ($line.Length -lt 4 -or $line.Substring(3).Replace('\','/') -cne $allowedOverride) { throw 'The native test input closure contains an unrecorded change.' }
    $overridePath = Join-Path $resolvedRoot $allowedOverride
    Assert-NoReparseAncestors -Path $overridePath -StopAt $resolvedRoot
    $override = Get-Item -LiteralPath $overridePath -Force
    $overrides += [pscustomobject][ordered]@{ path=$allowedOverride; bytes=[uint64]$override.Length; sha256=(Get-FileHash -LiteralPath $overridePath -Algorithm SHA256).Hash }
}
$pdfiumPath = Join-Path $resolvedRoot 'src-tauri\resources\pdfium\bin\pdfium.dll'
if (-not (Test-Path -LiteralPath $pdfiumPath -PathType Leaf)) { throw 'The pinned native PDF engine is missing.' }
Assert-NoReparseAncestors -Path $pdfiumPath -StopAt $resolvedRoot
$pdfium = Get-Item -LiteralPath $pdfiumPath
if ($pdfium.Attributes -band [IO.FileAttributes]::ReparsePoint -or $pdfium.Length -lt 1) { throw 'The pinned native PDF engine is unsafe.' }
$pdfiumSha256 = (Get-FileHash -LiteralPath $pdfiumPath -Algorithm SHA256).Hash

$passed = @()
foreach ($test in $tests) {
    $arguments = @('test','--locked','--manifest-path',$manifest,$test.name,'--','--exact','--test-threads=1')
    $output = [SmacrobatBoundedNativeTest]::Run($CargoPath, $arguments, $resolvedRoot, $TestTimeoutMilliseconds)
    Assert-ExactNativeTestResult -Output $output -Name $test.name
    $passed += $test.id
}

$receipt = [pscustomobject][ordered]@{
    schemaVersion = 1
    scope = 'source-native-comments-forms'
    baseSourceRevision = $head
    trackedInputOverrides = $overrides
    pdfium = [pscustomobject][ordered]@{ bytes=[uint64]$pdfium.Length; sha256=$pdfiumSha256 }
    exactTestsPassed = $passed
    exactTestCount = $passed.Count
    stickyNotes = [pscustomobject][ordered]@{ savedSemantic=$true; renderedAppearance=$true; reopen=$true; undo=$true; redo=$true; printIsolation=$true; sourcePreserved=$true }
    areaHighlights = [pscustomobject][ordered]@{ savedSemantic=$true; renderedAppearance=$true; reopen=$true; undo=$true; redo=$true; printIsolation=$true; sourcePreserved=$true }
    selectedTextHighlights = [pscustomobject][ordered]@{ savedSemantic=$true; renderedAppearance=$true; multilineUnicode=$true; reopen=$true; undo=$true; redo=$true; printIsolation=$true; sourcePreserved=$true }
    forms = [pscustomobject][ordered]@{ valuesRoundTrip=$true; appearancesRoundTrip=$true; cropRotation=$true; reopen=$true; printIsolation=$true; sourcePreserved=$true }
    limitations = [pscustomobject][ordered]@{ installedApplicationVerified=$false; nativeDesktopInteractionVerified=$false; arbitraryPdfCompatibilityVerified=$false }
}
[IO.File]::WriteAllText($OutputPath, ($receipt | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
