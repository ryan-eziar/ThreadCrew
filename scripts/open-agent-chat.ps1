# ThreadCrew desktop entry (Claude). The desktop shortcut runs this script.
# It shows a small "opening" window, calls Codex's launcher (the only thing that starts or reuses
# the broker), opens the verified URL on success, and explains failures in English.
# It never starts a broker itself, never deletes locks, and never calls a model.
param(
    [string]$RuntimeDir = '',
    [switch]$NoOpen,   # tests: don't open the browser
    [switch]$NoUi      # tests: print the outcome instead of showing windows
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'launch-agent-chat.ps1'
if (-not $RuntimeDir) { $RuntimeDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime' }

function Get-Advice([string]$detail) {
    if ($detail -match 'possible crash lock') {
        return 'The previous service did not shut down cleanly. History is protected; no new service was started. Copy the details for a bug report. Do not delete runtime files.'
    }
    if ($detail -match 'locked by a process') {
        return 'An existing service could not be verified; no second service was started. Copy the details for a bug report.'
    }
    if ($detail -match 'Another ThreadCrew launcher') {
        return 'Another launch is in progress. Wait a few seconds and try again.'
    }
    if ($detail -match 'has not passed authenticated readiness|did not finish within 90 seconds') {
        return 'Startup is taking longer than usual. Wait briefly and try again; the launcher reuses the same service.'
    }
    if ($detail -match 'Node') {
        return 'Node.js v24.14.1 is required. Install that version and ensure node is on PATH. Copy details for a bug report.'
    }
    if ($detail -match 'unrelated or unverified service') {
        return 'Another program is using the saved address. Copy the details for a bug report.'
    }
    return 'ThreadCrew could not start. Copy the details for a bug report.'
}

$splash = $null
if (-not $NoUi) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $splash = New-Object System.Windows.Forms.Form
    $splash.Text = 'ThreadCrew'
    $splash.FormBorderStyle = 'FixedDialog'
    $splash.ControlBox = $false
    $splash.StartPosition = 'CenterScreen'
    $splash.Size = New-Object System.Drawing.Size(440, 110)
    $splash.TopMost = $true
    $label = New-Object System.Windows.Forms.Label
    $label.Text = 'Opening ThreadCrew…'
    $label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
    $label.AutoSize = $false
    $label.Dock = 'Fill'
    $label.TextAlign = 'MiddleCenter'
    $splash.Controls.Add($label)
    $splash.Show()
    $splash.Refresh()
}

$ok = $false
$url = $null
$detail = ''
$outFile = [System.IO.Path]::GetTempFileName()
$errFile = [System.IO.Path]::GetTempFileName()
try {
    # The launcher starts a long-running broker, which inherits handles from whoever started the
    # launcher. So the launcher runs through ShellExecute (no handle inheritance, hidden window)
    # and writes its result to temp files; nothing here holds a pipe the broker could keep open.
    $q = { param($s) "'" + ($s -replace "'", "''") + "'" }
    $inner = "`$ErrorActionPreference = 'Stop'; try { & $(& $q $launcher) -RuntimeDir $(& $q $RuntimeDir) -NoOpen *> $(& $q $outFile); exit 0 } " +
             "catch { (`$_ | Out-String) | Out-File -LiteralPath $(& $q $errFile) -Encoding utf8; exit 1 }"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' +
        [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $proc = [System.Diagnostics.Process]::Start($psi)
    $finished = $proc.WaitForExit(90000)
    $text = ((Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue) + "`n" +
             (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)).Trim()
    if (-not $finished) {
        $detail = "Launcher did not finish within 90 seconds. $text"
    } elseif ($proc.ExitCode -eq 0) {
        $line = ($text -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
        $result = $line | ConvertFrom-Json
        if ($result.url -match '^http://127\.0\.0\.1:\d+/?$' -and ($result.status -eq 'started' -or $result.status -eq 'reused')) {
            $ok = $true
            $url = $result.url
            $detail = "$($result.status) $($result.url)"
        } else {
            $detail = "Unexpected launcher output: $text"
        }
    } else {
        $detail = $text
    }
} catch {
    $detail = $_.Exception.Message
} finally {
    if ($splash) { $splash.Close(); $splash.Dispose() }
    Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
}

if ($ok) {
    if (-not $NoOpen) { Start-Process -FilePath $url | Out-Null }
    if ($NoUi) { Write-Output "OK $detail" }
    exit 0
}

$advice = Get-Advice $detail
if ($NoUi) {
    Write-Output "FAILED $advice"
    Write-Output "DETAIL $detail"
    exit 1
}
$answer = [System.Windows.Forms.MessageBox]::Show(
    "$advice`n`nYes: copy details. No: close.",
    'ThreadCrew could not open',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning)
if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { Set-Clipboard -Value $detail }
exit 1
