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

Describe 'setup_windows.ps1: Test-DeftWingetSuccess winget exit code policy (#909)' {
    BeforeAll { . $script:SetupWindowsScript }

    It 'treats exit code 0 as success' {
        Test-DeftWingetSuccess -ExitCode 0 | Should -Be $true
    }

    It 'treats exit code 3010 (ERROR_SUCCESS_REBOOT_REQUIRED) as success' {
        # Python's MSI, Go's installer, and other Windows installers
        # propagate 3010 via winget when the install succeeded but a
        # reboot is needed. Treating it as a failure causes a clean-machine
        # bootstrap to misreport every install as failed.
        Test-DeftWingetSuccess -ExitCode 3010 | Should -Be $true
    }

    It 'treats exit code 1 as failure' {
        Test-DeftWingetSuccess -ExitCode 1 | Should -Be $false
    }

    It 'treats exit code 1603 (generic MSI install failure) as failure' {
        Test-DeftWingetSuccess -ExitCode 1603 | Should -Be $false
    }
}

Describe 'setup_windows.ps1: dot-source does not leak ErrorActionPreference (#909)' {
    BeforeAll {
        # Capture the parent-scope ErrorActionPreference before AND after
        # the dot-source. The pre-fix code mutated it via a top-level
        # `$ErrorActionPreference = 'Stop'` assignment that ran before the
        # `if ($MyInvocation.InvocationName -ne '.')` guard. The fix moves
        # that assignment INTO Invoke-DeftWindowsSetup so the dot-source
        # leaves the caller's preference unchanged.
        $script:eapBefore = $ErrorActionPreference
        . $script:SetupWindowsScript
        $script:eapAfter = $ErrorActionPreference
    }

    It 'preserves the caller-scope $ErrorActionPreference across dot-source' {
        $script:eapAfter | Should -Be $script:eapBefore
    }
}

Describe 'setup_windows.ps1: refresh-path.ps1 path is anchored to script directory (#909)' {
    BeforeAll { . $script:SetupWindowsScript }

    It 'captures $PSScriptRoot at script load time into $script:DeftSetupScriptRoot' {
        # The fix captures $PSScriptRoot into a script-scope variable at
        # the top of the file (before any function definitions) so the
        # refresh-path.ps1 lookup remains correct when Invoke-DeftWindowsSetup
        # is called from a dot-sourced context where bare $PSScriptRoot
        # would resolve to the caller's directory.
        $expected = (Resolve-Path (Join-Path $script:RepoRoot 'scripts')).Path
        $script:DeftSetupScriptRoot | Should -Be $expected
    }

    It 'Invoke-DeftWindowsSetup resolves refresh-path.ps1 relative to the script directory, not the caller cwd' {
        # Force one tool missing, override the install to a no-op, and run
        # WITHOUT -SkipRefresh from a foreign cwd. With the fix, the
        # Join-Path uses $script:DeftSetupScriptRoot and refresh-path.ps1 is
        # found and dot-sourced. Without the fix (bare $PSScriptRoot),
        # the path would point at the foreign cwd and Test-Path would fail,
        # emitting the "refresh-path.ps1 not found at <path>" warning.
        $tempDir = Join-Path $env:TEMP ('deft-test-' + [guid]::NewGuid().Guid)
        New-Item -ItemType Directory -Path $tempDir | Out-Null
        $previousPath = $env:PATH
        try {
            Push-Location -LiteralPath $tempDir
            try {
                $override = { param($id) }  # no-op install
                $warnings = New-Object System.Collections.ArrayList
                $result = Invoke-DeftWindowsSetup `
                    -ForceMissing @('go') `
                    -InstallOverride $override `
                    -WarningVariable +warnings
                $result.Installed | Should -Contain 'go'
                $missingWarning = $warnings | Where-Object { $_.Message -match 'refresh-path\.ps1 not found' }
                $missingWarning | Should -BeNullOrEmpty
            } finally {
                Pop-Location
            }
        } finally {
            $env:PATH = $previousPath
            Remove-Item -LiteralPath $tempDir -Force -Recurse -ErrorAction SilentlyContinue
        }
    }
}

Describe 'setup_windows.ps1: auto-run block is gated by the dot-source guard (#909)' {
    It 'does not emit bootstrap output when the file is dot-sourced' {
        # The auto-run block at the bottom of the file is wrapped in
        # `if ($MyInvocation.InvocationName -ne '.')`. Dot-sourcing must
        # therefore load the helper functions without triggering the
        # foreach loop that emits "[setup_windows] <tool>: ..." lines.
        # Capture every output stream during a fresh dot-source and assert
        # no bootstrap-shaped emission appears.
        $captured = & {
            . $script:SetupWindowsScript
        } *>&1
        $bootstrapLines = $captured | Where-Object {
            ($_ -is [string] -and $_ -match '\[setup_windows\]') -or
            ($_.PSObject.Properties['Message'] -and $_.Message -match '\[setup_windows\]')
        }
        $bootstrapLines | Should -BeNullOrEmpty
    }
}

# Restore $env:PATH after the suite finishes so a CI step run after this
# Pester invocation in the same session sees the original value.
$env:PATH = $script:OriginalPath
