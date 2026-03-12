# Go Installer — Implementation Plan

**Date**: 2026-03-12
**Design**: `history/plan-2026-03-12-single-entry-installer.md`
**Goal**: Replace Python-based install wrappers with a single self-contained Go binary
that bootstraps deft on any platform with no prerequisites.

---

## Overview

A single Go source file (`cmd/deft-install/main.go`) compiles to five release binaries.
End users download the binary for their platform, run it, and are guided through the full
install — no git, Python, or technical knowledge required. Go handles everything.

**Files removed in this work:** `install.py`, `install.bat`, `install` (Unix wrapper)

**Files added:** `cmd/deft-install/main.go`, `cmd/deft-install/main_test.go`,
`.github/workflows/release.yml`

**Release artifacts:**
```
install-windows-amd64.exe   — Windows x64 (Intel/AMD)
install-windows-arm64.exe   — Windows ARM64 (Surface, Snapdragon X, Copilot+ PCs)
install-macos-universal     — macOS (Intel + Apple Silicon, universal binary)
install-linux-amd64         — Linux x64
install-linux-arm64         — Linux ARM64 (Raspberry Pi 4/5, AWS Graviton, ARM cloud)
```

---

## Phase 1 — Go Module and Skeleton (No Dependencies)

Establish the Go module and source file structure before any real logic is written.

### 1.1 Initialise Go module

- Create `go.mod` at repo root: `module github.com/visionik/deft`
- Go version: 1.22+ (for range-over-int and improved cross-compile support)
- No external dependencies — stdlib only

### 1.2 Create `cmd/deft-install/main.go` skeleton

- `package main` with `func main()` that prints a placeholder welcome banner and exits
- `runtime.GOOS` / `runtime.GOARCH` detection logged to confirm build target at startup
  (debug mode only, gated behind `--debug` flag)
- Confirms the file compiles cleanly: `go build ./cmd/deft-install/`

### 1.3 Create `cmd/deft-install/main_test.go` skeleton

- One passing smoke test: `TestMain_Compiles`
- Confirms test runner works: `go test ./cmd/deft-install/`

---

## Phase 2 — Directory Positioning Wizard (No Git Required)

The interactive flow that guides the user to choose where deft will be installed.
All UX assumes a novice user — numbered menus, sensible defaults, no path typing required.
Every menu includes an Exit option; exit always asks for confirmation before quitting.

### 2.1 Welcome screen and project name prompt

- Print banner: "Welcome to Deft! / AI coding standards, installed in seconds."
- Ask: "What is the name of your project?"
- Validate: reject empty input (re-prompt with gentle message)
- Sanitise: strip characters invalid in directory names, show user the sanitised result

### 2.2 Drive selection (Windows only)

- Enumerate fixed drives using `golang.org/x/sys/windows` or `os.Open` + Windows API
- Display each drive with label (if available) and free space in GB
- Numbered list with Exit option; default to drive with most free space
- macOS/Linux: skip this step, start from `os.UserHomeDir()`

### 2.3 Parent folder selection

- List immediate subdirectories of chosen drive root (Windows) or home dir (macOS/Linux)
- Exclude hidden folders (names starting with `.`) and system folders
- Options: numbered list of existing folders + "Create a new folder here" + Exit
- If "Create new folder": prompt for name, offer sanitised project name as default
  (user presses Enter to accept)

### 2.4 Confirmation screen

- Display full resolved paths before touching anything:
  ```
  Ready to install!
    Project folder : E:\Repos\my-project\
    Deft location  : E:\Repos\my-project\deft\
  The project folder will be created if it doesn't already exist.
  Continue? [Y/n]:
  ```
- Only proceed on explicit Y/Enter; n or c returns to Step 2.3

### 2.5 Guards

- `deft/` already exists at target — explain, offer repair/re-run, never overwrite
- No write permission — plain-language explanation, suggest running as admin, re-prompt
- Drive not ready — detect and re-prompt with clear message
- Empty project name — gentle re-prompt
- Invalid path characters — sanitise automatically, show result before continuing

### 2.6 Tests for directory wizard

- Project name sanitisation (special chars, empty string, unicode)
- Drive enumeration returns non-empty list on current platform
- Folder listing excludes hidden and system dirs
- Guard: existing `deft/` detected correctly
- Guard: write permission check

---

## Phase 3 — Git Detection and Installation (Depends on Phase 1)

Check for git and install it using only platform-native mechanisms if missing.

### 3.1 Git detection

- `exec.LookPath("git")` — found → proceed to Phase 4
- Not found → print friendly message, proceed to install flow

### 3.2 Windows git install

- Attempt 1: `winget install --id Git.Git -e --source winget` (Windows 11 + updated 10)
- Attempt 2 (fallback): download git-for-windows installer `.exe` from
  `https://github.com/git-for-windows/git/releases/latest` via `net/http`,
  save to temp dir, run with `/SILENT /NORESTART` flags
- After install: re-run `exec.LookPath("git")` to confirm success
- If all attempts fail: print direct download link and exit with clear instructions

### 3.3 macOS git install

- Run `git --version` — on a fresh Mac this triggers the Xcode CLT system dialog
- Print: "A system dialog may appear asking you to install developer tools — please approve it."
- Wait for user to confirm the dialog was shown, then re-check
- If CLT install not available (edge case): print Homebrew fallback instructions and exit

### 3.4 Linux git install

- Detect package manager in priority order: `apt-get`, `dnf`, `pacman`, `zypper`
- Run: `sudo <pm> install -y git`
- If no supported package manager found: print manual instructions and exit
- After install: re-check `exec.LookPath("git")` to confirm

### 3.5 Tests for git detection

- `exec.LookPath` mock: found returns true, not found returns false
- Windows: winget path attempted first, fallback triggered when winget absent
- Linux: package manager detection order tested with mocked `LookPath`
- Post-install re-check path tested

---

## Phase 4 — Clone and Setup (Depends on Phases 2 and 3)

With directory confirmed and git available, clone deft and wire it in.

### 4.1 Clone deft

- `git clone https://github.com/visionik/deft <target>/deft`
- Run via `exec.Command("git", "clone", repoURL, targetPath)`
- Stream stdout/stderr to terminal so user sees progress
- On failure: print error, suggest checking internet connection, exit cleanly

### 4.2 Write AGENTS.md entries

- Check if `AGENTS.md` exists in the project folder
  - If yes: check if deft entry already present (idempotent)
  - If no: create file
- Append entries:
  ```
  See deft/main.md
  Skills: deft/skills/deft-setup/SKILL.md, deft/skills/deft-build/SKILL.md
  ```

### 4.3 Create USER.md config directory

- Resolve platform-appropriate path:
  - Windows: `%APPDATA%\deft\`
  - macOS/Linux: `~/.config/deft/`
  - Override: `DEFT_USER_PATH` env var if set
- Create directory (including parents) if it does not exist
- Do not overwrite if `USER.md` already exists — print a note and continue

### 4.4 Print next steps

```
✓ Deft installed successfully!

  Location : E:\Repos\my-project\deft\
  AGENTS.md: updated
  User config: C:\Users\you\AppData\Roaming\deft\

Next steps:
  1. Open your AI coding assistant in E:\Repos\my-project\
  2. The agent will read deft/main.md automatically via AGENTS.md
  3. On first session, the deft-setup skill will create your USER.md preferences
```

### 4.5 Tests for clone and setup

- Clone: `exec.Command` call constructed correctly for all platforms
- AGENTS.md: create new, append to existing, idempotent (no duplicate entries)
- USER.md dir: Windows path, Unix path, env override
- Next steps printed without error

---

## Phase 5 — Remove Legacy Install Files (Depends on Phase 4 passing tests)

Clean out the Python-based install chain now that Go covers everything.

### 5.1 Delete legacy files

- Remove `install.py`
- Remove `install.bat`
- Remove `install` (Unix wrapper shell script)

### 5.2 Update `Taskfile.yml` install task

- Replace `install` task body with:
  - Unix: `go run ./cmd/deft-install/` (dev convenience)
  - Windows: `go run ./cmd/deft-install/` (same)
- Add note in task `desc` that end users should use the compiled binary

### 5.3 Update tests

- Remove or xfail any tests in `tests/cli/test_install.py` that tested the deleted files
- Confirm full test suite still passes: `uv run pytest tests/ -q`

---

## Phase 6 — GitHub Actions Release Workflow (Depends on Phase 4)

Automate building and releasing all five binaries on version tag push.

### 6.1 Create `.github/workflows/release.yml`

Trigger: `push` to tags matching `v*.*.*`

Build matrix — 6 targets:
```
windows/amd64   → install-windows-amd64.exe
windows/arm64   → install-windows-arm64.exe
darwin/amd64    → install-macos-amd64      (intermediate, not released)
darwin/arm64    → install-macos-arm64      (intermediate, not released)
linux/amd64     → install-linux-amd64
linux/arm64     → install-linux-arm64
```

Post-build step: `lipo -create -output install-macos-universal
install-macos-amd64 install-macos-arm64` — runs on `macos-latest` runner.

### 6.2 Upload release assets

- Create GitHub Release from the tag
- Attach all five final binaries as release assets
- Release body: auto-generated from tag annotation or `CHANGELOG` section

### 6.3 Smoke test in workflow

- Each binary: run with `--version` flag and confirm exit code 0
- macOS universal: verify `lipo -info` reports both architectures

---

## Phase 7 — README and Documentation Updates (Depends on Phase 6)

### 7.1 Update README Getting Started section

- Replace current install instructions with platform-specific download links
- Point to GitHub Releases page for binary downloads
- Include SmartScreen/Gatekeeper workaround note (Future Work: code signing)
- Windows: "Download `install-windows-amd64.exe` (or `arm64` for Surface/Copilot+ PCs)"
- macOS: "Download `install-macos-universal` — works on all Macs"
- Linux: "Download `install-linux-amd64` (or `arm64` for Raspberry Pi)"

### 7.2 Add `go.md` reference to README if needed

- Note that Go is required for building (dev only, not for end users)

### 7.3 Update `todo.md`

- Mark single entry point installer complete
- Note code signing as open Future Work item

---

## Phase 8 — Archive This Plan (Final Phase)

When all phases above are complete and the work is committed:

1. Rename this file with a timestamp and move it to `history/`:
   ```
   history/plan-YYYY-MM-DD-go-installer-impl.md
   ```
   Use the actual completion date, not the plan creation date.

2. Confirm `history/plan-2026-03-12-single-entry-installer.md` (the design doc)
   remains in place — it is the design rationale, this file is the implementation record.

3. Commit:
   ```
   chore: archive Go installer implementation plan
   - Move IMPLEMENTATION.md → history/plan-YYYY-MM-DD-go-installer-impl.md
   ```

---

## Dependency Order

```
Phase 1 (module + skeleton)
  └── Phase 2 (directory wizard)
  └── Phase 3 (git detection)
        └── Phase 4 (clone + setup)  ← needs Phase 2 + Phase 3
              └── Phase 5 (remove legacy files)
              └── Phase 6 (release workflow)
                    └── Phase 7 (docs)
                          └── Phase 8 (archive plan)
```

Phases 2 and 3 can proceed in parallel after Phase 1.
Phase 4 requires both Phase 2 and Phase 3 to be complete.
Phases 5 and 6 can proceed in parallel after Phase 4.
Phase 7 follows Phase 6. Phase 8 is always last.

---

## Workflow Rules

- **No auto-commit.** Stop and wait for explicit commit instruction.
- **No auto-push.** Commit locally, then STOP. Push only on explicit instruction.

*Created 2026-03-12 — Go installer implementation plan (beta branch)*
