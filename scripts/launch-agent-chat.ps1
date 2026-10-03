param(
    [string]$RuntimeDir = '',
    [switch]$NoOpen,
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $RuntimeDir) { $RuntimeDir = Join-Path $projectDir 'runtime' }
if (-not $NodePath) {
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw 'Node.js 22.16+ (22.x) or 24.x is required. Install the latest Node.js 24 LTS, reopen the terminal, or pass -NodePath with the absolute path to node.exe.' }
    $NodePath = $nodeCommand.Source
}
$chatPath = Join-Path $projectDir 'chat.mjs'
$probePath = Join-Path $projectDir 'src\service-discovery.mjs'
$recoveryPath = Join-Path $projectDir 'src\runtime-recovery.mjs'
$nodeCheckPath = Join-Path $projectDir 'src\node-runtime.mjs'
$bootstrapPath = Join-Path $projectDir 'scripts\start-independent-broker.ps1'
$runtimePath = [System.IO.Path]::GetFullPath($RuntimeDir)

function Get-Discovery {
    $raw = & $script:nodeExe $script:probePath $script:runtimePath 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Broker identity probe failed: $raw" }
    try { return ($raw | Out-String | ConvertFrom-Json) }
    catch { throw 'Broker identity probe returned an invalid result.' }
}

function Quote-PowerShellLiteral([string]$value) {
    return "'" + $value.Replace("'", "''") + "'"
}

function Explain-UnsafeState($state) {
    $lockPath = Join-Path $script:runtimePath 'broker-state.lock'
    $owner = $null
    if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
        try { $owner = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json } catch {}
    }
    $pidText = if ($owner -and $owner.pid) { " PID $($owner.pid)." } else { '' }
    $ownerAlive = $false
    if ($owner -and $owner.pid) { $ownerAlive = $null -ne (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue) }
    if ($state.status -eq 'locked' -or $state.status -eq 'unsafe_lock') {
        if ($ownerAlive) {
            throw "Runtime is locked by a process$pidText The broker did not pass authenticated identity verification. Inspect that process and its command line, then restore the original service; no second writer was started. Lock: $lockPath"
        }
        throw "Runtime recovery could not confirm a safe restart$pidText Keep the lock and runtime files unchanged, including v2-state.sqlite and its WAL. Inspect the recovery reason and evidence before manual repair. Lock: $lockPath"
    }
    if ($state.status -eq 'identity_mismatch') {
        throw "Descriptor points to a port serving an unrelated or unverified service. Check the descriptor, port owner, and runtime path before recovery. No broker was started. Runtime: $script:runtimePath"
    }
    throw "Runtime identity is unsafe ($($state.status)): $($state.detail) Inspect descriptors, lock, and journal before recovery. No broker was started. Runtime: $script:runtimePath"
}

if (-not [System.IO.Path]::IsPathRooted($NodePath)) { throw '-NodePath must be an absolute path to node.exe.' }
$nodeExe = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).ProviderPath
if ([System.IO.Path]::GetFileName($nodeExe) -ne 'node.exe') { throw '-NodePath must name node.exe.' }
$nodeVersion = (& $nodeExe --version).Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not read the Node.js version at $nodeExe." }
$nodeCheckRaw = & $nodeExe --disable-warning=ExperimentalWarning $nodeCheckPath
$nodeCheckExit = $LASTEXITCODE
try { $nodeCheck = $nodeCheckRaw | ConvertFrom-Json } catch { throw "Could not verify Node.js $nodeVersion. Install the latest Node.js 24 LTS and reopen the terminal." }
if ($nodeCheckExit -ne 0 -or -not $nodeCheck.ok) { throw "Unsupported Node.js runtime ($nodeVersion). $($nodeCheck.message)" }

$canonicalRaw = & $nodeExe $recoveryPath canonical $runtimePath
if ($LASTEXITCODE -ne 0) { throw "Cannot resolve a safe local runtime: $canonicalRaw" }
$runtimePath = ($canonicalRaw | ConvertFrom-Json).runtimeDir
$normalized = $runtimePath.TrimEnd('\', '/').ToUpperInvariant()
$hash = [System.Security.Cryptography.SHA256]::Create()
try { $digest = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized)))).Replace('-', '').Substring(0, 32) }
finally { $hash.Dispose() }
$mutex = [System.Threading.Mutex]::new($false, "Local\AgentChatLauncher-$digest")
$held = $false
try {
    try { $held = $mutex.WaitOne(30000) }
    catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Another ThreadCrew launcher is still checking this runtime. Retry in a moment.' }

    $state = Get-Discovery
    if ($state.status -eq 'existing') {
        if (-not $NoOpen) { Start-Process -FilePath $state.url | Out-Null }
        [pscustomobject]@{ status = 'reused'; url = $state.url; instanceId = $state.instanceId; runtimeDir = $runtimePath; nodePath = $nodeExe } | ConvertTo-Json -Compress
        return
    }
    $recovery = $null
    if ($state.status -eq 'locked') {
        # The mutex covers backup, validation, recovery and startup. A normal
        # Windows shutdown can leave a lock even when the SQLite data is sound.
        $recoveryRaw = & $nodeExe --disable-warning=ExperimentalWarning $recoveryPath recover $runtimePath
        $recoveryExit = $LASTEXITCODE
        $recovery = $recoveryRaw | ConvertFrom-Json
        if ($recoveryExit -ne 0) {
            if ($recovery.code -eq 'OWNER_ALIVE') { Explain-UnsafeState $state }
            throw "Automatic recovery stopped ($($recovery.code)). Original lock and data retained. Evidence: $($recovery.evidence). Runtime: $runtimePath"
        }
        # Only this mutex-owning process may move the old lock. A child helper
        # left alive if this launcher exits can prepare a backup, but never
        # release a lock after another launcher has acquired the mutex.
        $oldLock = Join-Path $runtimePath 'broker-state.lock'
        $lockItem = Get-Item -LiteralPath $oldLock -ErrorAction Stop
        $ownerAlive = $null -ne (Get-Process -Id $recovery.ownerPid -ErrorAction SilentlyContinue)
        $lockHasher = [System.Security.Cryptography.SHA256]::Create()
        try { $lockDigest = ([BitConverter]::ToString($lockHasher.ComputeHash([System.IO.File]::ReadAllBytes($oldLock)))).Replace('-', '') }
        finally { $lockHasher.Dispose() }
        if ($recovery.status -ne 'verified' -or $ownerAlive -or
            ($lockItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $lockDigest -ne $recovery.lockSha256) {
            throw 'Recovery ownership changed after validation. Original lock retained; retry the launcher.'
        }
        Move-Item -LiteralPath $oldLock -Destination (Join-Path $recovery.evidence 'previous-broker-state.lock') -ErrorAction Stop
        $state = Get-Discovery
    }
    if ($state.status -ne 'startable') { Explain-UnsafeState $state }

    New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
    $logId = [guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $runtimePath "launcher-broker.$logId.stdout.log"
    $stderrPath = Join-Path $runtimePath "launcher-broker.$logId.stderr.log"
    $resultPath = Join-Path $runtimePath "launcher-broker.$logId.result.json"
    $shellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $command = '& ' + (Quote-PowerShellLiteral $bootstrapPath) + ' -NodePath ' + (Quote-PowerShellLiteral $nodeExe) + ' -RuntimeDir ' + (Quote-PowerShellLiteral $runtimePath) + ' -LaunchId ' + (Quote-PowerShellLiteral $logId)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    # Start-Process would inherit Codex's Job and can be killed during an app
    # update. WMI is a separate local creation source; explicitly break away
    # from its provider Job as well. No scheduled task or elevated service.
    $environment = [string[]](Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value })
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ CreateFlags = [uint32]16777216; ShowWindow = [uint16]0; EnvironmentVariables = $environment }
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"' + $shellPath + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded; CurrentDirectory = $projectDir; ProcessStartupInformation = $startup }
    if ($created.ReturnValue -ne 0) { throw "Independent broker startup failed (WMI code $($created.ReturnValue)). Runtime retained. Check the Windows Management Instrumentation service and retry." }
    $child = $null
    $launchResult = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        if (-not $launchResult -and (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
            $launchResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
            if (-not $launchResult.ok -or -not $launchResult.jobIndependent) { throw "Independent broker startup failed: $($launchResult.error) Runtime retained." }
            $child = Get-Process -Id $launchResult.processId -ErrorAction SilentlyContinue
            if (-not $child) { throw "Broker exited before authenticated readiness. Inspect $stderrPath and $stdoutPath. Runtime retained." }
        }
        $state = Get-Discovery
        if ($state.status -eq 'existing' -and $child) {
            if (-not $NoOpen) { Start-Process -FilePath $state.url | Out-Null }
            if ($recovery -and $state.workspaceId -ne $recovery.workspaceId) { throw 'Recovered broker workspace does not match the verified backup. Inspect the preserved recovery evidence.' }
            [pscustomobject]@{ status = 'started'; url = $state.url; instanceId = $state.instanceId; runtimeDir = $runtimePath; nodePath = $nodeExe; processId = $child.Id; jobIndependent = $true; recoveryEvidence = $recovery.evidence } | ConvertTo-Json -Compress
            return
        }
        if ($child) { $child.Refresh() }
        if ($child -and $child.HasExited) {
            throw "Broker process exited before authenticated readiness (exit $($child.ExitCode)). Inspect $stderrPath and $stdoutPath. Runtime lock and journal were left unchanged."
        }
        # Discovery can take long enough for the bootstrap to publish its result
        # and exit. Check for its exit first, then re-read the result's presence;
        # an earlier missing-file observation must not reject a successful start.
        if (-not $launchResult -and -not (Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $resultPath -PathType Leaf)) { throw "Independent bootstrap exited without a result. Inspect $resultPath and retry; runtime retained." }
        if ($state.status -notin @('startable', 'locked', 'existing')) { Explain-UnsafeState $state }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Broker has not passed authenticated readiness after 30 seconds. Inspect $resultPath, $stderrPath and rerun the launcher to reuse it. Do not start another writer or remove the lock."
}
finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
