# Cross-Platform Design: Agent-Driven Skills

**Date**: 2026-03-11
**Context**: todo.md item #1 — Land agent-driven skills (deft-setup + deft-build)
**Reference**: PR #18 (`skills/deft-setup/SKILL.md`, `skills/deft-build/SKILL.md`, `skills/install.sh`)

## Problem

PR #18's installer and skill wiring assume a Unix environment. Deft needs to work on Windows, macOS, and Linux — especially since the primary maintainer develops on Windows.

## Analysis

### Skills (SKILL.md) — No Issue

The skill files are pure markdown. Agents read and interpret them identically on every OS.

### Installer (`install.sh`) — Unix Only

PR #18 ships `curl | sh` with a POSIX shell script. This doesn't work on Windows:
- No `/usr/bin/env sh` (unless WSL/Git Bash)
- No `ln -s`
- No POSIX `mkdir -p` semantics in cmd/pwsh

**Options**:
- Ship `install.sh` + `install.ps1` side by side
- Use a Python installer (Python is already a dependency via `run.bat`)
- Lean into `git clone` as the real install step; only the symlink wiring is OS-specific

### Symlinks for Skill Discovery — Admin Required on Windows

The installer uses `ln -s` to link skills into `.agents/skills/` and `.claude/skills/`.

- **macOS/Linux**: Symlinks work without elevation.
- **Windows**: Symlinks require Developer Mode or admin privileges. Alternatives:
  - **Directory junctions** (`mklink /J`) — no admin, but same-volume only
  - **Copy** — simple but drifts on update
  - **No symlinks** — agents pointed to `deft/skills/` directly via AGENTS.md reference

### Config Paths — `~/.config/` Is Not a Windows Convention

Skills reference `~/.config/deft/USER.md`:
- **macOS/Linux**: XDG-standard, clean.
- **Windows**: Convention is `$env:APPDATA` (e.g. `C:\Users\{user}\AppData\Roaming\deft\`).
- The `$DEFT_USER_PATH` env var override already exists in the skill but the default needs a per-OS fallback.

### Taskfile Commands — Bash Syntax

`deft-build` runs `task check`, `task test:coverage`, etc. Several Taskfile tasks use bash syntax (`tar`, `find`, `ln -sf`, `if [ -w ... ]`).

- Works on macOS/Linux natively.
- Works on Windows only if Git Bash / sh is on PATH (Taskfile shells out to `sh`).
- The `run.bat` entry point is already Windows-aware; Taskfile hasn't caught up.

## Decisions

### 1. Installer: Python with Platform Wrappers (Revised 2026-03-11)

**Decision**: Single `install.py` with thin `install.bat` (Windows) and `install` (Unix) wrappers.

**Supersedes**: Original dual-script approach (`install.sh` + `install.ps1`).

**Reasoning**:
- Python is already a hard dependency — `run.bat` enforces Python 3.13+ and redirects to Microsoft Store if missing. No new dependency introduced.
- Single codebase: `pathlib` handles path separators, `os.symlink()` / `os.makedirs()` / `shutil.copytree()` work cross-platform. No maintaining parallel shell scripts.
- Any shell: `python install.py` works identically from cmd, PowerShell, bash, zsh, fish.
- Extensible: future needs (version checks, self-update, migration, `--doctor`) slot in naturally. Shell scripts get painful; Python stays readable.
- Mirrors existing pattern: `run.bat` + `run` already delegate to Python. `install.bat` + `install` follow the same convention.

**Repo root adds three files**:
- `install.py` — all logic (detect OS, validate prereqs, wire skill discovery, set up config paths)
- `install.bat` — Windows wrapper (~10 lines, mirrors `run.bat`: check Python, delegate)
- `install` — Unix wrapper (~10 lines, mirrors `run`: `#!/usr/bin/env sh` → `python3 install.py`)

**Install UX**:
```
# Windows (cmd or PowerShell)
git clone https://github.com/visionik/deft && deft\install

# Unix
git clone https://github.com/visionik/deft && deft/install
```

**install.py responsibilities**:
1. Detect OS (`platform.system()`)
2. Validate prerequisites (Python version, git, deft directory structure)
3. Wire skill discovery via AGENTS.md (see decision #2)
4. Ensure USER.md config directory exists (Unix: `~/.config/deft/`, Windows: `%APPDATA%\deft/`, or `$DEFT_USER_PATH`)
5. Print next steps

**Future upside**: This positions for `pip install deft-directive` / `pipx install deft-directive` later — install.py logic becomes a post-install hook or `deft install` CLI command.

### 2. Skill Discovery: AGENTS.md Only — No Symlinks (Revised 2026-03-11)

**Decision**: Use AGENTS.md references as the sole skill discovery mechanism. Do not create symlinks, junctions, or copies.

**Supersedes**: Original approach of symlinks (Unix) / junctions (Windows) with AGENTS.md as fallback.

**Reasoning**:
- AGENTS.md already needs to exist. Deft's README instructs users to add `See deft/main.md` to AGENTS.md as the entry point. Adding two skill references is two more lines in a file that's already required.
- Symlinks solve a problem AGENTS.md already solves. Both achieve the same outcome: the agent finds and reads the SKILL.md. Symlinks add OS-specific complexity (Windows elevation, Developer Mode, junction same-volume constraint) for no additional capability.
- Zero platform-specific code. AGENTS.md is a text file. No `os.symlink()`, no `mklink /J` fallback chains, no elevation detection. The installer gets simpler and the failure modes disappear.
- Debuggable. A user can open AGENTS.md and see exactly how their agent finds deft skills. Symlinks are invisible and confusing when broken.
- Most agent platforms read AGENTS.md. Claude Code, Codex, Warp, OpenCode — all read project-root instruction files. The `.agents/skills/` directory convention is newer and less universal.

**If a future agent platform requires `.agents/skills/`**: Add symlink support then as an optional flag (`install.py --link-skills`). Don't build it preemptively.

### 3. Config Path: Platform-Aware Default with Env Var Override (Revised 2026-03-11)

**Decision**: Skills instruct agents to detect the OS and use platform-idiomatic defaults. `$DEFT_USER_PATH` overrides both.

**Defaults**:
- **Unix** (macOS/Linux): `~/.config/deft/USER.md`
- **Windows**: `%APPDATA%\deft\USER.md` (e.g. `C:\Users\{user}\AppData\Roaming\deft\USER.md`)

**Override**: `$DEFT_USER_PATH` takes precedence on any platform if set.

**Reasoning**:
- `~/.config/` follows the XDG Base Directory Specification — the established convention on Unix systems.
- `%APPDATA%` is the Windows-idiomatic location for per-user application config. Using `~/.config/` on Windows works but feels foreign and hides files in a dot-directory that Windows Explorer doesn't show by default.
- Agent-driven detection is trivial: `platform.system()` in install.py, or the agent reads the OS from its environment context. No user action required.
- The `$DEFT_USER_PATH` env var (already defined in the deft-setup skill) provides an escape hatch for non-standard setups (e.g. shared config on a network drive, WSL interop, CI environments).
- install.py creates the config directory during setup so agents and the CLI can assume it exists.

**Implementation note**: The SKILL.md files should include a brief platform detection instruction so agents resolve the correct default path without hardcoding either convention.

### 4. Taskfile: Hard Dependency with Guided Install (Revised 2026-03-11)

**Decision**: Taskfile is a hard dependency. `install.py` checks for `task` on PATH; if missing, tells the user it's required and asks permission to install it. If the user declines, installation stops.

**Supersedes**: Original "defer" approach where skills would fall back to direct commands.

**Reasoning**:
- Taskfile.yml exists and the entire project assumes it: `deft-build` runs `task check` and `task test:coverage` as quality gates, the README documents `task` commands, and the Taskfile defines the canonical workflows.
- Making it optional means maintaining two paths (Taskfile and direct commands) for every quality gate. That's complexity with no clear upside — it undermines the convention-over-configuration contract.
- Taskfile installs easily on all platforms: `go install`, `brew`, `choco`, `scoop`, or standalone binary. The installer can automate this per-OS.

**Install flow**:
1. `install.py` checks `shutil.which("task")`
2. If missing: inform user Taskfile is required, show what the install command will do
3. If user grants permission: run the appropriate install command for the detected OS
4. If user declines: stop installation cleanly — do not proceed with a partially functional setup

**Separate concern — Taskfile.yml cross-platform fixes**:
- Several tasks (`install`, `build`, `stats`) use bash syntax (`tar`, `find`, `ln -sf`, `if [ -w ... ]`)
- These need fixing to work on Windows (use `platforms:` guards in Taskfile v3, or rewrite with cross-platform commands)
- This is implementation work, not a design decision — tracked separately

## Key Insight

Since this is agent-driven, the agent detects the OS and adapts. A brief "platform detection" section in the SKILL.md is simpler and more robust than making a single installer work everywhere.

---

*Captured from design discussion — msadams + Oz — 2026-03-11*
