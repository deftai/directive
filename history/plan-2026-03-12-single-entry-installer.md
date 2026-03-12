# Single Entry Point Installer — Planning

**Date**: 2026-03-12
**Status**: Planning / discussion — not yet approved for implementation
**Supersedes**: `plan-2026-03-12-cross-platform-agent-skills-impl.md` (Phases 1–5 complete)

---

## Problem to Solve

A user on a **virgin machine** (Windows, macOS, or Linux) with **no tools installed beyond
OS built-ins** should be able to download a single file, run it, and have deft fully
installed and wired into their project — with no prior knowledge of git, Python, or
command-line tooling required.

The installer must:
1. **Install git** if not present (using only built-in OS mechanisms)
2. **Position the user** in the correct directory (project root where `./deft/` will live)
3. **Pull deft from GitHub** — `git clone https://github.com/visionik/deft ./deft`
4. Wire deft into the project (`AGENTS.md`, USER.md config directory)

### Why the current model falls short

The current flow (`install.bat` → `python.exe install.py` on Windows, `install` → `python3
install.py` on Unix) has three problems:
- Requires git to already be installed (chicken-and-egg: need git to clone, need clone to run)
- Requires Python to already be installed
- Two separate wrapper files — user must know which to run
- `.bat` files are not the expected Windows download format (users expect `.exe` or `.msi`)

---

## What's Built Into Each Platform (zero-install baseline)

**Windows 10/11**
- `cmd.exe` — always present
- PowerShell 5.1 — always present (core system component)
- `curl.exe` — built in since Windows 10 1803+
- `winget` — built into Windows 11 and updated Windows 10 (21H1+)
- Python — NOT built in
- git — NOT built in

**macOS (modern)**
- `zsh`/`bash` + `curl` — always present
- `python3` / `git` — NOT truly built in; running either triggers an Xcode CLT install
  prompt that the user must approve (this is actually useful — it's the OS-native path)

**Linux**
- `bash`/`sh` + `curl` or `wget` — present on all mainstream distros
- `python3` — present on most distros (Ubuntu, Fedora, Debian) but not guaranteed on minimal
- `git` — often NOT pre-installed on minimal/server installs
- Package manager (`apt`, `dnf`, `pacman`) — always available, varies by distro

---

## Conclusion: No Single Universal File Exists

There is no single file that runs natively on all three platforms with zero installed tools.
This is a hard OS constraint:
- Windows natively executes `.exe`, `.bat`, `.ps1`, `.msi`
- macOS/Linux natively execute shell scripts
- Python requires Python; `.bat` is not a standard Windows download format

The industry consensus (Homebrew, Rustup, Volta, Bun, Scoop) is **two files,
one per platform family**, presented as a single-URL experience.

---

## Chosen Direction: Go Binary + Shell Script

### Windows — `install.exe` (compiled Go binary)

A Go program compiled to a self-contained `.exe`. The **end user needs nothing installed** —
no Go, no Python, no runtime. The Go compiler embeds everything. Typical size: 5–10 MB.

- User downloads `install.exe`, double-clicks or runs from cmd/PowerShell
- Binary checks for git → installs via `winget install Git.Git` if missing
  (falls back to direct download of git-for-windows installer via HTTP)
- Shows current directory, asks user to confirm install location
- Runs `git clone https://github.com/visionik/deft ./deft`
- Performs setup (AGENTS.md, USER.md directory)
- No Python required for installation

### macOS + Linux — `install.sh` (shell script)

A single `.sh` file works identically on both platforms. `bash`/`curl` are always present.

- macOS: user downloads, runs `bash install.sh` from Terminal
  - Gatekeeper does NOT block plain `.sh` files (only `.app` bundles and unsigned executables)
  - git check triggers Xcode CLT install prompt automatically — OS-native, no workaround needed
- Linux: `bash install.sh` or `curl -sSL url | bash`
  - git installed via detected package manager (`apt`, `dnf`, `pacman`)
- Both: show cwd, confirm location, `git clone`, setup

---

## Go Binary: Developer vs End-User Requirements

- **End user**: needs nothing. Downloads `install.exe`, runs it. Done.
- **Developer (repo maintainer)**: needs Go installed to build. GitHub Actions builds
  release binaries for all platforms automatically on each version tag.
- The Go code is ~300–400 lines — a small, focused program with no complex logic.

---

## What Happens to `install.py`?

Two options — decision pending:

**Option A — Go delegates to Python after clone:**
```
install.exe / install.sh
  → install git if missing
  → position user in correct directory
  → git clone ./deft
  → run: python3 deft/install.py   (AGENTS.md + USER.md setup)
```
Keeps Python as an install-time requirement. Simpler Go code.

**Option B — Go does everything, Python becomes dev-only (preferred):**
```
install.exe / install.sh
  → install git if missing
  → position user in correct directory
  → git clone ./deft
  → write AGENTS.md entries        (~20 lines of Go)
  → create USER.md config dir      (~5 lines of Go)
```
Python is no longer required to install deft. It becomes a dev dependency —
needed only when running `task check` / `task test`, which is expected.
Cleaner separation: installer does one job, Python is a dev tool.

---

## Git Install Strategy Per Platform

**Windows:**
1. `winget install Git.Git` — available on Windows 11 and updated Windows 10
2. Fallback: download git-for-windows `.exe` installer directly via HTTP, run silently

**macOS:**
- Run `git --version` → this automatically triggers the Xcode CLT install prompt
- User approves in the system dialog — no additional logic needed

**Linux:**
- Detect package manager in order: `apt-get`, `dnf`, `pacman`, `zypper`
- Run: `sudo <pm> install -y git`

---

## Directory Positioning UX

1. Show current working directory and its contents
2. Ask: *"Install deft here? A `./deft/` folder will be created. [Y/n]"*
3. If yes: proceed
4. If no: prompt for a target path, validate it exists and is writable, re-confirm
5. Guards:
   - Refuse if `./deft/` already exists (offer re-run / repair instead)
   - Refuse if no write permission to cwd

---

## File Layout After This Work

```
install.exe      ← Windows bootstrap (Go binary, self-contained, released via GitHub)
install.sh       ← macOS + Linux bootstrap (bash, built-in everywhere)
cmd/install/     ← Go source for the installer binary
install.bat      ← kept as in-repo convenience wrapper (existing clone → re-run setup)
install          ← kept as in-repo convenience wrapper (Unix)
install.py       ← kept for in-repo dev use; may be reduced in scope (Option B)
```

---

## Engineering Investment

- Write Go installer (~300–400 lines): new language in the repo
- GitHub Actions release workflow: build `install.exe`, `install-macos`, `install-linux`
  on version tag push; attach to GitHub Release as assets
- Update README download links to point to GitHub Releases
- Tests: Go has a standard testing package; can test directory logic, git detection, etc.

---

## Open Questions

- Option A or B? (delegate to `install.py` vs. Go does full setup)
- Should macOS and Linux ship as the same `install.sh` or separate binaries?
  (Shell script is simpler; Go binary for macOS would need universal binary for Intel + Apple Silicon)
- Should the GitHub release also include a `install-arm-linux` for Raspberry Pi / ARM servers?
- Signing: Windows SmartScreen warns on unsigned `.exe` from the internet.
  Is code signing (via GitHub Actions + a cert) in scope for this phase?

---

*Created 2026-03-12 — Single entry point installer planning*
*Updated 2026-03-12 — Full discussion captured, Go binary direction chosen*
