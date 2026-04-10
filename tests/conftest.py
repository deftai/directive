"""
conftest.py — Shared pytest fixtures for the Deft Directive testbed.

Import strategy: tests import from `run` (the shim in run.py) which loads
the extension-less `run` CLI file via importlib. See run.py for details.

Author: Scott Adams (msadams) — 2026-03-09
"""

import contextlib
import io
import sys
from collections import deque
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

# --- WinError 448 mitigation (#281) ---
# Windows 11 24H2+ security policy treats directory symlinks as untrusted mount
# points. Pytest creates *current symlinks for tmp_path directories; cleanup
# fails with WinError 448 when iterating directories that contain them.
# tmp_path_retention_count = 0 (pyproject.toml) prevents old-session retention;
# this patch suppresses the OSError during session-finish and atexit cleanup.
if sys.platform == "win32":

    def _make_safe(fn):  # type: ignore[no-untyped-def]  # noqa: ANN001
        """Wrap a pytest cleanup function to swallow OSError (WinError 448)."""

        def _safe_wrapper(*args, **kwargs):  # type: ignore[no-untyped-def]
            try:
                return fn(*args, **kwargs)
            except OSError:
                pass

        return _safe_wrapper

    # Patch both the definition module (_pytest.pathlib) and the call-site module
    # (_pytest.tmpdir) so already-bound references also pick up the wrapper.
    import _pytest.pathlib as _pathlib_mod  # type: ignore[import-untyped]
    import _pytest.tmpdir as _tmpdir_mod  # type: ignore[import-untyped]

    for _fn_name in ("cleanup_dead_symlinks", "cleanup_numbered_dir"):
        for _mod in (_pathlib_mod, _tmpdir_mod):
            _orig = getattr(_mod, _fn_name, None)
            if _orig is not None:
                setattr(_mod, _fn_name, _make_safe(_orig))


@pytest.fixture(scope="session")
def deft_root() -> Path:
    """Return the absolute path to the deft repo root.

    Used by content tests to locate .md files and other framework assets.
    """
    # conftest.py lives at tests/ — repo root is one level up
    return Path(__file__).parent.parent.resolve()


@pytest.fixture
def tmp_project_dir(tmp_path: Path) -> Path:
    """Create a temporary directory with a minimal deft-like structure.

    Provides an isolated workspace for CLI tests so they don't touch
    the real repo or the user's config files.

    Structure created:
        tmp_path/
        ├── main.md
        ├── core/
        └── languages/
    """
    (tmp_path / "main.md").write_text("# Test main.md\n")
    (tmp_path / "core").mkdir()
    (tmp_path / "languages").mkdir()
    return tmp_path


@pytest.fixture
def mock_user_config(tmp_path: Path) -> Path:
    """Create a temporary USER.md with minimal valid content.

    Used by bootstrap and project command tests to provide a pre-existing
    user config without touching ~/.config/deft/USER.md.
    """
    user_md = tmp_path / "USER.md"
    user_md.write_text(
        "# User Preferences\n\n"
        "## Identity\n\nName: Test User\n\n"
        "## Communication\n\nStyle: concise\n"
    )
    return user_md


@pytest.fixture(scope="session")
def deft_module():
    """Load the deft CLI module via the run.py importlib shim.

    Returns the loaded module so tests can call cmd_* functions directly.
    All CLI tests should use this fixture rather than importing run directly,
    so the import strategy is centralised here.

    Example:
        def test_something(deft_module):
            result = deft_module.get_script_dir()
            assert result.is_dir()
    """
    import importlib.util
    from pathlib import Path

    run_py = Path(__file__).parent.parent / "run.py"
    spec = importlib.util.spec_from_file_location("run", run_py)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.fixture(scope="session")
def deft_run_module(deft_module):
    """Return the underlying deft_run module where cmd_* globals resolve.

    deft_module (from run.py) re-exports deft_run's names, but each cmd_*
    function's __globals__ points to deft_run's namespace.  Monkeypatching
    module-level variables (HAS_RICH, get_script_dir, ask_input, etc.) MUST
    target deft_run — otherwise the patches are invisible to the running code.
    """
    return sys.modules["deft_run"]


@pytest.fixture
def isolated_env(tmp_project_dir: Path, monkeypatch: pytest.MonkeyPatch):
    """Combine tmp_project_dir with env var overrides for CLI isolation.

    Sets DEFT_USER_PATH and DEFT_PROJECT_PATH to temp locations so CLI
    commands don't read/write real config files during tests.
    """
    user_md = tmp_project_dir / "USER.md"
    project_md = tmp_project_dir / "PROJECT.md"
    monkeypatch.setenv("DEFT_USER_PATH", str(user_md))
    monkeypatch.setenv("DEFT_PROJECT_PATH", str(project_md))
    monkeypatch.chdir(tmp_project_dir)
    return tmp_project_dir


@pytest.fixture
def run_command(deft_module: Any):
    """Factory fixture: invoke a cmd_* function in isolation, capturing output.

    Returns a callable that runs a named cmd_* function with the given args,
    capturing all stdout/stderr without touching the terminal.

    Returns a SimpleNamespace with:
        .stdout      (str) — captured standard output
        .stderr      (str) — captured standard error
        .return_code (int | None) — return value or SystemExit code

    Example:
        def test_doctor_runs(run_command):
            result = run_command("cmd_doctor", [])
            assert result.return_code in (0, None)
    """

    def _run(cmd_fn_name: str, args: list | None = None) -> SimpleNamespace:
        args = args or []
        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()
        fn = getattr(deft_module, cmd_fn_name)
        return_code: Any = None
        try:
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                return_code = fn(args)
        except SystemExit as exc:
            return_code = exc.code
        except Exception as exc:  # noqa: BLE001
            return_code = 1
            stderr_buf.write(f"{type(exc).__name__}: {exc}\n")
        return SimpleNamespace(
            stdout=stdout_buf.getvalue(),
            stderr=stderr_buf.getvalue(),
            return_code=return_code,
        )

    return _run


@pytest.fixture
def mock_user_input(deft_run_module: Any, monkeypatch: pytest.MonkeyPatch):
    """Factory fixture: queue predetermined responses for interactive prompts.

    Patches ask_input, ask_choice, ask_confirm and their legacy aliases
    (read_input, read_yn) on the **deft_run** module so cmd_* functions run
    non-interactively in tests.  (cmd_* functions resolve these names from
    deft_run's globals, NOT from the run.py re-export module.)  All patches
    are undone after each test by monkeypatch.

    Args:
        responses: Ordered list of values to return per prompt call.
                   Use str for ask_input / ask_choice, bool for ask_confirm.

    Raises AssertionError if the queue is exhausted before all prompts are
    satisfied, naming the prompt text to aid debugging.

    Example:
        def test_bootstrap_happy_path(run_command, mock_user_input, isolated_env):
            mock_user_input([str(isolated_env / "USER.md"), "Scott", "85", "1", False])
            result = run_command("cmd_bootstrap", [])
            assert result.return_code == 0
    """

    def _mock(responses: list) -> None:
        queue: deque = deque(responses)

        def _pop(*args: Any, **kwargs: Any) -> Any:
            if not queue:
                prompt_label = args[0] if args else "?"
                raise AssertionError(
                    f"mock_user_input: response queue exhausted "
                    f"(prompt was: {prompt_label!r})"
                )
            return queue.popleft()

        for name in ("ask_input", "ask_choice", "ask_confirm", "read_input", "read_yn"):
            if hasattr(deft_run_module, name):
                monkeypatch.setattr(deft_run_module, name, _pop)

    return _mock
