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

### 1. Installer: Dual Script

Ship `install.sh` (Unix) and `install.ps1` (Windows) side by side.
- README shows `curl | sh` for Unix, `irm | iex` for PowerShell.
- Both do the same thing: clone deft, wire up skill discovery.

### 2. Skill Discovery: Don't Depend on Symlinks Alone

Primary mechanism: symlinks (Unix) or junctions (Windows).
Fallback: AGENTS.md or equivalent config entry pointing agents at `deft/skills/` directly. This is zero-symlink and works everywhere.

### 3. Config Path: Platform-Aware Default

The skills instruct agents to detect the OS and use:
- **Unix**: `~/.config/deft/USER.md`
- **Windows**: `$env:APPDATA\deft\USER.md`

`$DEFT_USER_PATH` overrides both.

### 4. Taskfile: Defer

Skills don't require Taskfile to function. Agents can run `uv run pytest`, `uv run ruff check .` directly. Long-term, add `platforms:` conditionals in `Taskfile.yml` (v3 supports this).

## Key Insight

Since this is agent-driven, the agent detects the OS and adapts. A brief "platform detection" section in the SKILL.md is simpler and more robust than making a single installer work everywhere.

---

*Captured from design discussion — msadams + Oz — 2026-03-11*
