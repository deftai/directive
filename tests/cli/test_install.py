"""
test_install.py — Unit tests for install.py (Deft installer).

Implementation: IMPLEMENTATION.md Phase 2.4

Covers:
  - OS detection
  - Python version check (pass / fail)
  - git and task presence checks (mocked shutil.which)
  - get_task_install_cmd per OS and package-manager priority
  - install_task consent gate (decline stops cleanly)
  - validate_deft_structure (complete / missing paths)
  - update_agents_md: create new, append to existing, idempotent
  - create_user_config_dir: creates parent dirs
  - resolve_user_md_path: Windows path, Unix path, env override

Author: Scott Adams (msadams) — 2026-03-12
"""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Load install.py via importlib (mirrors the run.py shim pattern)
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_INSTALL_PY = _REPO_ROOT / "install.py"


@pytest.fixture(scope="session")
def install_mod():
    """Load install.py as a module once per test session."""
    spec = importlib.util.spec_from_file_location("install", _INSTALL_PY)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------------------
# 1. OS detection
# ---------------------------------------------------------------------------

def test_detect_os_returns_non_empty_string(install_mod) -> None:
    """detect_os() must return a non-empty string."""
    result = install_mod.detect_os()
    assert isinstance(result, str)
    assert len(result) > 0


def test_detect_os_returns_known_value(install_mod) -> None:
    """detect_os() must return one of the expected platform strings."""
    result = install_mod.detect_os()
    assert result in ("Windows", "Linux", "Darwin", "FreeBSD")


# ---------------------------------------------------------------------------
# 2. Python version check
# ---------------------------------------------------------------------------

def test_check_python_version_current_passes(install_mod) -> None:
    """check_python_version() must pass for the running interpreter (>=3.12 dev env)."""
    # The test env uses Python 3.12 — we call with relaxed minimum to confirm it passes
    assert install_mod.check_python_version(min_major=3, min_minor=12) is True


def test_check_python_version_too_old_fails(install_mod) -> None:
    """check_python_version() must fail for a minimum higher than any Python."""
    # No Python interpreter will ever be version 99.0
    assert install_mod.check_python_version(min_major=99, min_minor=0) is False


def test_check_python_version_exact_boundary(install_mod) -> None:
    """check_python_version() must return True for the exact current version."""
    major, minor = sys.version_info[:2]
    assert install_mod.check_python_version(min_major=major, min_minor=minor) is True


# ---------------------------------------------------------------------------
# 3. git check
# ---------------------------------------------------------------------------

def test_check_git_found(install_mod, monkeypatch) -> None:
    """check_git() must return True when shutil.which finds git."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: "/usr/bin/git" if cmd == "git" else None)
    assert install_mod.check_git() is True


def test_check_git_not_found(install_mod, monkeypatch) -> None:
    """check_git() must return False when git is not on PATH."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    assert install_mod.check_git() is False


# ---------------------------------------------------------------------------
# 4. task check
# ---------------------------------------------------------------------------

def test_check_task_found(install_mod, monkeypatch) -> None:
    """check_task() must return True when shutil.which finds task."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: "/usr/local/bin/task" if cmd == "task" else None)
    assert install_mod.check_task() is True


def test_check_task_not_found(install_mod, monkeypatch) -> None:
    """check_task() must return False when task is not on PATH."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    assert install_mod.check_task() is False


# ---------------------------------------------------------------------------
# 5. get_task_install_cmd
# ---------------------------------------------------------------------------

def test_task_install_cmd_windows_choco(install_mod, monkeypatch) -> None:
    """Windows + choco available → choco install go-task."""
    monkeypatch.setattr(
        install_mod.shutil, "which",
        lambda cmd: "C:\\ProgramData\\chocolatey\\bin\\choco.exe" if cmd == "choco" else None,
    )
    cmd = install_mod.get_task_install_cmd("Windows")
    assert cmd == "choco install go-task"


def test_task_install_cmd_windows_scoop(install_mod, monkeypatch) -> None:
    """Windows + scoop available (no choco) → scoop install task."""
    monkeypatch.setattr(
        install_mod.shutil, "which",
        lambda cmd: "scoop" if cmd == "scoop" else None,
    )
    cmd = install_mod.get_task_install_cmd("Windows")
    assert cmd == "scoop install task"


def test_task_install_cmd_windows_fallback(install_mod, monkeypatch) -> None:
    """Windows with no package manager → official PowerShell installer."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    cmd = install_mod.get_task_install_cmd("Windows")
    assert cmd is not None
    assert "powershell" in cmd.lower() or "Invoke-RestMethod" in cmd


def test_task_install_cmd_macos_brew(install_mod, monkeypatch) -> None:
    """macOS + brew available → brew install go-task."""
    monkeypatch.setattr(
        install_mod.shutil, "which",
        lambda cmd: "/usr/local/bin/brew" if cmd == "brew" else None,
    )
    cmd = install_mod.get_task_install_cmd("Darwin")
    assert cmd == "brew install go-task"


def test_task_install_cmd_macos_fallback(install_mod, monkeypatch) -> None:
    """macOS without brew → official curl installer."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    cmd = install_mod.get_task_install_cmd("Darwin")
    assert cmd is not None
    assert "taskfile.dev" in cmd


def test_task_install_cmd_linux(install_mod, monkeypatch) -> None:
    """Linux → official curl installer pointing to ~/.local/bin."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    cmd = install_mod.get_task_install_cmd("Linux")
    assert cmd is not None
    assert "taskfile.dev" in cmd
    assert ".local/bin" in cmd


# ---------------------------------------------------------------------------
# 6. install_task — consent gate
# ---------------------------------------------------------------------------

def test_install_task_decline_returns_false(install_mod, monkeypatch) -> None:
    """install_task() must return False and not run subprocess when user declines."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    ran_subprocess = []

    def _fake_run(cmd, **kwargs):
        ran_subprocess.append(cmd)
        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(install_mod.subprocess, "run", _fake_run)

    result = install_mod.install_task("Linux", _input_fn=lambda _: "n")
    assert result is False
    assert len(ran_subprocess) == 0, "subprocess.run must not be called when user declines"


def test_install_task_accept_runs_subprocess(install_mod, monkeypatch) -> None:
    """install_task() must run the install command when user accepts."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    ran = []

    def _fake_run(cmd, **kwargs):
        ran.append(cmd)
        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(install_mod.subprocess, "run", _fake_run)

    result = install_mod.install_task("Linux", _input_fn=lambda _: "y")
    assert len(ran) == 1


def test_install_task_subprocess_failure_returns_false(install_mod, monkeypatch) -> None:
    """install_task() must return False when subprocess returns non-zero."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)

    def _fake_run(cmd, **kwargs):
        class _R:
            returncode = 1
        return _R()

    monkeypatch.setattr(install_mod.subprocess, "run", _fake_run)

    result = install_mod.install_task("Linux", _input_fn=lambda _: "y")
    assert result is False


# ---------------------------------------------------------------------------
# 7. validate_deft_structure
# ---------------------------------------------------------------------------

def test_validate_deft_structure_complete(install_mod, tmp_path) -> None:
    """validate_deft_structure() returns empty list when all paths exist."""
    deft_dir = tmp_path / "deft"
    deft_dir.mkdir()
    for d in install_mod.REQUIRED_DEFT_DIRS:
        (deft_dir / d).mkdir()
    for f in install_mod.REQUIRED_DEFT_FILES:
        (deft_dir / f).write_text("# test\n")

    missing = install_mod.validate_deft_structure(deft_dir)
    assert missing == []


def test_validate_deft_structure_missing_dir(install_mod, tmp_path) -> None:
    """validate_deft_structure() lists missing directories."""
    deft_dir = tmp_path / "deft"
    deft_dir.mkdir()
    # Intentionally omit all dirs
    missing = install_mod.validate_deft_structure(deft_dir)
    assert len(missing) > 0
    # Every required dir should appear in missing list
    for d in install_mod.REQUIRED_DEFT_DIRS:
        assert f"{d}/" in missing


def test_validate_deft_structure_missing_file(install_mod, tmp_path) -> None:
    """validate_deft_structure() lists missing required files."""
    deft_dir = tmp_path / "deft"
    deft_dir.mkdir()
    for d in install_mod.REQUIRED_DEFT_DIRS:
        (deft_dir / d).mkdir()
    # Omit required files

    missing = install_mod.validate_deft_structure(deft_dir)
    for f in install_mod.REQUIRED_DEFT_FILES:
        assert f in missing


# ---------------------------------------------------------------------------
# 8. update_agents_md
# ---------------------------------------------------------------------------

def test_update_agents_md_creates_new(install_mod, tmp_path) -> None:
    """update_agents_md() creates AGENTS.md when it does not exist."""
    install_mod.update_agents_md(tmp_path, deft_dir_name="deft")
    agents = tmp_path / "AGENTS.md"
    assert agents.exists()
    content = agents.read_text(encoding="utf-8")
    assert "See deft/main.md" in content
    assert "deft/skills/deft-setup/SKILL.md" in content
    assert "deft/skills/deft-build/SKILL.md" in content


def test_update_agents_md_appends_to_existing(install_mod, tmp_path) -> None:
    """update_agents_md() appends the deft block to an existing AGENTS.md."""
    agents = tmp_path / "AGENTS.md"
    agents.write_text("# Project Agent Instructions\n\nDo the thing.\n", encoding="utf-8")

    install_mod.update_agents_md(tmp_path, deft_dir_name="deft")

    content = agents.read_text(encoding="utf-8")
    assert "# Project Agent Instructions" in content  # original preserved
    assert "See deft/main.md" in content              # deft block appended


def test_update_agents_md_idempotent(install_mod, tmp_path) -> None:
    """update_agents_md() does not duplicate the deft block on repeated calls."""
    install_mod.update_agents_md(tmp_path, deft_dir_name="deft")
    install_mod.update_agents_md(tmp_path, deft_dir_name="deft")

    content = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
    assert content.count("See deft/main.md") == 1


def test_update_agents_md_respects_deft_dir_name(install_mod, tmp_path) -> None:
    """update_agents_md() uses the supplied deft_dir_name in references."""
    install_mod.update_agents_md(tmp_path, deft_dir_name="myframework")

    content = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
    assert "See myframework/main.md" in content
    assert "myframework/skills/deft-setup/SKILL.md" in content


# ---------------------------------------------------------------------------
# 9. create_user_config_dir
# ---------------------------------------------------------------------------

def test_create_user_config_dir_creates_parents(install_mod, tmp_path) -> None:
    """create_user_config_dir() creates all parent directories."""
    user_md = tmp_path / "nested" / "deft" / "USER.md"
    assert not user_md.parent.exists()

    result = install_mod.create_user_config_dir(user_md)

    assert result == user_md
    assert user_md.parent.is_dir()


def test_create_user_config_dir_idempotent(install_mod, tmp_path) -> None:
    """create_user_config_dir() can be called repeatedly without error."""
    user_md = tmp_path / "deft" / "USER.md"
    install_mod.create_user_config_dir(user_md)
    install_mod.create_user_config_dir(user_md)  # should not raise
    assert user_md.parent.is_dir()


# ---------------------------------------------------------------------------
# 10. resolve_user_md_path
# ---------------------------------------------------------------------------

def test_resolve_user_md_path_env_override(install_mod, monkeypatch, tmp_path) -> None:
    """$DEFT_USER_PATH takes precedence on any platform."""
    custom = tmp_path / "custom" / "USER.md"
    monkeypatch.setenv("DEFT_USER_PATH", str(custom))

    result = install_mod.resolve_user_md_path()
    assert result == custom.resolve()


def test_resolve_user_md_path_windows_default(install_mod, monkeypatch, tmp_path) -> None:
    """Windows default resolves to %APPDATA%\\deft\\USER.md."""
    monkeypatch.delenv("DEFT_USER_PATH", raising=False)
    monkeypatch.setattr(install_mod, "detect_os", lambda: "Windows")
    fake_appdata = str(tmp_path / "AppData" / "Roaming")
    monkeypatch.setenv("APPDATA", fake_appdata)

    result = install_mod.resolve_user_md_path()
    assert result == Path(fake_appdata) / "deft" / "USER.md"


def test_resolve_user_md_path_unix_default(install_mod, monkeypatch) -> None:
    """Unix default resolves to ~/.config/deft/USER.md."""
    monkeypatch.delenv("DEFT_USER_PATH", raising=False)
    monkeypatch.setattr(install_mod, "detect_os", lambda: "Linux")

    result = install_mod.resolve_user_md_path()
    assert result == Path.home() / ".config" / "deft" / "USER.md"


def test_resolve_user_md_path_macos_default(install_mod, monkeypatch) -> None:
    """macOS default resolves to ~/.config/deft/USER.md (same as Linux)."""
    monkeypatch.delenv("DEFT_USER_PATH", raising=False)
    monkeypatch.setattr(install_mod, "detect_os", lambda: "Darwin")

    result = install_mod.resolve_user_md_path()
    assert result == Path.home() / ".config" / "deft" / "USER.md"


def test_resolve_user_md_path_windows_no_appdata(install_mod, monkeypatch) -> None:
    """Windows without APPDATA set falls back to ~/AppData/Roaming/deft/USER.md."""
    monkeypatch.delenv("DEFT_USER_PATH", raising=False)
    monkeypatch.delenv("APPDATA", raising=False)
    monkeypatch.setattr(install_mod, "detect_os", lambda: "Windows")

    result = install_mod.resolve_user_md_path()
    expected = Path.home() / "AppData" / "Roaming" / "deft" / "USER.md"
    assert result == expected


# ---------------------------------------------------------------------------
# 11. get_task_install_cmd — priority when multiple managers present
# ---------------------------------------------------------------------------

def test_task_install_cmd_windows_choco_beats_scoop(install_mod, monkeypatch) -> None:
    """choco takes priority over scoop when both are available on Windows."""
    monkeypatch.setattr(
        install_mod.shutil, "which",
        lambda cmd: "found" if cmd in ("choco", "scoop") else None,
    )
    cmd = install_mod.get_task_install_cmd("Windows")
    assert cmd == "choco install go-task"


# ---------------------------------------------------------------------------
# 12. install_task — EOFError and KeyboardInterrupt
# ---------------------------------------------------------------------------

def test_install_task_eoferror_treated_as_decline(install_mod, monkeypatch) -> None:
    """EOFError on input is treated as a decline — returns False, no subprocess."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    ran = []

    def _fake_run(cmd, **kwargs):
        ran.append(cmd)
        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(install_mod.subprocess, "run", _fake_run)

    def _raise_eof(_prompt):
        raise EOFError

    result = install_mod.install_task("Linux", _input_fn=_raise_eof)
    assert result is False
    assert ran == [], "subprocess.run must not be called when input raises EOFError"


def test_install_task_keyboard_interrupt_treated_as_decline(install_mod, monkeypatch) -> None:
    """KeyboardInterrupt on input is treated as a decline — returns False, no subprocess."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    ran = []

    def _fake_run(cmd, **kwargs):
        ran.append(cmd)
        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(install_mod.subprocess, "run", _fake_run)

    def _raise_interrupt(_prompt):
        raise KeyboardInterrupt

    result = install_mod.install_task("Linux", _input_fn=_raise_interrupt)
    assert result is False
    assert ran == [], "subprocess.run must not be called on KeyboardInterrupt"


def test_install_task_yes_full_word_accepted(install_mod, monkeypatch) -> None:
    """Typing 'yes' (full word) must be treated as acceptance."""
    monkeypatch.setattr(install_mod.shutil, "which", lambda cmd: None)
    ran = []

    def _fake_run(cmd, **kwargs):
        ran.append(cmd)
        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(install_mod.subprocess, "run", _fake_run)

    install_mod.install_task("Linux", _input_fn=lambda _: "yes")
    assert len(ran) == 1, "subprocess.run must be called when user types 'yes'"


# ---------------------------------------------------------------------------
# 13. update_agents_md — existing file without trailing newline
# ---------------------------------------------------------------------------

def test_update_agents_md_no_trailing_newline(install_mod, tmp_path) -> None:
    """update_agents_md() inserts a clean separator when file has no trailing newline."""
    agents = tmp_path / "AGENTS.md"
    agents.write_text("Existing content without newline", encoding="utf-8")

    install_mod.update_agents_md(tmp_path, deft_dir_name="deft")

    content = agents.read_text(encoding="utf-8")
    assert "Existing content without newline" in content
    assert "See deft/main.md" in content
    # The deft block must not be glued directly to the existing text
    assert "newlineSee" not in content
    assert "newline\nSee" not in content


# ---------------------------------------------------------------------------
# 14. main() integration
# ---------------------------------------------------------------------------

def _setup_main_happy_path(install_mod, monkeypatch, tmp_path) -> None:
    """Patch all main() dependencies for a fully successful run."""
    monkeypatch.setattr(install_mod, "check_python_version", lambda: True)
    monkeypatch.setattr(install_mod, "check_git", lambda: True)
    monkeypatch.setattr(install_mod, "check_task", lambda: True)
    monkeypatch.setattr(install_mod, "validate_deft_structure", lambda _d: [])
    monkeypatch.setattr(install_mod, "update_agents_md", lambda *_a, **_kw: None)
    user_md = tmp_path / "deft" / "USER.md"
    monkeypatch.setattr(install_mod, "create_user_config_dir", lambda: user_md)


def test_main_all_prereqs_met_returns_0(install_mod, monkeypatch, tmp_path) -> None:
    """main() returns 0 when all prerequisites are satisfied."""
    _setup_main_happy_path(install_mod, monkeypatch, tmp_path)
    assert install_mod.main([]) == 0


def test_main_python_too_old_returns_1(install_mod, monkeypatch, tmp_path) -> None:
    """main() returns 1 and stops immediately when Python version is too old."""
    _setup_main_happy_path(install_mod, monkeypatch, tmp_path)
    monkeypatch.setattr(install_mod, "check_python_version", lambda: False)

    git_called = []
    monkeypatch.setattr(install_mod, "check_git", lambda: git_called.append(1) or True)

    assert install_mod.main([]) == 1
    assert git_called == [], "check_git must not be called after Python version fails"


def test_main_git_missing_returns_1(install_mod, monkeypatch, tmp_path) -> None:
    """main() returns 1 when git is not found on PATH."""
    _setup_main_happy_path(install_mod, monkeypatch, tmp_path)
    monkeypatch.setattr(install_mod, "check_git", lambda: False)
    assert install_mod.main([]) == 1


def test_main_task_declined_returns_1(install_mod, monkeypatch, tmp_path) -> None:
    """main() returns 1 when task is missing and the user declines to install it."""
    _setup_main_happy_path(install_mod, monkeypatch, tmp_path)
    monkeypatch.setattr(install_mod, "check_task", lambda: False)
    monkeypatch.setattr(install_mod, "install_task", lambda _os: False)
    assert install_mod.main([]) == 1


def test_main_task_installed_on_consent_returns_0(install_mod, monkeypatch, tmp_path) -> None:
    """main() returns 0 when task is missing but the user consents to install it."""
    _setup_main_happy_path(install_mod, monkeypatch, tmp_path)
    monkeypatch.setattr(install_mod, "check_task", lambda: False)
    monkeypatch.setattr(install_mod, "install_task", lambda _os: True)
    assert install_mod.main([]) == 0


def test_main_bad_structure_returns_1(install_mod, monkeypatch, tmp_path) -> None:
    """main() returns 1 when the deft directory structure is incomplete."""
    _setup_main_happy_path(install_mod, monkeypatch, tmp_path)
    monkeypatch.setattr(install_mod, "validate_deft_structure", lambda _d: ["skills/", "core/"])
    assert install_mod.main([]) == 1


def test_main_calls_update_agents_md(install_mod, monkeypatch, tmp_path) -> None:
    """main() calls update_agents_md() exactly once on success."""
    _setup_main_happy_path(install_mod, monkeypatch, tmp_path)
    calls = []
    monkeypatch.setattr(install_mod, "update_agents_md", lambda *_a, **_kw: calls.append(1))
    install_mod.main([])
    assert len(calls) == 1


def test_main_calls_create_user_config_dir(install_mod, monkeypatch, tmp_path) -> None:
    """main() calls create_user_config_dir() exactly once on success."""
    _setup_main_happy_path(install_mod, monkeypatch, tmp_path)
    calls = []
    user_md = tmp_path / "USER.md"
    monkeypatch.setattr(
        install_mod, "create_user_config_dir",
        lambda: calls.append(1) or user_md,
    )
    install_mod.main([])
    assert len(calls) == 1
