# setup_windows.ps1 -- idempotent winget bootstrap for the deft Windows
# maintainer toolchain (Go, Python 3.12+, uv, Task, GitHub CLI).
#
# Probes each tool via Get-Command first; only invokes `winget install` when
# the tool is missing. After installs, dot-sources scripts/refresh-path.ps1 so
# the running session sees the newly-installed binaries without requiring a
# fresh shell.
#
# Usage:
#   pwsh -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
#   # or, via the parent Taskfile alias:
#   task setup:toolchain
#
# Tests: tests/scripts/test_setup_windows.ps1
# Companion: scripts/refresh-path.ps1
# Issue: #902
#
# ASCII-only by policy (AGENTS.md PowerShell rule). Do not introduce em
# dashes, smart quotes, arrows, or other non-ASCII glyphs in this file.

[CmdletBinding()]
param(
    # When set, the script only reports what it would do without invoking
    # winget. Useful for dry-run validation in tests and CI.
    [switch] $WhatIfOnly,

    # Test seam: list of probe names to treat as missing regardless of the
    # actual host PATH. Lets the regression suite exercise the
    # "winget install" branch without mutating the host.
    [string[]] $ForceMissing = @(),

    # Test seam: scriptblock invoked instead of winget for each missing tool.
    # The block is invoked with the canonical winget package id as its single
    # argument. When unset, the script invokes `winget install` directly.
    [scriptblock] $InstallOverride,

    # Test seam: when set, skips the post-install dot-source of
    # refresh-path.ps1. Tests use this to keep $env:PATH stable.
    [switch] $SkipRefresh
)

$ErrorActionPreference = 'Stop'

# Tool registry. Each entry maps a probe command (the binary name resolved
# via Get-Command) to its canonical winget package id. The id list is the
# acceptance criterion in #902 plus the GitHub.cli sibling.
$DeftWindowsTools = @(
    [pscustomobject]@{ Name = 'go';     Probe = 'go';     WingetId = 'GoLang.Go' },
    [pscustomobject]@{ Name = 'python'; Probe = 'python'; WingetId = 'Python.Python.3.12' },
    [pscustomobject]@{ Name = 'uv';     Probe = 'uv';     WingetId = 'astral-sh.uv' },
    [pscustomobject]@{ Name = 'task';   Probe = 'task';   WingetId = 'Task.Task' },
    [pscustomobject]@{ Name = 'gh';     Probe = 'gh';     WingetId = 'GitHub.cli' }
)

function Test-DeftToolPresent {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [string] $Probe,

        [string[]] $ForceMissing = @()
    )
    if ($ForceMissing -contains $Probe) { return $false }
    $cmd = Get-Command -Name $Probe -ErrorAction SilentlyContinue
    return ($null -ne $cmd)
}

function Invoke-DeftWingetInstall {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $WingetId
    )
    $wingetArgs = @(
        'install',
        '--id', $WingetId,
        '-e',
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements'
    )
    & winget @wingetArgs
    if ($LASTEXITCODE -ne 0) {
        throw ("winget install --id {0} exited with code {1}" -f $WingetId, $LASTEXITCODE)
    }
}

function Invoke-DeftWindowsSetup {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [switch] $WhatIfOnly,
        [string[]] $ForceMissing = @(),
        [scriptblock] $InstallOverride,
        [switch] $SkipRefresh
    )

    $installed = New-Object System.Collections.ArrayList
    $alreadyPresent = New-Object System.Collections.ArrayList
    $failed = New-Object System.Collections.ArrayList

    foreach ($tool in $DeftWindowsTools) {
        $present = Test-DeftToolPresent -Probe $tool.Probe -ForceMissing $ForceMissing
        if ($present) {
            [void]$alreadyPresent.Add($tool.Name)
            Write-Host ("[setup_windows] {0}: present (skip)" -f $tool.Name)
            continue
        }

        Write-Host ("[setup_windows] {0}: missing -- installing {1}" -f $tool.Name, $tool.WingetId)
        if ($WhatIfOnly) {
            [void]$installed.Add($tool.Name)
            continue
        }

        try {
            if ($null -ne $InstallOverride) {
                & $InstallOverride $tool.WingetId
            } else {
                Invoke-DeftWingetInstall -WingetId $tool.WingetId
            }
            [void]$installed.Add($tool.Name)
        } catch {
            Write-Warning ("[setup_windows] failed to install {0}: {1}" -f $tool.Name, $_)
            [void]$failed.Add($tool.Name)
        }
    }

    if (-not $SkipRefresh -and -not $WhatIfOnly -and $installed.Count -gt 0) {
        $refreshScript = Join-Path $PSScriptRoot 'refresh-path.ps1'
        if (Test-Path -LiteralPath $refreshScript) {
            . $refreshScript
        } else {
            Write-Warning ("[setup_windows] refresh-path.ps1 not found at {0}" -f $refreshScript)
        }
    }

    $installedStr = if ($installed.Count -gt 0) { $installed -join ', ' } else { 'none' }
    $presentStr = if ($alreadyPresent.Count -gt 0) { $alreadyPresent -join ', ' } else { 'none' }
    Write-Host ("[setup_windows] Installed: {0}. Already present: {1}." -f $installedStr, $presentStr)
    if ($failed.Count -gt 0) {
        Write-Warning ("[setup_windows] Failed: {0}" -f ($failed -join ', '))
    }

    return [pscustomobject]@{
        Installed      = @($installed)
        AlreadyPresent = @($alreadyPresent)
        Failed         = @($failed)
    }
}

# Run the bootstrap unless the script was dot-sourced (the test suite dot-
# sources to access the helper functions without triggering the main flow).
if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-DeftWindowsSetup `
        -WhatIfOnly:$WhatIfOnly `
        -ForceMissing $ForceMissing `
        -InstallOverride $InstallOverride `
        -SkipRefresh:$SkipRefresh
    if ($result.Failed.Count -gt 0) {
        exit 1
    }
}
