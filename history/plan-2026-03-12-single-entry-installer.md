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

## Chosen Direction: Go Binary for All Platforms

A single Go source file (`cmd/deft-install/main.go`) that detects the platform at runtime
and makes all decisions internally. One file to read, one file to maintain, one build
pipeline to understand.

The **end user needs nothing installed** — no Go, no Python, no runtime. The Go compiler
produces a fully self-contained native binary. Typical size: 5–10 MB.

### Release artifacts (built by GitHub Actions on version tag)

```
install-windows-amd64.exe   ← Windows x64 (Intel/AMD) — most Windows PCs
install-windows-arm64.exe   ← Windows ARM64 — Surface, Snapdragon X Elite/Plus,
                               Copilot+ PCs (Dell, HP, Lenovo, Samsung, ASUS)
install-macos-universal     ← macOS universal binary (Intel + Apple Silicon)
                               covers M1/M2/M3/M4 and all Intel Macs in one file
install-linux-amd64         ← Linux x64 (Ubuntu, Fedora, Debian, most desktops/servers)
install-linux-arm64         ← Linux ARM64 (Raspberry Pi 4/5, AWS Graviton,
                               Google Cloud T2A, Azure Ampere, ARM cloud VMs)
```

**6 build targets → 5 downloadable files.** The macOS universal binary is produced
by cross-compiling both `darwin/amd64` and `darwin/arm64` then merging with `lipo` 
in the Actions workflow — standard macOS practice, one download for all Mac users.

All five binaries share one source file. Platform differences are handled with Go's
`runtime.GOOS`/`runtime.GOARCH` and build-tag-free `if` statements — no separate files
per platform.

### Developer vs end-user requirements

- **End user**: needs nothing. Downloads the binary for their platform, runs it.
- **Developer (repo maintainer)**: needs Go installed to build locally.
  GitHub Actions handles release builds automatically on version tag push.
- The Go code is ~400–500 lines — a small, focused program.

---

## Install Flow — Decision: Go does everything, `install.py` removed

Python is not required at install time. `install.py`, `install.bat`, and `install`
(Unix wrapper) are **removed from the repo** — they are superseded entirely.

The Go binary runs this sequence on every platform:

```
  → Welcome + project name prompt
  → Drive selection (Windows) / home directory (macOS/Linux)
  → Parent directory selection or creation
  → Confirm install path
  → Check for git — install if missing (platform-appropriate method)
  → git clone https://github.com/visionik/deft <target>/deft
  → Write AGENTS.md entries
  → Create USER.md config directory
  → Print next steps
```

Python becomes a **dev dependency only** — needed when running `task check`/`task test`,
which is expected for developers working inside the repo.

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

**Design principle: assume every user is a novice on every platform.**
No file path knowledge assumed. No jargon. Every step offers a numbered choice
or a sensible default. The user never has to type a full path. 
Always present an Exit option so they can quit but always confirm exit selection before quitting

### Step 1 — Welcome and project name

```
──────────────────────────────────────────────────
  Welcome to Deft!
  AI coding standards, installed in seconds.
──────────────────────────────────────────────────

What is the name of your project?
(This will be used to name the project folder.)
> _
```

The answer drives the suggested folder name in later steps.

### Step 2 — Pick a drive (Windows only)

Enumerate available fixed drives with free space. Removable/network drives
are listed separately so the user knows what they are.

```
Which drive should the project live on?

  1) C:\  — System drive      (120 GB free)
  2) D:\  — Data drive        (450 GB free)
  3) E:\  — (800 GB free)
  4) Exit

Enter a number [default: 1]:
> _
```

macOS and Linux skip this step — they start from the user's home directory.

### Step 3 — Pick or create a parent folder

List immediate subdirectories of the chosen drive root (Windows) or home
directory (macOS/Linux). Keep the list short — directories only, hidden
folders excluded.

```
Where should the project folder go?

  1) E:\Repos
  2) E:\Projects
  3) E:\Work
  4) Create a new folder here
  5) Exit

Enter a number [default: 1]:
> _
```

If "Create a new folder": offer a sanitised version of the project name as
the default — user just presses Enter to accept:

```
New folder name [default: my-project]:
> _
```

### Step 4 — Confirm everything before touching the filesystem

```
Ready to install!

  Project folder : E:\Repos\my-project\
  Deft location  : E:\Repos\my-project\deft\

The project folder will be created if it doesn't already exist.

Continue/Cancel? [Y/n/c]:
> _
```

### Guards (apply on all platforms)

- `deft/` already exists at target — offer repair / re-run, never overwrite silently
- No write permission — explain in plain language, suggest running as admin, re-prompt
- Drive not ready (ejected, network unavailable) — detect and re-prompt with clear message
- Project name has invalid path characters — sanitise automatically, show the result
- Empty project name — prompt again with a gentle message

---

## File Layout After This Work

**Files removed:**
```
install.py      ← deleted (superseded by Go binary)
install.bat     ← deleted (superseded by Go binary)
install         ← deleted (superseded by Go binary)
```

**Files added:**
```
cmd/deft-install/main.go        ← single Go source file, all platforms
.github/workflows/release.yml   ← builds all four binaries on version tag push
```

**GitHub Release assets (not in repo, distributed via Releases page):**
```
install-windows-amd64.exe       ← Windows x64 (Intel/AMD)
install-windows-arm64.exe       ← Windows ARM64 (Surface, Snapdragon X, Copilot+ PCs)
install-macos-universal         ← macOS universal (Intel + Apple Silicon)
install-linux-amd64             ← Linux x64
install-linux-arm64             ← Linux ARM64 (Raspberry Pi 4/5, AWS Graviton, ARM cloud)
```

---

## Engineering Investment

- Write `cmd/deft-install/main.go` (~400–500 lines): single file, all platform logic inside
- GitHub Actions release workflow: cross-compile all six targets on version tag push,
  run `lipo` to produce macOS universal binary, attach five files to GitHub Release
- Update README: replace install instructions with platform-specific download links
- Go tests: `cmd/deft-install/main_test.go` covering directory logic, git detection,
  name sanitisation, guard conditions

---

## Future Work

### Code signing
Windows SmartScreen warns on unsigned `.exe` files downloaded from the internet.
macOS Gatekeeper quarantines unsigned executables too (shell scripts are exempt,
but Go binaries are not). Proper signing requires:
- **Windows**: code signing certificate (EV cert via DigiCert/Sectigo or GitHub's
  attestation via `sigstore`), integrated into the Actions release workflow
- **macOS**: Apple Developer ID cert + `codesign` + `notarytool` in Actions

This is deferred — for the initial release, README should advise users how to
proceed past the OS warning (Windows: "More info" → "Run anyway"; macOS:
System Settings → Privacy & Security → Open Anyway).

---

*Created 2026-03-12 — Single entry point installer planning*
*Updated 2026-03-12 — Full discussion captured; Go binary direction chosen*
*Updated 2026-03-12 — Decision: Go does everything; install.py removed; all platforms Go*
*Updated 2026-03-12 — Single source file; Raspberry Pi support; novice-first UX; signing as future work*
