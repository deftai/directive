# Single Entry Point Installer — Planning

**Date**: 2026-03-12
**Context**: Simplify the install UX — replace the current two-wrapper model with a single
bootstrap entry point that works on Windows (cmd/PowerShell), macOS, and Linux.

**Supersedes**: `plan-2026-03-12-cross-platform-agent-skills-impl.md` (Phases 1–5 complete)

---

## Problem Statement

The current install flow requires:
1. A working `git` to clone deft (chicken-and-egg if git is missing)
2. Two wrapper scripts (`install.bat` for Windows, `install` for Unix)
3. The user to know which to run based on their OS

The goal is a **single downloadable file** that handles the full bootstrap:
- Confirms the user is positioned in the right directory (project root)
- Helps the user navigate if not
- Checks for `git` and assists with installation if missing
- Clones deft into `./deft/`
- Runs the existing setup (AGENTS.md wiring, USER.md dir creation)

---

## Options Under Consideration

### Option A — `install.py` as universal self-bootstrapper (preferred)

Extend the existing `install.py` to:
- Detect standalone mode (not yet inside a deft clone) vs. in-repo mode
- When standalone: handle git check/install → clone → setup
- When in-repo: run setup only (current behaviour)

Download and run:
```sh
# Unix
curl -sSL https://raw.githubusercontent.com/visionik/deft/beta/install.py | python3

# Windows (PowerShell)
python (Invoke-WebRequest https://.../install.py).Content
# or: download via browser, then: python install.py
```

**Pros**: Single file, pure Python, already half-built, no extension ambiguity,
works identically from CMD and PowerShell since `.py` is registered with both.
**Cons**: Requires Python pre-installed.

### Option B — PowerShell `.ps1` universal entry

Use PowerShell 5.1 (built into Windows 10/11) as the entry; `pwsh` for macOS/Linux.

```powershell
irm https://deft.md/install.ps1 | iex        # Windows
curl -sSL https://deft.md/install.ps1 | pwsh -  # macOS/Linux
```

**Pros**: Native Windows, zero extra installs, `irm | iex` is the established Windows convention.
**Cons**: macOS/Linux users need `pwsh` installed — not a safe assumption.

### Option C — Two-script model (incremental improvement)

Keep `install.bat` + `install` but make both smarter:
add cwd check, git check/install, clone step. Python core unchanged.

**Pros**: Low risk, minimal change.
**Cons**: Still two files — user still needs to know which to run.

### Option D — Hosted one-liner at deft.md/install

Single URL, platform-aware response, industry-standard pattern (Homebrew, Rustup).

**Pros**: Best UX at point of discovery.
**Cons**: Requires hosting infrastructure; still two scripts behind the URL.

---

## Key Design Decisions (to resolve)

1. **Single file or thin wrapper + core?**
   - If Option A: `install.py` grows to ~200 lines but stays pure Python
   - If Options B/D: separate bootstrap + Python core pattern

2. **What happens when git is missing?**
   - Windows: `winget install Git.Git` / `choco install git` / `scoop install git` / link to git-scm.com
   - macOS: `brew install git` / Xcode CLT prompt (`xcode-select --install`)
   - Linux: `apt install git` / `dnf install git` / distro-detect

3. **Directory positioning UX**
   - Check `cwd` is not already inside a deft clone (prevent double-install)
   - Offer `ls`/`dir` output of current dir to orient the user
   - Ask: "Install deft here? (./deft/ will be created)" — y/n
   - If no: prompt for a path, `cd` there, re-confirm

4. **In-repo vs standalone mode detection**
   - Standalone: `__file__` is not inside a `deft/` directory
   - In-repo: `__file__` is `deft/install.py` — skip clone step

5. **Windows cmd vs PowerShell**
   - `install.bat` with `%*` passthrough works in both cmd and PowerShell
   - No PowerShell required in current install chain — keep it that way
   - New standalone download: `python install.py` works from both shells

---

## Open Questions

- Should we keep `install.bat` + `install` as thin wrappers for in-repo use, and
  add a separate `install-bootstrap.py` for standalone use? Or merge into one file?
- Should standalone mode download be via raw GitHub URL or a custom deft.md/install URL?
- Python version requirement for bootstrap: 3.x (any) is safer than ≥3.13 for initial
  download step; bump to 3.13 check after clone succeeds and setup begins?

---

*Created 2026-03-12 — Single entry point installer planning*
