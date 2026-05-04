# refresh-path.ps1 -- merge system + user PATH from the Windows registry into
# the current PowerShell session.
#
# Registry-key contract (shared with #899's Go-side refreshPathFromRegistry()):
#   HKLM:\System\CurrentControlSet\Control\Session Manager\Environment\Path
#   HKCU:\Environment\Path
# Both this script and the Go installer's refresh primitive MUST read from the
# exact two keys above. Do NOT diverge -- any change here requires a matching
# change in cmd/deft-install/. See issue #899 for the cross-reference.
#
# Behavior:
#   1. Reads the system PATH (REG_EXPAND_SZ) from HKLM Session Manager
#      Environment, preserving the un-expanded form.
#   2. Reads the user PATH from HKCU Environment.
#   3. Concatenates system + user (system first), de-duplicates while
#      preserving first-occurrence order, sets $env:PATH in the running
#      session.
#
# Safety:
#   - Safe to dot-source: `. scripts\refresh-path.ps1`.
#   - Safe to run as a script: `pwsh -File scripts\refresh-path.ps1`.
#   - No `exit` calls -- a dot-sourced invocation cannot kill the parent shell.
#   - Compatible with Windows PowerShell 5.1 and PowerShell 7+.
#
# Tests: tests/scripts/test_setup_windows.ps1
# Issue: #902

# ASCII-only by policy (AGENTS.md PowerShell rule). Do not introduce em
# dashes, smart quotes, arrows, or other non-ASCII glyphs in this file.

function Get-DeftRegistryPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Machine', 'User')]
        [string] $Scope
    )
    try {
        if ($Scope -eq 'Machine') {
            $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(
                'System\CurrentControlSet\Control\Session Manager\Environment')
        } else {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
        }
        if ($null -eq $key) { return '' }
        try {
            $value = $key.GetValue(
                'Path',
                '',
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        } finally {
            $key.Close()
        }
        if ($null -eq $value) { return '' }
        return [string]$value
    } catch {
        Write-Warning ("refresh-path.ps1: failed to read {0} Path: {1}" -f $Scope, $_)
        return ''
    }
}

function Merge-DeftPathStrings {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [AllowEmptyString()]
        [AllowNull()]
        [string] $SystemPath = '',

        [AllowEmptyString()]
        [AllowNull()]
        [string] $UserPath = ''
    )
    $entries = New-Object System.Collections.ArrayList
    foreach ($source in @($SystemPath, $UserPath)) {
        if ([string]::IsNullOrEmpty($source)) { continue }
        foreach ($raw in $source.Split(';')) {
            $trimmed = $raw.Trim()
            if ([string]::IsNullOrEmpty($trimmed)) { continue }
            [void]$entries.Add($trimmed)
        }
    }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' (
        [System.StringComparer]::OrdinalIgnoreCase)
    $deduped = New-Object System.Collections.ArrayList
    foreach ($entry in $entries) {
        if ($seen.Add($entry)) { [void]$deduped.Add($entry) }
    }
    return ($deduped -join ';')
}

function Update-DeftSessionPath {
    [CmdletBinding()]
    param()
    $systemPath = Get-DeftRegistryPath -Scope 'Machine'
    $userPath = Get-DeftRegistryPath -Scope 'User'
    $merged = Merge-DeftPathStrings -SystemPath $systemPath -UserPath $userPath
    if (-not [string]::IsNullOrEmpty($merged)) {
        $env:PATH = $merged
    }
    return $merged
}

# Auto-run on dot-source AND on script invocation. The functions above remain
# importable for unit tests, which dot-source this file and then call
# Merge-DeftPathStrings with synthetic inputs.
$null = Update-DeftSessionPath
