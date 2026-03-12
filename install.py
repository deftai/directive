#!/usr/bin/env python3
"""
install.py — Deft framework installer

Cross-platform installer that validates prerequisites, wires skill discovery
via AGENTS.md, and creates the USER.md config directory.

Usage (after cloning deft into a project):
    # Windows
    deft\\install

    # Unix
    deft/install
"""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFT_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = DEFT_DIR.parent
DEFT_DIR_NAME = DEFT_DIR.name  # Usually "deft", but respects rename

REQUIRED_DEFT_DIRS = ["skills", "core", "languages", "coding"]
REQUIRED_DEFT_FILES = ["main.md"]

AGENTS_MD_ENTRY = f"See {DEFT_DIR_NAME}/main.md"
AGENTS_MD_SKILLS = (
    f"Skills: {DEFT_DIR_NAME}/skills/deft-setup/SKILL.md, "
    f"{DEFT_DIR_NAME}/skills/deft-build/SKILL.md"
)

STORE_PYTHON_URL = "ms-windows-store://pdp/?ProductId=9PNRBTZXMB4Z"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def _print(msg: str) -> None:
    print(msg)


def _ok(msg: str) -> None:
    print(f"\u2713 {msg}")


def _warn(msg: str) -> None:
    print(f"\u26a0  {msg}")


def _err(msg: str) -> None:
    print(f"\u2717 {msg}", file=sys.stderr)


def _info(msg: str) -> None:
    print(f"  {msg}")


# ---------------------------------------------------------------------------
# 1. OS detection
# ---------------------------------------------------------------------------

def detect_os() -> str:
    """Return the host OS name: 'Windows', 'Darwin', or 'Linux'.

    Uses platform.system() — same on all supported platforms.
    """
    return platform.system()


# ---------------------------------------------------------------------------
# 2. Python version check
# ---------------------------------------------------------------------------

def check_python_version(min_major: int = 3, min_minor: int = 13) -> bool:
    """Return True if the current Python version meets the minimum requirement."""
    return sys.version_info >= (min_major, min_minor)


# ---------------------------------------------------------------------------
# 3. git check
# ---------------------------------------------------------------------------

def check_git() -> bool:
    """Return True if git is available on PATH."""
    return shutil.which("git") is not None


# ---------------------------------------------------------------------------
# 4. task (Taskfile) check and install
# ---------------------------------------------------------------------------

def check_task() -> bool:
    """Return True if task (Taskfile runner) is available on PATH."""
    return shutil.which("task") is not None


def get_task_install_cmd(os_name: str) -> Optional[str]:
    """Return the best available install command for Taskfile on the given OS.

    Returns None if no suitable installer can be detected.
    Priority:
        Windows : choco > scoop > official installer script
        macOS   : brew > official installer script
        Linux   : official installer script (curl | sh)
    """
    if os_name == "Windows":
        if shutil.which("choco"):
            return "choco install go-task"
        if shutil.which("scoop"):
            return "scoop install task"
        # Official Windows binary installer (PowerShell)
        return (
            'powershell -ExecutionPolicy Bypass -Command '
            '"& { Invoke-RestMethod https://taskfile.dev/install.sh | sh }"'
        )
    if os_name == "Darwin":
        if shutil.which("brew"):
            return "brew install go-task"
        return 'sh -c "$(curl -fsSL https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin'
    # Linux
    return 'sh -c "$(curl -fsSL https://taskfile.dev/install.sh)" -- -d -b ~/.local/bin'


def install_task(os_name: str, _input_fn=input) -> bool:
    """Ask the user for consent, then install Taskfile.

    Args:
        os_name:   OS string from detect_os().
        _input_fn: Replaceable for tests (default: built-in input).

    Returns:
        True  — task was installed successfully (or is now on PATH).
        False — user declined or installation failed.
    """
    cmd = get_task_install_cmd(os_name)
    _warn("Taskfile (task) is not installed.")
    _info("Deft requires Taskfile to run quality gates (task check, task test:coverage).")
    _info(f"Install command: {cmd}")
    _print("")
    try:
        answer = _input_fn("Install Taskfile now? [y/N] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        answer = ""
    if answer not in ("y", "yes"):
        _err("Installation stopped — Taskfile is required.")
        return False
    _info(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=True)  # noqa: S602
    if result.returncode != 0:
        _err("Taskfile installation failed. Please install manually: https://taskfile.dev")
        return False
    if not check_task():
        _warn("Taskfile installed but 'task' is not yet on PATH.")
        _info("You may need to open a new terminal or update your PATH.")
    return True


# ---------------------------------------------------------------------------
# 5. Deft directory structure validation
# ---------------------------------------------------------------------------

def validate_deft_structure(deft_dir: Path) -> list[str]:
    """Return a list of missing paths relative to deft_dir.

    Checks required subdirectories and root files.
    An empty list means the structure is complete.
    """
    missing: list[str] = []
    for d in REQUIRED_DEFT_DIRS:
        if not (deft_dir / d).is_dir():
            missing.append(f"{d}/")
    for f in REQUIRED_DEFT_FILES:
        if not (deft_dir / f).is_file():
            missing.append(f)
    return missing


# ---------------------------------------------------------------------------
# 6. AGENTS.md — skill discovery wiring
# ---------------------------------------------------------------------------

def update_agents_md(project_root: Path, deft_dir_name: str = DEFT_DIR_NAME) -> None:
    """Create or update AGENTS.md in project_root with deft skill references.

    - If AGENTS.md does not exist: create it with the deft block.
    - If AGENTS.md already contains the entry: leave it unchanged (idempotent).
    - If AGENTS.md exists but lacks the entry: append the deft block.

    The deft block:
        See {deft_dir_name}/main.md
        Skills: {deft_dir_name}/skills/deft-setup/SKILL.md, ...
    """
    entry_line = f"See {deft_dir_name}/main.md"
    skills_line = (
        f"Skills: {deft_dir_name}/skills/deft-setup/SKILL.md, "
        f"{deft_dir_name}/skills/deft-build/SKILL.md"
    )
    block = f"{entry_line}\n{skills_line}\n"

    agents_md = project_root / "AGENTS.md"

    if agents_md.exists():
        existing = agents_md.read_text(encoding="utf-8")
        if entry_line in existing:
            _ok("AGENTS.md already contains deft entry — skipping")
            return
        # Append with a blank separator if file doesn't end with newline
        separator = "\n" if existing and not existing.endswith("\n") else ""
        agents_md.write_text(existing + separator + "\n" + block, encoding="utf-8")
        _ok(f"Updated {agents_md}")
    else:
        agents_md.write_text(block, encoding="utf-8")
        _ok(f"Created {agents_md}")


# ---------------------------------------------------------------------------
# 7. USER.md config directory
# ---------------------------------------------------------------------------

def resolve_user_md_path() -> Path:
    """Return the platform-appropriate USER.md path.

    Priority:
        1. $DEFT_USER_PATH if set
        2. Windows: %APPDATA%\\deft\\USER.md
        3. Unix:    ~/.config/deft/USER.md
    """
    env_override = os.environ.get("DEFT_USER_PATH")
    if env_override:
        return Path(env_override).expanduser().resolve()
    os_name = detect_os()
    if os_name == "Windows":
        appdata = os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))
        return Path(appdata) / "deft" / "USER.md"
    return Path.home() / ".config" / "deft" / "USER.md"


def create_user_config_dir(user_md_path: Optional[Path] = None) -> Path:
    """Create the parent directory of USER.md if it does not exist.

    Returns the path to USER.md.
    """
    if user_md_path is None:
        user_md_path = resolve_user_md_path()
    user_md_path.parent.mkdir(parents=True, exist_ok=True)
    return user_md_path


# ---------------------------------------------------------------------------
# 8. Main entry point
# ---------------------------------------------------------------------------

def main(args: Optional[list[str]] = None) -> int:
    """Run the Deft installer.

    Returns 0 on success, non-zero on failure.
    """
    _print("")
    _print("Deft Installer")
    _print("=" * 40)
    _print("")

    os_name = detect_os()
    _ok(f"OS detected: {os_name}")

    # --- Python version ---
    if not check_python_version():
        maj, min_ = sys.version_info[:2]
        _err(f"Python {maj}.{min_} detected — Python 3.13+ is required.")
        _info("Visit https://python.org or run the install wrapper for your OS.")
        return 1
    _ok(f"Python {sys.version_info.major}.{sys.version_info.minor} \u2265 3.13")

    # --- git ---
    if not check_git():
        _err("git not found on PATH — git is required.")
        _info("Install git from https://git-scm.com")
        return 1
    _ok("git found")

    # --- task (Taskfile) ---
    if not check_task():
        if not install_task(os_name):
            return 1
    else:
        _ok("task (Taskfile) found")

    # --- deft structure ---
    _print("")
    missing = validate_deft_structure(DEFT_DIR)
    if missing:
        _err(f"Deft directory structure is incomplete — missing: {', '.join(missing)}")
        _info(f"Ensure the deft repo is fully cloned at: {DEFT_DIR}")
        return 1
    _ok("Deft directory structure valid")

    # --- AGENTS.md ---
    update_agents_md(PROJECT_ROOT)

    # --- USER.md config dir ---
    user_md = create_user_config_dir()
    if not user_md.exists():
        _ok(f"Created config directory: {user_md.parent}")
    else:
        _ok(f"Config directory exists: {user_md.parent}")

    # --- Next steps ---
    _print("")
    _print("=" * 40)
    _ok("Deft installed successfully!")
    _print("")
    _info("Next steps:")
    _info("  Open your AI agent in this directory and run /deft-setup")
    _info("  or ask it to 'set up deft' to configure your preferences.")
    _print("")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
