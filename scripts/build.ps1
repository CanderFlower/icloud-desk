<#
.SYNOPSIS
  Builds the iCloud Desk installer: core (PyInstaller) -> shell (dotnet publish) -> stage -> Inno Setup.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build.ps1
  Produces dist\iCloudDesk-Setup-<version>.exe (version from app\__init__.py).

.PARAMETER SkipCore
  Reuse the existing build\pyi\dist\icd output.
.PARAMETER SkipShell
  Reuse the existing build\shell output.
.PARAMETER NoInstaller
  Stop after staging (build\stage contains the runnable app).
.PARAMETER Iscc
  Path to ISCC.exe (otherwise found via PATH / the usual Inno Setup 6 install locations).
#>
[CmdletBinding()]
param(
    [switch]$SkipCore,
    [switch]$SkipShell,
    [switch]$NoInstaller,
    [string]$Iscc
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Root = Split-Path -Parent $PSScriptRoot
$Build = Join-Path $Root 'build'
$PyiDist = Join-Path $Build 'pyi\dist'
$PyiWork = Join-Path $Build 'pyi\work'
$CoreOut = Join-Path $PyiDist 'icd'
$ShellOut = Join-Path $Build 'shell'
$Stage = Join-Path $Build 'stage'
$Dist = Join-Path $Root 'dist'
$Python = Join-Path $Root '.venv\Scripts\python.exe'

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

function Fail([string]$Text) {
    Write-Host "`nBUILD FAILED: $Text" -ForegroundColor Red
    exit 1
}

# Runs a native command, streaming its output; stderr is not treated as a PowerShell error.
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments, [string]$What)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $old
    }
    if ($code -ne 0) { Fail "$What failed (exit code $code)." }
}

function Get-DirSizeMB([string]$Path) {
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File | Measure-Object -Property Length -Sum).Sum
    return [math]::Round($sum / 1MB, 1)
}

# Processes started from build\ (a previous test run) lock the files we are about to replace.
function Stop-BuildProcesses {
    $prefix = $Build.TrimEnd('\') + '\'
    Get-Process -Name icd, iCloudDesk -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object {
            Write-Host "    stopping $($_.ProcessName) ($($_.Id)) from $($_.Path)"
            try { $_.Kill(); $_.WaitForExit(5000) | Out-Null } catch { }
        }
}

function Find-Iscc {
    if ($Iscc) {
        if (Test-Path -LiteralPath $Iscc) { return (Resolve-Path -LiteralPath $Iscc).Path }
        Fail "ISCC.exe not found at '$Iscc'."
    }
    if ($env:ISCC -and (Test-Path -LiteralPath $env:ISCC)) { return $env:ISCC }
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )
    foreach ($hive in 'HKCU', 'HKLM') {
        foreach ($view in 'Software', 'Software\WOW6432Node') {
            $key = "${hive}:\$view\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1"
            $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
            if ($props -and ($props.PSObject.Properties.Name -contains 'InstallLocation') -and $props.InstallLocation) {
                $candidates += (Join-Path $props.InstallLocation 'ISCC.exe')
            }
        }
    }
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    Fail ("Inno Setup 6 (ISCC.exe) not found. Install it with:`n" +
        '  winget install --id JRSoftware.InnoSetup -e --accept-source-agreements --accept-package-agreements')
}

# ---------------------------------------------------------------- version

$initPy = Get-Content -LiteralPath (Join-Path $Root 'app\__init__.py') -Raw
if ($initPy -notmatch '__version__\s*=\s*["'']([^"'']+)["'']') { Fail 'Could not read __version__ from app\__init__.py.' }
$Version = $Matches[1]
Write-Host "iCloud Desk $Version" -ForegroundColor Green
New-Item -ItemType Directory -Force -Path $Build | Out-Null
Stop-BuildProcesses

# ---------------------------------------------------------------- core (PyInstaller)

if (-not $SkipCore) {
    Write-Step 'Building core (icd.exe) with PyInstaller'
    if (-not (Test-Path -LiteralPath $Python)) {
        Fail "Python venv not found at $Python. Create it: py -3.13 -m venv .venv; .venv\Scripts\pip install -r requirements.txt -r requirements-build.txt"
    }
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $Python -c 'import PyInstaller' 2>$null | Out-Null
    $hasPyi = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $old
    if (-not $hasPyi) {
        Invoke-Native $Python @('-m', 'pip', 'install', '--disable-pip-version-check', '-q',
            '-r', (Join-Path $Root 'requirements.txt'), '-r', (Join-Path $Root 'requirements-build.txt')) 'pip install'
    }
    Invoke-Native $Python @('-m', 'PyInstaller', (Join-Path $Root 'icd.spec'), '--noconfirm', '--clean',
        '--log-level', 'WARN', '--distpath', $PyiDist, '--workpath', $PyiWork) 'PyInstaller'
}
$CoreExe = Join-Path $CoreOut 'icd.exe'
if (-not (Test-Path -LiteralPath $CoreExe)) { Fail "Core build output missing: $CoreExe" }
if (-not (Test-Path -LiteralPath (Join-Path $CoreOut '_internal\web\index.html'))) { Fail 'Core build is missing the web UI (_internal\web\index.html).' }
$coreVersion = (& $CoreExe --version 2>&1 | Out-String).Trim()
if ($coreVersion -ne "icd $Version") { Fail "icd.exe --version returned '$coreVersion', expected 'icd $Version'." }
Write-Host "    $coreVersion ($(Get-DirSizeMB $CoreOut) MB)"

# ---------------------------------------------------------------- shell (.NET)

if (-not $SkipShell) {
    Write-Step 'Publishing shell (iCloudDesk.exe)'
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { Fail 'dotnet SDK not found (need .NET 8 SDK or newer).' }
    if (Test-Path -LiteralPath $ShellOut) { Remove-Item -LiteralPath $ShellOut -Recurse -Force }
    Invoke-Native 'dotnet' @('publish', (Join-Path $Root 'shell\iCloudDesk.csproj'), '-c', 'Release', '-r', 'win-x64',
        "-p:Version=$Version", '-o', $ShellOut, '-nologo', '-v', 'minimal') 'dotnet publish'
}
$ShellExe = Join-Path $ShellOut 'iCloudDesk.exe'
if (-not (Test-Path -LiteralPath $ShellExe)) { Fail "Shell publish output missing: $ShellExe" }
$shellVersion = (Get-Item -LiteralPath $ShellExe).VersionInfo.ProductVersion
Write-Host "    iCloudDesk.exe $shellVersion ($([math]::Round((Get-Item -LiteralPath $ShellExe).Length / 1MB, 1)) MB)"

# ---------------------------------------------------------------- stage

Write-Step "Staging into $Stage"
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null
Copy-Item -Path (Join-Path $CoreOut '*') -Destination $Stage -Recurse
Copy-Item -LiteralPath $ShellExe -Destination $Stage
foreach ($f in 'icd.exe', 'iCloudDesk.exe', '_internal\web\index.html') {
    if (-not (Test-Path -LiteralPath (Join-Path $Stage $f))) { Fail "Staging is missing $f" }
}
Write-Host "    stage: $(Get-DirSizeMB $Stage) MB"

if ($NoInstaller) {
    Write-Host "`nDone (no installer). Run: $Stage\iCloudDesk.exe" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------- installer (Inno Setup)

Write-Step 'Compiling installer with Inno Setup'
$IsccExe = Find-Iscc
Write-Host "    $IsccExe"
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$Setup = Join-Path $Dist "iCloudDesk-Setup-$Version.exe"
if (Test-Path -LiteralPath $Setup) { Remove-Item -LiteralPath $Setup -Force }
Invoke-Native $IsccExe @('/Qp', "/DAppVersion=$Version", "/DStageDir=$Stage", "/DOutputDir=$Dist",
    (Join-Path $Root 'installer\iCloudDesk.iss')) 'ISCC'
if (-not (Test-Path -LiteralPath $Setup)) { Fail "Installer not produced: $Setup" }

$size = [math]::Round((Get-Item -LiteralPath $Setup).Length / 1MB, 1)
Write-Host "`nBuilt $Setup ($size MB)" -ForegroundColor Green
