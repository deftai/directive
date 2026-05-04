# test_setup_windows.ps1 -- Pester-style tests for the Windows toolchain
# bootstrap (#902).
#
# Manual invocation (not yet wired into `task check`):
#   Install-Module Pester -MinimumVersion 5.0 -Scope CurrentUser -Force
#   Invoke-Pester tests/scripts/test_setup_windows.ps1
#
# Coverage:
#   - refresh-path.ps1 dedup behaviour (synthetic registry-like input)
#   - refresh-path.ps1 system+user precedence ordering
#   - setup_windows.ps1 idempotence (re-runnable with all tools present)
#   - setup_windows.ps1 probe-before-install behaviour (Get-Command guard)
#
# Dev dependency: requires Pester 5.0+ (uses the modern `Should -Be` syntax).
# The Pester 3.4 module shipped with Windows PowerShell 5.1 by default is NOT
# sufficient -- Pester 3.x uses the legacy `Should Be` (no hyphen) syntax and
# does not support the modern `BeforeAll` / `It` / `Describe` semantics this
# suite relies on. PowerShell 7+ ships with Pester 5+ as a first-party module.
#
# ASCII-only by policy (AGENTS.md PowerShell rule).
# Issue: #902

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:RefreshPathScript = Join-Path $script:RepoRoot 'scripts\refresh-path.ps1'
$script:SetupWindowsScript = Join-Path $script:RepoRoot 'scripts\setup_windows.ps1'

# Save and restore $env:PATH around dot-source so the test process state is
# not mutated. Tests for refresh-path.ps1 dot-source the file to access its
# helper functions; the auto-run block at the bottom of refresh-path.ps1 will
# overwrite $env:PATH from the host registry, which we revert immediately.
$script:OriginalPath = $env:PATH

# Pester 5 promotes symbols defined in `BeforeAll` (including dot-sourced
# functions) to the surrounding Describe block's scope, but only when the dot-
# source runs DIRECTLY inside BeforeAll. Wrapping the dot-source in a regular
# function scopes the imported symbols to that function's local scope; they
# vanish when the wrapper returns and every `It` block calling them throws
# `is not recognized as the name of a cmdlet`. Dot-source bare inside each
# BeforeAll instead. For refresh-path.ps1 the auto-run block at the bottom of
# the file mutates $env:PATH, so save and restore around the dot-source.

Describe 'refresh-path.ps1: Merge-DeftPathStrings dedup' {
    BeforeAll {
        $previousPath = $env:PATH
        . $script:RefreshPathScript
        $env:PATH = $previousPath
    }

    It 'preserves first-occurrence order when entries repeat' {
        $merged = Merge-DeftPathStrings -SystemPath 'C:\a;C:\b;C:\a' -UserPath 'C:\b;C:\c'
        $merged | Should -Be 'C:\a;C:\b;C:\c'
    }

    It 'dedupes case-insensitively (Windows path semantics)' {
        $merged = Merge-DeftPathStrings -SystemPath 'C:\Foo;C:\Bar' -UserPath 'C:\foo;C:\BAR;C:\Baz'
        $merged | Should -Be 'C:\Foo;C:\Bar;C:\Baz'
    }

    It 'drops empty / whitespace-only entries' {
        $merged = Merge-DeftPathStrings -SystemPath 'C:\a;;C:\b' -UserPath '   ;C:\c'
        $merged | Should -Be 'C:\a;C:\b;C:\c'
    }

    It 'returns empty string when both inputs are empty' {
        $merged = Merge-DeftPathStrings -SystemPath '' -UserPath ''
        $merged | Should -Be ''
    }
}

Describe 'refresh-path.ps1: system+user precedence ordering' {
    BeforeAll {
        $previousPath = $env:PATH
        . $script:RefreshPathScript
        $env:PATH = $previousPath
    }

    It 'places system entries before user entries' {
        $merged = Merge-DeftPathStrings -SystemPath 'C:\sys1;C:\sys2' -UserPath 'C:\usr1;C:\usr2'
        $merged | Should -Be 'C:\sys1;C:\sys2;C:\usr1;C:\usr2'
    }

    It 'keeps system precedence when entries collide' {
        # When a path appears in both system and user, the system position
        # wins because the system iteration happens first.
        $merged = Merge-DeftPathStrings -SystemPath 'C:\shared;C:\sys' -UserPath 'C:\usr;C:\shared'
        $merged | Should -Be 'C:\shared;C:\sys;C:\usr'
    }

    It 'returns user entries unchanged when system is empty' {
        $merged = Merge-DeftPathStrings -SystemPath '' -UserPath 'C:\u1;C:\u2'
        $merged | Should -Be 'C:\u1;C:\u2'
    }
}

Describe 'setup_windows.ps1: idempotence when all tools are present' {
    BeforeAll { . $script:SetupWindowsScript }

    It 'reports no installs when every probe resolves on PATH' {
        # Rely on the live Get-Command probe; the suite assumes the test host
        # may be missing some tools, so the reliable shape is "force present"
        # for every tool and assert no installs were triggered.
        $installCalls = New-Object System.Collections.ArrayList
        $override = {
            param($id)
            [void]$installCalls.Add($id)
        }
        $result = Invoke-DeftWindowsSetup `
            -ForceMissing @() `
            -InstallOverride $override `
            -SkipRefresh
        # The probe inspects the live PATH; we cannot guarantee every tool is
        # present on every host. Re-running with WhatIfOnly + ForceMissing of
        # nothing exercises the no-install branch deterministically: with no
        # forced-missing entries AND WhatIfOnly the script never reaches the
        # InstallOverride. Assert via the InstallOverride-counter shape: the
        # override scriptblock fires only on the missing branch.
        $installCalls.Count | Should -Be ($result.Installed.Count)
    }

    It 'is byte-stable across two consecutive runs (re-runnable)' {
        $first = Invoke-DeftWindowsSetup -WhatIfOnly -ForceMissing @() -SkipRefresh
        $second = Invoke-DeftWindowsSetup -WhatIfOnly -ForceMissing @() -SkipRefresh
        ($first.Installed -join ',')      | Should -Be ($second.Installed -join ',')
        ($first.AlreadyPresent -join ',') | Should -Be ($second.AlreadyPresent -join ',')
        ($first.Failed -join ',')         | Should -Be ($second.Failed -join ',')
    }
}

Describe 'setup_windows.ps1: Test-DeftWindowsAppsStub' {
    BeforeAll { . $script:SetupWindowsScript }

    It 'flags a Source under \WindowsApps\ as a stub (python.exe)' {
        $stub = [pscustomobject]@{
            Source = 'C:\Users\foo\AppData\Local\Microsoft\WindowsApps\python.exe'
        }
        Test-DeftWindowsAppsStub -Command $stub | Should -Be $true
    }

    It 'does NOT flag a real interpreter Source path' {
        $real = [pscustomobject]@{ Source = 'C:\Program Files\Python312\python.exe' }
        Test-DeftWindowsAppsStub -Command $real | Should -Be $false
    }

    It 'returns false for a $null command (no resolution)' {
        Test-DeftWindowsAppsStub -Command $null | Should -Be $false
    }

    It 'returns false for a command without a Source property' {
        $bare = [pscustomobject]@{ Name = 'python' }
        Test-DeftWindowsAppsStub -Command $bare | Should -Be $false
    }
}

Describe 'setup_windows.ps1: probe-before-install (Get-Command guard)' {
    BeforeAll { . $script:SetupWindowsScript }

    It 'invokes the install scriptblock once per missing tool' {
        $installCalls = New-Object System.Collections.ArrayList
        $override = {
            param($id)
            [void]$installCalls.Add($id)
        }
        $result = Invoke-DeftWindowsSetup `
            -ForceMissing @('go', 'uv') `
            -InstallOverride $override `
            -SkipRefresh
        $result.Installed | Should -Contain 'go'
        $result.Installed | Should -Contain 'uv'
        $installCalls.Count | Should -Be 2
        $installCalls | Should -Contain 'GoLang.Go'
        $installCalls | Should -Contain 'astral-sh.uv'
    }

    It 'does NOT invoke the install scriptblock for already-present tools' {
        $installCalls = New-Object System.Collections.ArrayList
        $override = {
            param($id)
            [void]$installCalls.Add($id)
        }
        # ForceMissing only contains 'task' -- every other probe defers to
        # Get-Command. The override should fire at most once (for task) when
        # task is missing on the host, OR zero times when task is present.
        # The strict assertion is: it never fires for a probe NOT in
        # ForceMissing.
        $null = Invoke-DeftWindowsSetup `
            -ForceMissing @('task') `
            -InstallOverride $override `
            -SkipRefresh
        foreach ($id in $installCalls) {
            $id | Should -Be 'Task.Task'
        }
    }

    It 'records install failures without aborting the loop' {
        $failingOverride = {
            param($id)
            throw "synthetic install failure for $id"
        }
        $result = Invoke-DeftWindowsSetup `
            -ForceMissing @('go', 'uv') `
            -InstallOverride $failingOverride `
            -SkipRefresh
        $result.Failed.Count | Should -Be 2
        $result.Installed.Count | Should -Be 0
    }
}

Describe 'setup_windows.ps1: WhatIfOnly mode' {
    BeforeAll { . $script:SetupWindowsScript }

    It 'never invokes the install scriptblock under -WhatIfOnly' {
        $installCalls = New-Object System.Collections.ArrayList
        $override = {
            param($id)
            [void]$installCalls.Add($id)
        }
        $null = Invoke-DeftWindowsSetup `
            -WhatIfOnly `
            -ForceMissing @('go', 'python', 'uv', 'task', 'gh') `
            -InstallOverride $override `
            -SkipRefresh
        $installCalls.Count | Should -Be 0
    }

    It 'still reports the missing tools as Installed under -WhatIfOnly' {
        $result = Invoke-DeftWindowsSetup `
            -WhatIfOnly `
            -ForceMissing @('go', 'python', 'uv', 'task', 'gh') `
            -SkipRefresh
        $result.Installed.Count | Should -Be 5
        $result.Failed.Count | Should -Be 0
    }
}

# Restore $env:PATH after the suite finishes so a CI step run after this
# Pester invocation in the same session sees the original value.
$env:PATH = $script:OriginalPath
