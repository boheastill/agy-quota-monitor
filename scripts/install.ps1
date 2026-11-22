<#
.SYNOPSIS
  Installs or updates `agy-quota-monitor` into Antigravity's global plugins directory
  (~/.gemini/config/plugins/agy-quota-monitor) on Windows.
  Copies in-place so updates succeed even while the Sidecar process holds the CWD handle.
#>
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $HOME '.gemini\config\plugins\agy-quota-monitor'

Write-Host "[agy-quota-monitor] Installing/updating plugin in $TargetDir ..." -ForegroundColor Cyan

New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $TargetDir 'assets') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $TargetDir 'sidecars\quota_board') -Force | Out-Null

Copy-Item -Path (Join-Path $RepoRoot 'plugin.json') -Destination $TargetDir -Force
Copy-Item -Path (Join-Path $RepoRoot 'README.md') -Destination $TargetDir -Force
Copy-Item -Path (Join-Path $RepoRoot 'assets\*') -Destination (Join-Path $TargetDir 'assets') -Recurse -Force
Copy-Item -Path (Join-Path $RepoRoot 'sidecars\quota_board\*') -Destination (Join-Path $TargetDir 'sidecars\quota_board') -Recurse -Force

Write-Host "[agy-quota-monitor] Installed successfully!" -ForegroundColor Green
Write-Host "  -> Open any conversation in Antigravity 2.0 and click '+' (top-right) -> 'Quota'."
