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

## What Happens to `install.py`? — **Decision: Go does everything**

Go handles the full install. Python is not required to install deft — it becomes
a dev dependency needed only when running `task check` / `task test`.

```
install.exe / install.sh
  → guide user to correct project directory (see Directory UX below)
  → install git if missing
  → git clone https://github.com/visionik/deft ./deft
  → write AGENTS.md entries        (~20 lines of Go)
  → create USER.md config dir      (~5 lines of Go)
  → print next steps
```

`install.py` is retained in the repo for developers who want to re-run setup
from inside an existing clone, but it is no longer part of the end-user path.

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

The goal is to make this as easy as possible for a non-technical user.
The installer walks them through finding or creating the right location
step by step — no knowledge of file paths assumed.

### Step 1 — Ask what the project is

```
Welcome to Deft!

What is the name of the project you are setting up deft for?
> _
```

This gives the installer context for suggesting a directory name.

### Step 2 — Pick a drive (Windows only)

On Windows, enumerate available drives and present a numbered list:

```
Which drive would you like to use?
  1) C:\  (System, 120 GB free)
  2) D:\  (Data, 450 GB free)
  3) E:\  (Repos, 800 GB free)
> _
```

On macOS/Linux, skip this step — everything is under `/`.

### Step 3 — Pick or create a parent directory

List the top-level directories on the chosen drive (or home dir on Unix)
and offer to use one or create a new one:

```
Where should the project live? Existing folders on E:\:
  1) E:\Repos
  2) E:\Projects
  3) E:\Work
  4) Create a new folder
> _
```

If "Create a new folder": prompt for a name, suggest a sanitised version
of the project name from Step 1 as the default:

```
New folder name (default: my-project):
> _
```

### Step 4 — Confirm

```
Deft will be installed into:
  E:\Repos\my-project\deft\

The folder E:\Repos\my-project\ will be created if it doesn't exist.

Continue? [Y/n]
> _
```

### Guards

- `./deft/` already exists at target — offer repair/re-run instead of overwriting
- No write permission to chosen path — explain clearly and re-prompt
- Drive not ready (ejected, network unavailable) — detect and re-prompt
- Project name contains invalid path characters — sanitise automatically, show result

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

- Should macOS and Linux ship as the same `install.sh` or as Go binaries too?
  (Shell script is simpler to maintain; Go binary for macOS needs a universal binary
  for Intel + Apple Silicon, but gives identical UX to Windows)
- Should the GitHub release include `install-arm-linux` for Raspberry Pi / ARM servers?
- Signing: Windows SmartScreen warns on unsigned `.exe` downloads from the internet.
  Is code signing (via GitHub Actions + a cert) in scope for this phase?
- Should the directory UX on macOS/Linux also enumerate home subdirectories, or
  just ask for a path directly? (Unix users may be more comfortable with a path prompt)

---

*Created 2026-03-12 — Single entry point installer planning*
*Updated 2026-03-12 — Full discussion captured, Go binary direction chosen*
*Updated 2026-03-12 — Decision: Go does everything (Option B); enhanced directory UX*
