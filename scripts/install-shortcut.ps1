# Creates the "ThreadCrew" desktop shortcut (Claude). Run once; running again just updates it.
# Run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcut.ps1
# -Destination puts the shortcut in another folder (used for tests). The shortcut runs
# open-agent-chat.ps1, which calls Codex's launcher; nothing here starts a broker.
param(
    [string]$Destination = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Stop'
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = Join-Path $PSScriptRoot 'open-agent-chat.ps1'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "Missing $entry" }
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { throw "Destination folder not found: $Destination" }

# A simple generated icon: a rounded blue square with a speech mark. Stored next to the scripts.
$iconPath = Join-Path $PSScriptRoot 'agent-chat.ico'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 64, 64
$g = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 14
    $path.AddArc(2, 2, $r * 2, $r * 2, 180, 90)
    $path.AddArc(62 - $r * 2, 2, $r * 2, $r * 2, 270, 90)
    $path.AddArc(62 - $r * 2, 62 - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc(2, 62 - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(36, 87, 214))), $path)
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $g.FillEllipse($white, 14, 16, 36, 26)
    $g.FillPolygon($white, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 22, 38), (New-Object System.Drawing.Point 18, 50), (New-Object System.Drawing.Point 32, 40)))
    $dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(36, 87, 214))
    foreach ($x in 22, 30, 38) { $g.FillEllipse($dot, $x, 26, 5, 5) }
} finally { $g.Dispose() }
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [System.IO.File]::Create($iconPath)
try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose(); $bitmap.Dispose() }

$shortcutPath = Join-Path $Destination 'ThreadCrew.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcutPath)
$link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$entry`""
$link.WorkingDirectory = $projectDir
$link.IconLocation = "$iconPath,0"
$link.Description = 'ThreadCrew - you, Codex and Claude in one room'
$link.WindowStyle = 7  # minimized, so no console flashes up front
$link.Save()
Write-Output "Shortcut: $shortcutPath"
