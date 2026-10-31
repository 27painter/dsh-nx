<#
.SYNOPSIS
  Install what dsh-nx needs: a venv for the MCP sidecar, the pinned NX skill,
  and the skill junctions.

.DESCRIPTION
  Idempotent. Never touches the NX installation, never deletes a venv, and backs
  up nothing because it only creates.

.PARAMETER BaseDir
  Where the venv and the skill live. Default: D:\cad-agents

.PARAMETER Check
  Report only, change nothing. Exits 1 when something is missing.
#>
[CmdletBinding()]
param(
    [string]$BaseDir = "D:\cad-agents",
    [string]$SkillRef = "",
    [string]$Python = "",
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$PkgRoot = $PSScriptRoot

function Say([string]$Message) { Write-Host "==> $Message" }

$Upstream = Get-Content -LiteralPath (Join-Path $PkgRoot "lib\upstream.json") -Raw | ConvertFrom-Json
if (-not $SkillRef) { $SkillRef = $Upstream.nxopenJournal.commit }

$SkillsDir = Join-Path $BaseDir "dsh-skills"
$SkillDest = Join-Path $SkillsDir "nxopen-journal"
$VenvDir   = Join-Path $BaseDir "venv-nx"
$VenvPy    = Join-Path $VenvDir "Scripts\python.exe"
$DshSkills = Join-Path $env:USERPROFILE ".dsh\skills"
$CodexSkills = Join-Path $env:USERPROFILE ".codex\skills"

if (-not $Python) {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "python"
    )
    foreach ($candidate in $candidates) {
        if ($candidate -eq "python" -or (Test-Path -LiteralPath $candidate)) { $Python = $candidate; break }
    }
}

Say "[1/5] Python: $Python"
$version = & $Python -c "import sys; print('%d.%d' % sys.version_info[:2])"
if ([version]$version -lt [version]"3.11") { throw "Python 3.11+ required, found $version" }
Write-Host "    $version OK"

Say "[2/5] venv for the MCP sidecar: $VenvDir"
if (Test-Path -LiteralPath $VenvPy) {
    Write-Host "    already present, reusing"
} elseif ($Check) {
    Write-Host "    MISSING (run without -Check)"
} else {
    & $Python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "creating the venv failed" }
}

Say "[3/5] NX skill at $($SkillRef.Substring(0,12))"
if (Test-Path -LiteralPath (Join-Path $SkillDest "SKILL.md")) {
    Write-Host "    already present: $SkillDest"
} elseif ($Check) {
    Write-Host "    MISSING (run without -Check)"
} else {
    New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
    $zip = Join-Path $env:TEMP "nxopen-journal.zip"
    $extract = Join-Path $env:TEMP "nxopen-journal-extract"
    Invoke-WebRequest -Uri "https://codeload.github.com/EVOL233awa/nxopen-journal/zip/$SkillRef" -OutFile $zip -UseBasicParsing
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    $inner = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
    Move-Item -LiteralPath $inner.FullName -Destination $SkillDest
    Write-Host "    extracted to $SkillDest"
}

if (-not $Check -and (Test-Path -LiteralPath $VenvPy)) {
    Say "    installing mcp + pydantic into the venv (skipped when already importable)"
    & $VenvPy -c "import mcp, pydantic" 2>$null
    if ($LASTEXITCODE -ne 0) {
        & $VenvPy -m pip install --quiet --disable-pip-version-check "mcp>=2.2,<3" "pydantic>=2.12,<3"
        if ($LASTEXITCODE -ne 0) { throw "installing the sidecar dependencies failed" }
    }
}

Say "[4/5] NX_HOME"
# The skill's own runner defaults to a D:\UG-NX12 style path that does not
# exist on most machines. Without this the skill half cannot start NX at all.
$probeScript = Join-Path $PkgRoot "lib\probe.py"
$nxRoot = ""
if (Test-Path -LiteralPath $probeScript) {
    $probePython = if (Test-Path -LiteralPath $VenvPy) { $VenvPy } else { $Python }
    try {
        $probeJson = & $probePython $probeScript 2>$null | Select-Object -Last 1
        if ($probeJson) { $nxRoot = ($probeJson | ConvertFrom-Json).root }
    } catch { }
}
$current = [Environment]::GetEnvironmentVariable("NX_HOME", "User")
if ($current) {
    Write-Host "    already set: $current"
} elseif (-not $nxRoot) {
    Write-Host "    NX not found - set NX_HOME yourself before using the skill"
} elseif ($Check) {
    Write-Host "    MISSING (would set NX_HOME=$nxRoot)"
} else {
    [Environment]::SetEnvironmentVariable("NX_HOME", $nxRoot, "User")
    $env:NX_HOME = $nxRoot
    Write-Host "    set NX_HOME=$nxRoot for this user (the skill's runner needs it)"
}

Say "[5/5] Skill junctions"
foreach ($target in @($DshSkills, $CodexSkills)) {
    $link = Join-Path $target "nxopen-journal"
    if (Test-Path -LiteralPath $link) {
        Write-Host "    $link already exists"
        continue
    }
    if ($Check) {
        Write-Host "    MISSING: $link"
        continue
    }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    New-Item -ItemType Junction -Path $link -Target $SkillDest | Out-Null
    Write-Host "    linked $link"
}

Write-Host ""
if ($Check) {
    $missing = @()
    if (-not (Test-Path -LiteralPath $VenvPy)) { $missing += "venv-nx" }
    if (-not (Test-Path -LiteralPath (Join-Path $SkillDest "SKILL.md"))) { $missing += "skill" }
    if (-not [Environment]::GetEnvironmentVariable("NX_HOME", "User")) { $missing += "NX_HOME" }
    if ($missing.Count -gt 0) {
        Write-Host ("Missing: " + ($missing -join ", "))
        exit 1
    }
    Write-Host "Everything is in place."
    exit 0
}

Write-Host "=================================================="
Write-Host " dsh-nx install complete"
Write-Host "   venv      : $VenvPy"
Write-Host "   skill     : $SkillDest"
Write-Host "   state dir : $(Join-Path $BaseDir 'nx-state')"
Write-Host "   NX_HOME   : $([Environment]::GetEnvironmentVariable('NX_HOME', 'User'))"
Write-Host ""
Write-Host " Next: dsh-nx doctor, then dsh-nx serve (or let dsh start it)"
Write-Host " Reminder: the bridge runs a batch NX session; NX is busy while it is up."
Write-Host "=================================================="
