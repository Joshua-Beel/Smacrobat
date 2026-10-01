[CmdletBinding()]
param([string] $PublisherUiChildPayload)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:PublisherUiScriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$script:PublisherUiPins = [ordered]@{
    Culture = 'en-US'
    DeadlineMilliseconds = 30000
    InteractionMilliseconds = 25000
    ChildDeadlineMilliseconds = 24000
    CleanupMilliseconds = 5000
    PollMilliseconds = 100
    ElementMaximum = 256
    StringLengthMaximum = 256
    StdoutMaximum = 4096
    StderrMaximum = 2048
    PropertyClass = '#32770'
    SignatureTab = 'Digital Signatures'
    DetailsButton = 'Details'
    DetailsTitle = 'Digital Signature Details'
    ValidStatus = 'This digital signature is OK.'
}

function Initialize-PublisherUiInterop {
    if (-not ('Windows.Automation.AutomationElement' -as [type])) {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
    }
    if ('Smacrobat.PublisherUi.NativeShell' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Smacrobat.PublisherUi {
    public static class NativeShell {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct SHELLEXECUTEINFO {
            public uint cbSize;
            public uint fMask;
            public IntPtr hwnd;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpVerb;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpFile;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpParameters;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectory;
            public int nShow;
            public IntPtr hInstApp;
            public IntPtr lpIDList;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpClass;
            public IntPtr hkeyClass;
            public uint dwHotKey;
            public IntPtr hIconOrMonitor;
            public IntPtr hProcess;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ShellExecuteEx(ref SHELLEXECUTEINFO info);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

        private const uint SEE_MASK_INVOKEIDLIST = 0x0000000C;
        private const uint SEE_MASK_NOASYNC = 0x00000100;
        private const uint GW_OWNER = 4;
        private const uint WM_CLOSE = 0x0010;

        public static void ShowProperties(string path) {
            SHELLEXECUTEINFO info = new SHELLEXECUTEINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(SHELLEXECUTEINFO));
            info.fMask = SEE_MASK_INVOKEIDLIST | SEE_MASK_NOASYNC;
            info.lpVerb = "properties";
            info.lpFile = path;
            info.nShow = 1;
            if (!ShellExecuteEx(ref info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows Shell refused the file properties surface.");
        }

        public static bool WindowExists(long handleValue) { return IsWindow(new IntPtr(handleValue)); }
        public static long OwnerOf(long handleValue) { return GetWindow(new IntPtr(handleValue), GW_OWNER).ToInt64(); }
        public static void CloseWindow(long handleValue) {
            IntPtr handle = new IntPtr(handleValue);
            if (IsWindow(handle) && !PostMessage(handle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows refused bounded publisher UI cleanup.");
            }
        }
    }
}
'@
}

function Initialize-PublisherUiIsolation {
    if ('Smacrobat.PublisherUiIsolation.BoundedProcess' -as [type]) { return }
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Windows publisher UI helper isolation requires PowerShell 7 or newer.' }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Smacrobat.PublisherUiIsolation {
    public sealed class BoundedProcessResult {
        public string Stdout { get; set; }
        public string Stderr { get; set; }
        public int ExitCode { get; set; }
        public int ElapsedMilliseconds { get; set; }
        public bool TimedOut { get; set; }
        public bool StdoutExceeded { get; set; }
        public bool StderrExceeded { get; set; }
        public bool JobAssigned { get; set; }
        public bool JobTerminated { get; set; }
        public bool ProcessStopped { get; set; }
        public int ProcessId { get; set; }
        public long ProcessStartTimeUtcTicks { get; set; }
    }

    internal sealed class BoundedCapture {
        private readonly object gate = new object();
        private readonly StringBuilder text;
        private readonly int maximum;
        public volatile bool Exceeded;
        public BoundedCapture(int maximum) { this.maximum = maximum; text = new StringBuilder(Math.Min(maximum, 4096)); }
        public void Append(char[] buffer, int count) {
            lock (gate) {
                int remaining = maximum - text.Length;
                if (count > remaining) {
                    if (remaining > 0) text.Append(buffer, 0, remaining);
                    Exceeded = true;
                } else { text.Append(buffer, 0, count); }
            }
        }
        public string Snapshot() { lock (gate) { return text.ToString(); } }
    }

    public static class BoundedProcess {
        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        private static Task ReadAsync(StreamReader reader, BoundedCapture capture) {
            return Task.Run(async () => {
                char[] buffer = new char[1024];
                try {
                    while (!capture.Exceeded) {
                        int read = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                        if (read == 0) break;
                        capture.Append(buffer, read);
                    }
                } catch { }
            });
        }
        private static void ConfigureJob(IntPtr job) {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr memory = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, memory, false);
                if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not configure publisher UI helper job.");
            } finally { Marshal.FreeHGlobal(memory); }
        }
        private static bool StopJob(IntPtr job, Process process) {
            bool terminated = false;
            try { terminated = TerminateJobObject(job, 125); } catch { }
            try { if (!process.HasExited) process.Kill(true); } catch { }
            try { process.WaitForExit(1000); } catch { }
            return terminated;
        }
        public static BoundedProcessResult Run(string filePath, string[] arguments, string workingDirectory,
            string[] environmentPairs, int timeoutMilliseconds, int maximumStdoutCharacters, int maximumStderrCharacters) {
            if (timeoutMilliseconds <= 0 || maximumStdoutCharacters <= 0 || maximumStderrCharacters <= 0) throw new ArgumentOutOfRangeException("Publisher UI helper bounds must be positive.");
            if (environmentPairs == null || environmentPairs.Length % 2 != 0) throw new ArgumentException("Publisher UI helper environment is malformed.");
            var start = new ProcessStartInfo {
                FileName = filePath, WorkingDirectory = workingDirectory, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false, true), StandardErrorEncoding = new UTF8Encoding(false, true)
            };
            start.Environment.Clear();
            for (int index = 0; index < environmentPairs.Length; index += 2) start.Environment[environmentPairs[index]] = environmentPairs[index + 1];
            foreach (string argument in arguments) start.ArgumentList.Add(argument);

            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create publisher UI helper job.");
            try {
                ConfigureJob(job);
                using (var process = new Process { StartInfo = start }) {
                    if (!process.Start()) throw new InvalidOperationException("Publisher UI helper did not start.");
                    int processId = process.Id;
                    long processStartTicks = process.StartTime.ToUniversalTime().Ticks;
                    bool assigned = AssignProcessToJobObject(job, process.Handle);
                    if (!assigned) { int error = Marshal.GetLastWin32Error(); StopJob(job, process); throw new Win32Exception(error, "Could not bind publisher UI helper to its job."); }
                    var stdout = new BoundedCapture(maximumStdoutCharacters);
                    var stderr = new BoundedCapture(maximumStderrCharacters);
                    Task stdoutTask = ReadAsync(process.StandardOutput, stdout);
                    Task stderrTask = ReadAsync(process.StandardError, stderr);
                    var stopwatch = Stopwatch.StartNew();
                    bool timedOut = false, terminated = false;
                    while (!process.HasExited) {
                        if (stdout.Exceeded || stderr.Exceeded) { terminated = StopJob(job, process); break; }
                        if (stopwatch.ElapsedMilliseconds >= timeoutMilliseconds) { timedOut = true; terminated = StopJob(job, process); break; }
                        Thread.Sleep(10);
                    }
                    if (!process.HasExited) terminated = StopJob(job, process) || terminated;
                    try { Task.WaitAll(new[] { stdoutTask, stderrTask }, 1000); } catch { }
                    return new BoundedProcessResult {
                        Stdout = stdout.Snapshot(), Stderr = stderr.Snapshot(), ExitCode = process.HasExited ? process.ExitCode : -1,
                        ElapsedMilliseconds = checked((int)Math.Min(stopwatch.ElapsedMilliseconds, Int32.MaxValue)), TimedOut = timedOut,
                        StdoutExceeded = stdout.Exceeded, StderrExceeded = stderr.Exceeded, JobAssigned = assigned, JobTerminated = terminated,
                        ProcessStopped = process.HasExited, ProcessId = processId, ProcessStartTimeUtcTicks = processStartTicks
                    };
                }
            } finally { CloseHandle(job); }
        }
    }

    public sealed class WindowIdentity {
        public long Handle { get; set; }
        public uint ProcessId { get; set; }
        public long ProcessStartTimeUtcTicks { get; set; }
        public long Owner { get; set; }
        public string Title { get; set; }
        public string ClassName { get; set; }
    }

    public static class NativeWindow {
        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr state);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int maximum);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder value, int maximum);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
        private const uint GW_OWNER = 4, WM_CLOSE = 0x0010;

        private static WindowIdentity Capture(IntPtr hwnd) {
            if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || !IsWindowEnabled(hwnd)) return null;
            var title = new StringBuilder(512); var className = new StringBuilder(256);
            GetWindowText(hwnd, title, title.Capacity); GetClassName(hwnd, className, className.Capacity);
            uint processId; GetWindowThreadProcessId(hwnd, out processId);
            try {
                using (Process process = Process.GetProcessById((int)processId)) {
                    return new WindowIdentity { Handle = hwnd.ToInt64(), ProcessId = processId, ProcessStartTimeUtcTicks = process.StartTime.ToUniversalTime().Ticks,
                        Owner = GetWindow(hwnd, GW_OWNER).ToInt64(), Title = title.ToString(), ClassName = className.ToString() };
                }
            } catch { return null; }
        }
        public static WindowIdentity[] Exact(string title, string className) {
            var result = new List<WindowIdentity>();
            EnumWindows((hwnd, state) => { WindowIdentity item = Capture(hwnd);
                if (item != null && String.Equals(item.Title, title, StringComparison.Ordinal) && String.Equals(item.ClassName, className, StringComparison.Ordinal)) result.Add(item);
                return true; }, IntPtr.Zero);
            return result.ToArray();
        }
        public static bool StillMatches(WindowIdentity expected) {
            WindowIdentity current = Capture(new IntPtr(expected.Handle));
            return current != null && current.ProcessId == expected.ProcessId && current.ProcessStartTimeUtcTicks == expected.ProcessStartTimeUtcTicks && current.Owner == expected.Owner &&
                String.Equals(current.Title, expected.Title, StringComparison.Ordinal) && String.Equals(current.ClassName, expected.ClassName, StringComparison.Ordinal);
        }
        public static bool CloseExact(WindowIdentity expected) {
            if (!StillMatches(expected)) return false;
            return PostMessage(new IntPtr(expected.Handle), WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }
    }
}
'@
}

function Assert-PublisherUiDeadline {
    param([Parameter(Mandatory = $true)][datetime]$Deadline)
    if ([datetime]::UtcNow -ge $Deadline) { throw 'Windows publisher UI verification exceeded its total deadline.' }
}

function Get-PublisherUiCultureFacts {
    param([scriptblock]$CultureProvider)
    $facts = if ($CultureProvider) {
        & $CultureProvider
    } else {
        [pscustomobject]@{
            Culture = [Globalization.CultureInfo]::CurrentCulture.Name
            UICulture = [Globalization.CultureInfo]::CurrentUICulture.Name
        }
    }
    $properties = @($facts.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if ($properties.Count -ne 2 -or (Compare-Object @('Culture','UICulture') $properties -CaseSensitive)) {
        throw 'Windows publisher UI culture facts are malformed.'
    }
    if ([string]$facts.Culture -cne $script:PublisherUiPins.Culture -or [string]$facts.UICulture -cne $script:PublisherUiPins.Culture) {
        throw 'Windows publisher UI verification requires exact en-US culture and UI culture.'
    }
    return $facts
}

function Get-PublisherUiElementName {
    param([Parameter(Mandatory = $true)]$Element)
    $name = [string]$Element.Current.Name
    if ($name.Length -gt $script:PublisherUiPins.StringLengthMaximum) { throw 'Windows publisher UI exposed an oversized accessible name.' }
    return $name
}

function Get-PublisherUiExactElements {
    param(
        [Parameter(Mandatory = $true)]$Root,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)]$ControlType,
        [Parameter(Mandatory = $true)][datetime]$Deadline,
        [Windows.Automation.TreeScope]$Scope = [Windows.Automation.TreeScope]::Descendants
    )
    Assert-PublisherUiDeadline -Deadline $Deadline
    if ($Name.Length -gt $script:PublisherUiPins.StringLengthMaximum) { throw 'Windows publisher UI expected name exceeds its bound.' }
    $condition = [Windows.Automation.AndCondition]::new([Windows.Automation.Condition[]]@(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Name),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$ControlType)
    ))
    $matches = @($Root.FindAll($Scope,$condition) | ForEach-Object { $_ })
    Assert-PublisherUiDeadline -Deadline $Deadline
    if ($matches.Count -gt $script:PublisherUiPins.ElementMaximum) { throw 'Windows publisher UI exact-element result exceeded its bound.' }
    foreach ($match in $matches) { $null = Get-PublisherUiElementName -Element $match }
    return $matches
}

function Get-PublisherUiExactWindows {
    param([Parameter(Mandatory = $true)][string]$Title,[Parameter(Mandatory = $true)][datetime]$Deadline)
    Initialize-PublisherUiInterop
    $windows = @(Get-PublisherUiExactElements -Root ([Windows.Automation.AutomationElement]::RootElement) -Name $Title -ControlType ([Windows.Automation.ControlType]::Window) -Scope ([Windows.Automation.TreeScope]::Children) -Deadline $Deadline)
    $matches = @($windows | Where-Object {
        ([string]$_.Current.ClassName).Equals($script:PublisherUiPins.PropertyClass,[StringComparison]::Ordinal) -and
        [long]$_.Current.NativeWindowHandle -ne 0 -and [bool]$_.Current.IsEnabled -and -not [bool]$_.Current.IsOffscreen
    })
    if ($matches.Count -gt $script:PublisherUiPins.ElementMaximum) { throw 'Windows publisher UI top-level result exceeded its bound.' }
    return $matches
}

function Wait-PublisherUiExactWindow {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][datetime]$Deadline,
        [long]$ExpectedOwner = 0
    )
    do {
        Assert-PublisherUiDeadline -Deadline $Deadline
        $matches = @(Get-PublisherUiExactWindows -Title $Title -Deadline $Deadline)
        if ($ExpectedOwner -ne 0) {
            $matches = @($matches | Where-Object { [Smacrobat.PublisherUi.NativeShell]::OwnerOf([long]$_.Current.NativeWindowHandle) -eq $ExpectedOwner })
        }
        if ($matches.Count -eq 1) { return $matches[0] }
        if ($matches.Count -gt 1) { throw 'Windows publisher UI top-level identity was ambiguous.' }
        Start-Sleep -Milliseconds $script:PublisherUiPins.PollMilliseconds
    } while ([datetime]::UtcNow -lt $Deadline)
    throw 'Windows publisher UI expected window did not appear before the deadline.'
}

function Invoke-PublisherUiSelection {
    param([Parameter(Mandatory = $true)]$Element,[Parameter(Mandatory = $true)][datetime]$Deadline)
    Assert-PublisherUiDeadline -Deadline $Deadline
    $pattern = $null
    if (-not $Element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {
        throw 'Windows publisher UI selection did not expose SelectionItemPattern.'
    }
    ([Windows.Automation.SelectionItemPattern]$pattern).Select()
    Assert-PublisherUiDeadline -Deadline $Deadline
}

function Invoke-PublisherUiButton {
    param([Parameter(Mandatory = $true)]$Element,[Parameter(Mandatory = $true)][datetime]$Deadline)
    Assert-PublisherUiDeadline -Deadline $Deadline
    $pattern = $null
    if (-not $Element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {
        throw 'Windows publisher UI button did not expose InvokePattern.'
    }
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
    Assert-PublisherUiDeadline -Deadline $Deadline
}

function Close-PublisherUiWindow {
    param([long]$HandleValue,[Parameter(Mandatory = $true)][datetime]$Deadline)
    if ($HandleValue -eq 0) { return }
    Assert-PublisherUiDeadline -Deadline $Deadline
    [Smacrobat.PublisherUi.NativeShell]::CloseWindow($HandleValue)
    while ([Smacrobat.PublisherUi.NativeShell]::WindowExists($HandleValue)) {
        Assert-PublisherUiDeadline -Deadline $Deadline
        Start-Sleep -Milliseconds $script:PublisherUiPins.PollMilliseconds
    }
}

function Invoke-WindowsShellPublisherSurface {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
        [int]$TimeoutMilliseconds = $script:PublisherUiPins.DeadlineMilliseconds
    )
    if ($TimeoutMilliseconds -le 0 -or $TimeoutMilliseconds -gt $script:PublisherUiPins.DeadlineMilliseconds) {
        throw 'Windows publisher UI timeout is outside its supported bound.'
    }
    Initialize-PublisherUiInterop
    $totalDeadline = [datetime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $interactionDeadline = $totalDeadline.AddMilliseconds(-$script:PublisherUiPins.CleanupMilliseconds)
    if ($interactionDeadline -le [datetime]::UtcNow) { throw 'Windows publisher UI timeout leaves no cleanup budget.' }
    $fileName = [IO.Path]::GetFileName($Path)
    $propertiesTitle = "$fileName Properties"
    if (@(Get-PublisherUiExactWindows -Title $propertiesTitle -Deadline $interactionDeadline).Count -ne 0 -or
        @(Get-PublisherUiExactWindows -Title $script:PublisherUiPins.DetailsTitle -Deadline $interactionDeadline).Count -ne 0) {
        throw 'Windows publisher UI verification requires a fresh matching desktop surface.'
    }

    [long]$propertiesHandle = 0
    [long]$detailsHandle = 0
    $propertiesInvoked = $false
    $detailsInvoked = $false
    try {
        [Smacrobat.PublisherUi.NativeShell]::ShowProperties($Path)
        $propertiesInvoked = $true
        $properties = Wait-PublisherUiExactWindow -Title $propertiesTitle -Deadline $interactionDeadline
        $propertiesHandle = [long]$properties.Current.NativeWindowHandle

        $tabs = @(Get-PublisherUiExactElements -Root $properties -Name $script:PublisherUiPins.SignatureTab -ControlType ([Windows.Automation.ControlType]::TabItem) -Deadline $interactionDeadline)
        if ($tabs.Count -ne 1) { throw 'Windows publisher UI did not expose one exact Digital Signatures tab.' }
        Invoke-PublisherUiSelection -Element $tabs[0] -Deadline $interactionDeadline

        $signers = @()
        foreach ($type in @([Windows.Automation.ControlType]::DataItem,[Windows.Automation.ControlType]::ListItem,[Windows.Automation.ControlType]::Text)) {
            $signers += @(Get-PublisherUiExactElements -Root $properties -Name $ExpectedPublisher -ControlType $type -Deadline $interactionDeadline)
        }
        $signerHandles = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $uniqueSigners = @($signers | Where-Object { $signerHandles.Add((($_.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.')) })
        if ($uniqueSigners.Count -ne 1) { throw 'Windows publisher UI did not expose one exact expected signer row.' }

        $buttons = @(Get-PublisherUiExactElements -Root $properties -Name $script:PublisherUiPins.DetailsButton -ControlType ([Windows.Automation.ControlType]::Button) -Deadline $interactionDeadline)
        if ($buttons.Count -ne 1) { throw 'Windows publisher UI did not expose one exact Details action.' }
        Invoke-PublisherUiButton -Element $buttons[0] -Deadline $interactionDeadline
        $detailsInvoked = $true

        $details = Wait-PublisherUiExactWindow -Title $script:PublisherUiPins.DetailsTitle -ExpectedOwner $propertiesHandle -Deadline $interactionDeadline
        $detailsHandle = [long]$details.Current.NativeWindowHandle
        $status = @(Get-PublisherUiExactElements -Root $details -Name $script:PublisherUiPins.ValidStatus -ControlType ([Windows.Automation.ControlType]::Text) -Deadline $interactionDeadline)
        if ($status.Count -ne 1) { throw 'Windows publisher UI did not expose the exact valid-signature status.' }
        $publisherLabels = @()
        foreach ($name in @($ExpectedPublisher,"Name: $ExpectedPublisher")) {
            $publisherLabels += @(Get-PublisherUiExactElements -Root $details -Name $name -ControlType ([Windows.Automation.ControlType]::Text) -Deadline $interactionDeadline)
        }
        $publisherIdentities = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $uniquePublisherLabels = @($publisherLabels | Where-Object { $publisherIdentities.Add((($_.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.')) })
        if ($uniquePublisherLabels.Count -ne 1) { throw 'Windows publisher UI details did not expose the exact expected signer.' }

        return [pscustomobject]@{
            uiCulture = $script:PublisherUiPins.Culture
            shellPropertiesDialog = $true
            digitalSignaturesTab = $true
            signerRowMatched = $true
            detailsDialog = $true
            statusTextMatched = $true
            cleanupVerified = $true
            screenshotsUsed = $false
        }
    } finally {
        if ($propertiesHandle -eq 0 -and $propertiesInvoked) {
            $propertiesCleanupMatches = @(Get-PublisherUiExactWindows -Title $propertiesTitle -Deadline $totalDeadline)
            if ($propertiesCleanupMatches.Count -gt 1) { throw 'Windows publisher UI cleanup found ambiguous file properties surfaces.' }
            if ($propertiesCleanupMatches.Count -eq 1) { $propertiesHandle = [long]$propertiesCleanupMatches[0].Current.NativeWindowHandle }
        }
        if ($detailsHandle -eq 0 -and $detailsInvoked -and $propertiesHandle -ne 0) {
            $detailsCleanupMatches = @(Get-PublisherUiExactWindows -Title $script:PublisherUiPins.DetailsTitle -Deadline $totalDeadline | Where-Object {
                [Smacrobat.PublisherUi.NativeShell]::OwnerOf([long]$_.Current.NativeWindowHandle) -eq $propertiesHandle
            })
            if ($detailsCleanupMatches.Count -gt 1) { throw 'Windows publisher UI cleanup found ambiguous signature-details surfaces.' }
            if ($detailsCleanupMatches.Count -eq 1) { $detailsHandle = [long]$detailsCleanupMatches[0].Current.NativeWindowHandle }
        }
        if ($detailsHandle -ne 0) { Close-PublisherUiWindow -HandleValue $detailsHandle -Deadline $totalDeadline }
        if ($propertiesHandle -ne 0) { Close-PublisherUiWindow -HandleValue $propertiesHandle -Deadline $totalDeadline }
    }
}

function Get-PublisherUiMinimalEnvironment {
    $required = @('SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC')
    $pairs = [Collections.Generic.List[string]]::new()
    foreach ($name in $required) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ([string]::IsNullOrWhiteSpace($value)) { throw "Windows publisher UI helper requires $name." }
        $pairs.Add($name)
        $pairs.Add($value)
    }
    $pairs.Add('Path')
    $pairs.Add("$PSHOME;$env:SystemRoot\System32;$env:SystemRoot")
    $pairs.Add('POWERSHELL_TELEMETRY_OPTOUT')
    $pairs.Add('1')
    $pairs.Add('DOTNET_CLI_TELEMETRY_OPTOUT')
    $pairs.Add('1')
    return $pairs.ToArray()
}

function Invoke-PublisherUiExactCleanup {
    param(
        [Parameter(Mandatory = $true)][string]$PropertiesTitle,
        [Parameter(Mandatory = $true)][datetime]$Deadline
    )
    foreach ($title in @($script:PublisherUiPins.DetailsTitle,$PropertiesTitle)) {
        $matches = @([Smacrobat.PublisherUiIsolation.NativeWindow]::Exact($title,$script:PublisherUiPins.PropertyClass))
        if ($matches.Count -gt 1) { throw 'Windows publisher UI cleanup topology was ambiguous.' }
        if ($matches.Count -eq 1) {
            $identity = $matches[0]
            if (-not [Smacrobat.PublisherUiIsolation.NativeWindow]::CloseExact($identity)) { throw 'Windows publisher UI cleanup identity changed.' }
            while ([Smacrobat.PublisherUiIsolation.NativeWindow]::StillMatches($identity)) {
                if ([datetime]::UtcNow -ge $Deadline) { throw 'Windows publisher UI cleanup exceeded its deadline.' }
                Start-Sleep -Milliseconds $script:PublisherUiPins.PollMilliseconds
            }
        }
    }
    if (@([Smacrobat.PublisherUiIsolation.NativeWindow]::Exact($PropertiesTitle,$script:PublisherUiPins.PropertyClass)).Count -ne 0 -or
        @([Smacrobat.PublisherUiIsolation.NativeWindow]::Exact($script:PublisherUiPins.DetailsTitle,$script:PublisherUiPins.PropertyClass)).Count -ne 0) {
        throw 'Windows publisher UI cleanup was incomplete.'
    }
}

function Assert-PublisherUiSurfaceProof {
    param([Parameter(Mandatory = $true)]$Surface)
    $expected = @('cleanupVerified','detailsDialog','digitalSignaturesTab','screenshotsUsed','shellPropertiesDialog','signerRowMatched','statusTextMatched','uiCulture') | Sort-Object -CaseSensitive
    $actual = @($Surface.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if ($actual.Count -ne $expected.Count -or (Compare-Object $expected $actual -CaseSensitive) -or
        [string]$Surface.uiCulture -cne $script:PublisherUiPins.Culture -or
        $Surface.shellPropertiesDialog -isnot [bool] -or -not $Surface.shellPropertiesDialog -or
        $Surface.digitalSignaturesTab -isnot [bool] -or -not $Surface.digitalSignaturesTab -or
        $Surface.signerRowMatched -isnot [bool] -or -not $Surface.signerRowMatched -or
        $Surface.detailsDialog -isnot [bool] -or -not $Surface.detailsDialog -or
        $Surface.statusTextMatched -isnot [bool] -or -not $Surface.statusTextMatched -or
        $Surface.cleanupVerified -isnot [bool] -or -not $Surface.cleanupVerified -or
        $Surface.screenshotsUsed -isnot [bool] -or $Surface.screenshotsUsed) {
        throw 'Windows publisher UI surface proof is incomplete or malformed.'
    }
}

function ConvertFrom-PublisherUiHelperOutput {
    param([Parameter(Mandatory = $true)]$Result)
    $expectedResult = @(
        'ElapsedMilliseconds','ExitCode','JobAssigned','JobTerminated','ProcessId','ProcessStartTimeUtcTicks',
        'ProcessStopped','Stderr','StderrExceeded','Stdout','StdoutExceeded','TimedOut'
    ) | Sort-Object -CaseSensitive
    $actualResult = @($Result.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if ($actualResult.Count -ne $expectedResult.Count -or (Compare-Object $expectedResult $actualResult -CaseSensitive) -or
        $Result.TimedOut -isnot [bool] -or $Result.StdoutExceeded -isnot [bool] -or $Result.StderrExceeded -isnot [bool] -or
        $Result.JobAssigned -isnot [bool] -or $Result.JobTerminated -isnot [bool] -or $Result.ProcessStopped -isnot [bool] -or
        $Result.TimedOut -or $Result.StdoutExceeded -or $Result.StderrExceeded -or -not $Result.JobAssigned -or -not $Result.ProcessStopped -or
        [int]$Result.ExitCode -ne 0 -or -not [string]::IsNullOrEmpty([string]$Result.Stderr)) {
        throw 'Windows publisher UI helper process did not complete safely.'
    }
    $stdout = [string]$Result.Stdout
    if ([string]::IsNullOrEmpty($stdout) -or $stdout.Length -gt $script:PublisherUiPins.StdoutMaximum -or
        $stdout -cne $stdout.Trim() -or $stdout.Contains("`r") -or $stdout.Contains("`n") -or
        -not $stdout.StartsWith('{',[StringComparison]::Ordinal) -or -not $stdout.EndsWith('}',[StringComparison]::Ordinal)) {
        throw 'Windows publisher UI helper output framing is invalid.'
    }
    try { $surface = $stdout | ConvertFrom-Json -Depth 4 } catch { throw 'Windows publisher UI helper output is not one JSON object.' }
    Assert-PublisherUiSurfaceProof -Surface $surface
    return $surface
}

function Invoke-PublisherUiHelperProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedPublisher
    )
    Initialize-PublisherUiIsolation
    $totalDeadline = [datetime]::UtcNow.AddMilliseconds($script:PublisherUiPins.DeadlineMilliseconds)
    $propertiesTitle = "$(Split-Path -Leaf $Path) Properties"
    if (@([Smacrobat.PublisherUiIsolation.NativeWindow]::Exact($propertiesTitle,$script:PublisherUiPins.PropertyClass)).Count -ne 0 -or
        @([Smacrobat.PublisherUiIsolation.NativeWindow]::Exact($script:PublisherUiPins.DetailsTitle,$script:PublisherUiPins.PropertyClass)).Count -ne 0) {
        throw 'Windows publisher UI verification requires a fresh exact desktop surface.'
    }
    $payloadJson = [pscustomobject][ordered]@{
        path = $Path
        expectedPublisher = $ExpectedPublisher
        timeoutMilliseconds = $script:PublisherUiPins.ChildDeadlineMilliseconds
    } | ConvertTo-Json -Compress
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payloadJson))
    $arguments = @(
        '-NoLogo','-NoProfile','-NonInteractive','-Sta','-File',$script:PublisherUiScriptPath,
        '-PublisherUiChildPayload',$payload
    )
    $result = $null
    try {
        $result = [Smacrobat.PublisherUiIsolation.BoundedProcess]::Run(
            (Join-Path $PSHOME 'pwsh.exe'),
            $arguments,
            (Split-Path -Parent $script:PublisherUiScriptPath),
            (Get-PublisherUiMinimalEnvironment),
            $script:PublisherUiPins.InteractionMilliseconds,
            $script:PublisherUiPins.StdoutMaximum,
            $script:PublisherUiPins.StderrMaximum
        )
    } finally {
        Invoke-PublisherUiExactCleanup -PropertiesTitle $propertiesTitle -Deadline $totalDeadline
    }
    return ConvertFrom-PublisherUiHelperOutput -Result $result
}

function Get-PublisherUiSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','') }
        finally { $algorithm.Dispose() }
    } finally { $stream.Dispose() }
}

function Assert-PublisherUiFileReceipt {
    param([Parameter(Mandatory = $true)][string]$Path,[Parameter(Mandatory = $true)]$Receipt)
    $properties = @($Receipt.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if ($properties.Count -ne 2 -or (Compare-Object @('bytes','sha256') $properties -CaseSensitive) -or
        [uint64]$Receipt.bytes -eq 0 -or [string]$Receipt.sha256 -cnotmatch '^[A-F0-9]{64}$') {
        throw 'Windows publisher UI file receipt is malformed.'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or [IO.Path]::GetExtension($Path) -cne '.exe') {
        throw 'Windows publisher UI input must be one existing executable file.'
    }
    if (Get-Command Assert-NoReparseAncestors -ErrorAction SilentlyContinue) { Assert-NoReparseAncestors -Path $Path }
    $item = Get-Item -LiteralPath $Path
    if ([uint64]$item.Length -ne [uint64]$Receipt.bytes -or (Get-PublisherUiSha256 -Path $Path) -cne [string]$Receipt.sha256) {
        throw 'Windows publisher UI input does not match its exact receipt.'
    }
}

function Invoke-InstalledPublisherUiProof {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)][ValidateSet('installer','installed-application')][string]$Kind,
        [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
        [scriptblock]$SignatureProvider,
        [scriptblock]$CultureProvider
    )
    if ([string]::IsNullOrWhiteSpace($ExpectedPublisher) -or $ExpectedPublisher -cnotmatch "^[A-Za-z0-9][A-Za-z0-9 .,&'()/-]{0,127}$") { throw 'Windows publisher UI expected publisher is invalid.' }
    $canonical = [IO.Path]::GetFullPath($Path)
    $null = Get-PublisherUiCultureFacts -CultureProvider $CultureProvider
    Assert-PublisherUiFileReceipt -Path $canonical -Receipt $Receipt
    if (-not (Get-Command Assert-TrustedWindowsSignature -ErrorAction SilentlyContinue)) { throw 'Windows signature verifier is unavailable.' }
    $null = Assert-TrustedWindowsSignature -Path $canonical -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher

    $lock = [IO.File]::Open($canonical,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $surface = Invoke-PublisherUiHelperProcess -Path $canonical -ExpectedPublisher $ExpectedPublisher
        Assert-PublisherUiSurfaceProof -Surface $surface
    } finally {
        $lock.Dispose()
    }

    Assert-PublisherUiFileReceipt -Path $canonical -Receipt $Receipt
    $null = Assert-TrustedWindowsSignature -Path $canonical -SignatureProvider $SignatureProvider -ExpectedPublisher $ExpectedPublisher
    return [pscustomobject][ordered]@{
        kind = $Kind
        fileName = [IO.Path]::GetFileName($canonical)
        bytes = [uint64]$Receipt.bytes
        sha256 = [string]$Receipt.sha256
        publisher = $ExpectedPublisher
        uiCulture = $script:PublisherUiPins.Culture
        shellPropertiesDialog = $true
        digitalSignaturesTab = $true
        signerRowMatched = $true
        detailsDialog = $true
        statusTextMatched = $true
        trustedTimestampVerified = $true
        cleanupVerified = $true
        screenshotsUsed = $false
    }
}

function Invoke-PublisherUiChild {
    param([Parameter(Mandatory = $true)][string]$Payload)
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json -Depth 3
    $properties = @($decoded.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if ($properties.Count -ne 3 -or (Compare-Object @('expectedPublisher','path','timeoutMilliseconds') $properties -CaseSensitive) -or
        [string]::IsNullOrWhiteSpace([string]$decoded.path) -or
        [string]$decoded.expectedPublisher -cnotmatch "^[A-Za-z0-9][A-Za-z0-9 .,&'()/-]{0,127}$" -or
        [int]$decoded.timeoutMilliseconds -ne $script:PublisherUiPins.ChildDeadlineMilliseconds) {
        throw 'Windows publisher UI child payload is malformed.'
    }
    $null = Get-PublisherUiCultureFacts
    return Invoke-WindowsShellPublisherSurface -Path ([IO.Path]::GetFullPath([string]$decoded.path)) `
        -ExpectedPublisher ([string]$decoded.expectedPublisher) -TimeoutMilliseconds ([int]$decoded.timeoutMilliseconds)
}

if (-not [string]::IsNullOrWhiteSpace($PublisherUiChildPayload)) {
    try {
        $ProgressPreference = 'SilentlyContinue'
        $WarningPreference = 'SilentlyContinue'
        $InformationPreference = 'SilentlyContinue'
        $childProof = Invoke-PublisherUiChild -Payload $PublisherUiChildPayload
        [Console]::Out.Write(($childProof | ConvertTo-Json -Compress -Depth 3))
        exit 0
    } catch {
        [Console]::Error.Write('publisher-ui-child-failed')
        exit 1
    }
}
