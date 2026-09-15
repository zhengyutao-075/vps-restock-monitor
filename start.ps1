# start.ps1 - launch the VPS restock monitor in a hidden background window.
# ASCII-only source: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $root 'monitor.mjs'
$pidFile = Join-Path $root 'state\monitor.pid'

if (-not (Test-Path $entry)) { throw "monitor.mjs not found at $entry" }

$node = (Get-Command node -ErrorAction Stop).Source

# Single-instance check by PID FILE, never by matching command-line text:
# the parent/wrapper process command line can also contain "monitor.mjs",
# which produced a false "already running" before.
if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -Raw).Trim()
  if ($oldPid -match '^\d+$') {
    $p = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') {
      Write-Output ("already running (pid " + $oldPid + ") - nothing to do")
      exit 0
    }
  }
  Write-Output 'stale pid file removed'
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 4

if (Test-Path $pidFile) {
  $newPid = (Get-Content $pidFile -Raw).Trim()
  Write-Output ("started (pid " + $newPid + ")")
  Write-Output ("log: " + (Join-Path $root 'logs\monitor.log'))
} else {
  Write-Output 'failed to start - check logs\monitor.log'
}
