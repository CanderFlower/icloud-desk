<#
.SYNOPSIS
  Builds and runs the native shell (iCloudDesk.exe) against the dev checkout.

.DESCRIPTION
  The Debug build has no icd.exe next to it, so the shell falls back to
  .venv\Scripts\python.exe icd.py (found by walking up from the exe).

.EXAMPLE
  scripts\dev-shell.ps1            # demo data, DevTools enabled
  scripts\dev-shell.ps1 -Live      # real account
  scripts\dev-shell.ps1 -NoBuild
#>
[CmdletBinding()]
param(
    [switch]$Live,
    [switch]$NoBuild,
    [switch]$NoDevTools
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Project = Join-Path $Root 'shell\iCloudDesk.csproj'
$Exe = Join-Path $Root 'shell\bin\Debug\net8.0-windows\iCloudDesk.exe'

if (-not (Test-Path -LiteralPath (Join-Path $Root '.venv\Scripts\python.exe'))) {
    Write-Warning 'No .venv found; the shell will fall back to python.exe on PATH.'
}

if (-not $NoBuild) {
    # A running dev shell locks its own output; ask it to quit first.
    if (Test-Path -LiteralPath $Exe) { Start-Process -FilePath $Exe -ArgumentList '--quit' -Wait }
    & dotnet build $Project -c Debug -nologo -v minimal
    if ($LASTEXITCODE -ne 0) { throw "dotnet build failed ($LASTEXITCODE)" }
}

$shellArgs = @()
if (-not $Live) { $shellArgs += '--demo' }
if (-not $NoDevTools) { $shellArgs += '--debug' }
Write-Host "Starting $Exe $($shellArgs -join ' ')"
if ($shellArgs.Count -gt 0) {
    Start-Process -FilePath $Exe -ArgumentList $shellArgs -WorkingDirectory $Root
} else {
    Start-Process -FilePath $Exe -WorkingDirectory $Root
}
