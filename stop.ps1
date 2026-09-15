# stop.ps1 - stop the VPS restock monitor using the pid file.
# ASCII-only source: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root 'state-local\monitor.pid'

if (-not (Test-Path $pidFile)) { Write-Output 'not running (no pid file)'; exit 0 }

$pidText = (Get-Content $pidFile -Raw).Trim()
if ($pidText -notmatch '^\d+$') { Remove-Item $pidFile -Force; Write-Output 'bad pid file removed'; exit 0 }

$p = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
if ($p -and $p.ProcessName -eq 'node') {
  Stop-Process -Id $p.Id -Force
  Write-Output ("stopped (pid " + $p.Id + ")")
} else {
  Write-Output 'process not running - cleaning up pid file'
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
