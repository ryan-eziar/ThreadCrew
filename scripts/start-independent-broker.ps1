param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$RuntimeDir,
    [Parameter(Mandatory = $true)][string]$LaunchId
)

$ErrorActionPreference = 'Stop'
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimePath = [System.IO.Path]::GetFullPath($RuntimeDir)
$parsedId = [guid]::Empty
if (-not [guid]::TryParseExact($LaunchId, 'N', [ref]$parsedId)) { throw 'Invalid broker launch ID.' }
$resultPath = Join-Path $runtimePath "launcher-broker.$LaunchId.result.json"
try {
    # WMI creates this bootstrap outside the calling app's Job. BREAKAWAY also
    # excludes the WMI provider's quota Job. A hidden window alone does neither.
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ThreadCrewProcessJob {
    [StructLayout(LayoutKind.Sequential)] struct Security {
        public uint length; public IntPtr descriptor; public int inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public uint cb; public string reserved, desktop, title;
        public uint x,y,width,height,xChars,yChars,fill,flags;
        public ushort show, reservedSize; public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security security, uint mode, uint attrs, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static bool Contains(uint pid) {
        var process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        try {
            bool result;
            if (!IsProcessInJob(process, IntPtr.Zero, out result)) throw new System.ComponentModel.Win32Exception();
            return result;
        } finally { CloseHandle(process); }
    }
    static IntPtr File(string name, uint access, uint mode) {
        var security = new Security(); security.length = (uint)Marshal.SizeOf(typeof(Security)); security.inherit = 1;
        var handle = CreateFile(name, access, 3, ref security, mode, 0x80, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
        return handle;
    }
    public static uint Launch(string exe, string chat, string runtime, string cwd, string stdout, string stderr) {
        var input = IntPtr.Zero; var output = IntPtr.Zero; var error = IntPtr.Zero;
        var info = new Info(); bool created = false, resumed = false;
        try {
            input = File("NUL", 0x80000000, 3);
            output = File(stdout, 0x40000000, 1); error = File(stderr, 0x40000000, 1);
            var startup = new Startup(); startup.cb = (uint)Marshal.SizeOf(typeof(Startup));
            startup.flags = 0x101; startup.show = 0; startup.input = input; startup.output = output; startup.error = error;
            var command = new StringBuilder("\"" + exe + "\" \"" + chat + "\" serve --runtime-dir \"" + runtime + "\"");
            // Suspended creation makes this check independent of Node's own
            // libuv Job, which it may create later when starting a subprocess.
            if (!CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref startup, out info)) throw new System.ComponentModel.Win32Exception();
            created = true;
            bool inJob;
            if (!IsProcessInJob(info.process, IntPtr.Zero, out inJob)) throw new System.ComponentModel.Win32Exception();
            if (inJob) throw new InvalidOperationException("Broker inherited a Windows Job; independent startup refused.");
            if (ResumeThread(info.thread) == 0xffffffff) throw new System.ComponentModel.Win32Exception();
            resumed = true;
            return info.pid;
        } finally {
            // An unsafe suspended child never runs or writes the runtime.
            if (created && !resumed) TerminateProcess(info.process, 1);
            if (info.thread != IntPtr.Zero) CloseHandle(info.thread);
            if (info.process != IntPtr.Zero) CloseHandle(info.process);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
        }
    }
}
'@
    if ([ThreadCrewProcessJob]::Contains($PID)) { throw 'Independent bootstrap is still in a Windows Job; no broker was started.' }
    $nodeExe = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).ProviderPath
    if ([System.IO.Path]::GetFileName($nodeExe) -ne 'node.exe') { throw 'Broker requires node.exe.' }
    $chatPath = Join-Path $projectDir 'chat.mjs'
    # These are filesystem paths, not shell code. Double quotes cannot be part
    # of a Windows filename; quote paths to preserve spaces and apostrophes.
    $processId = [ThreadCrewProcessJob]::Launch($nodeExe, $chatPath, $runtimePath, $projectDir, (Join-Path $runtimePath "launcher-broker.$LaunchId.stdout.log"), (Join-Path $runtimePath "launcher-broker.$LaunchId.stderr.log"))
    $result = @{ ok = $true; processId = $processId; jobIndependent = $true }
} catch {
    # Launch() only terminates its own unsafe suspended child. Existing services,
    # runtime locks and recovery evidence are never changed by this helper.
    $result = @{ ok = $false; error = $_.Exception.Message }
}
$resultTemp = $resultPath + '.tmp'
[System.IO.File]::WriteAllText($resultTemp, ($result | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::Move($resultTemp, $resultPath)
if (-not $result.ok) { exit 1 }
