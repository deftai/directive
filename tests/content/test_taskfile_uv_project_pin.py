"""Guard-rail tests for #1011.

Ensures every framework-side ``uv run`` invocation in ``tasks/*.yml`` and the
root ``Taskfile.yml`` carries an explicit ``--project`` pin, so uv cannot walk
upward from cwd and bind to an ancestor ``pyproject.toml`` on the consumer
machine. The root-cause analysis lives in the #1011 vBRIEF; the short version
is that without ``--project``, ``uv run`` (cwd = consumer repo root) walks
upward looking for the nearest ``pyproject.toml``, escapes the framework
directory whenever the consumer repo has no ``pyproject.toml`` of its own, and
crashes during build-backend resolution before any framework task body runs.

Two invariants are enforced via parametrised lanes:

1. ``test_no_unpinned_uv_run_in_command_lines`` -- no non-comment ``cmds:``
   line may invoke ``uv run`` without an immediately-preceding ``--project``
   global flag. The accepted shapes are::

       uv --project "{{.DEFT_ROOT}}" run python ...      # tasks/*.yml
       uv --project "{{.TASKFILE_DIR}}" run python ...   # root Taskfile.yml

   Both forms beat env, which beats walk, per uv's resolution priority.

2. ``test_uv_project_env_set_at_root`` -- the root ``Taskfile.yml`` ``env:``
   block defines ``UV_PROJECT`` to ``{{.TASKFILE_DIR}}`` as the Layer-1 safety
   net. The CLI flag is the contract; the env var is defense-in-depth for any
   task that drops the flag in a future edit (see the vBRIEF Proposed-fix
   section for the two-layer rationale).

The optional slow lane ``TestAncestorPyprojectIsolation`` builds a hostile
parent ``pyproject.toml`` with an unresolvable build backend and asserts a
pinned ``uv run`` against the framework root succeeds, while an unpinned
invocation either crashes or escapes to the ancestor. Skipped when ``uv`` is
not on PATH.

See:
  - deftai/directive#1011 -- root bug
  - deft/Taskfile.yml `env: UV_PROJECT` -- Layer 1 safety net
  - deft/tasks/*.yml `uv --project "{{.DEFT_ROOT}}" run` -- Layer 2 contract
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TASKS_DIR = REPO_ROOT / "tasks"
ROOT_TASKFILE = REPO_ROOT / "Taskfile.yml"


def _task_yaml_files() -> list[Path]:
    return sorted(TASKS_DIR.glob("*.yml")) + sorted(TASKS_DIR.glob("*.yaml"))


# Match ``uv run`` (with at least one space following) that is NOT immediately
# preceded by ``--project "<pin>" `` (any quoted value). Anchored to non-comment
# lines via the caller. The regex deliberately requires the global ``--project``
# form to precede the ``run`` subcommand so we do not accept the alternative
# ``uv run --project <path>`` shape -- both work at the uv layer but the
# project's convention is the global form (matches the #1011 vBRIEF), and
# pinning that single form keeps the regression sweep narrow.
_UV_RUN_TOKEN = re.compile(r"(?<![\w-])uv\s+run\b")
_PINNED_UV_RUN = re.compile(
    r'uv\s+--project\s+"[^"]+"\s+run\b'
)


def _check_taskfile(taskfile: Path) -> list[tuple[int, str]]:
    """Return unpinned ``uv run`` sites in ``taskfile`` as (lineno, line) tuples."""
    text = taskfile.read_text(encoding="utf-8")
    offenders: list[tuple[int, str]] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        if not _UV_RUN_TOKEN.search(line):
            continue
        # Accept the line only when EVERY ``uv run`` token on it is preceded by
        # the canonical ``--project "..."`` pin. Counts must match: every
        # ``uv run`` must have a corresponding ``uv --project "..." run``.
        uv_run_count = len(_UV_RUN_TOKEN.findall(line))
        pinned_count = len(_PINNED_UV_RUN.findall(line))
        if pinned_count < uv_run_count:
            offenders.append((lineno, line.rstrip()))
    return offenders


@pytest.mark.parametrize(
    "taskfile",
    _task_yaml_files() + [ROOT_TASKFILE],
    ids=lambda p: p.name,
)
def test_no_unpinned_uv_run_in_command_lines(taskfile: Path) -> None:
    """Every ``uv run`` in tasks/*.yml and root Taskfile.yml must carry
    an explicit ``--project "<pin>"`` flag -- see #1011.

    Inspects non-comment lines only so commentary that mentions the
    anti-pattern (e.g. the rationale block in the root Taskfile.yml ``env:``
    section or in this module's own prose) does not trip the check.
    """
    offenders = _check_taskfile(taskfile)
    assert not offenders, (
        f"{taskfile.relative_to(REPO_ROOT)} contains forbidden unpinned "
        f"``uv run`` invocation (replace with "
        f'``uv --project \"{{{{.DEFT_ROOT}}}}\" run`` or '
        f'``uv --project \"{{{{.TASKFILE_DIR}}}}\" run`` -- see #1011):\n'
        + "\n".join(f"  line {ln}: {text}" for ln, text in offenders)
    )


def test_uv_project_env_set_at_root() -> None:
    """The root ``Taskfile.yml`` ``env:`` block MUST set ``UV_PROJECT`` to
    ``{{.TASKFILE_DIR}}`` -- the Layer-1 safety net for #1011.

    CLI ``--project`` on each call site (Layer 2) is the contract; this
    env-var pin is defense-in-depth for any task that drops the flag in
    a future edit. Per `uv`'s resolution priority, CLI beats env, which
    beats the upward walk -- both layers must be intact for the guard
    to fully short-circuit ancestor ``pyproject.toml`` discovery.
    """
    text = ROOT_TASKFILE.read_text(encoding="utf-8")
    # Match ``UV_PROJECT: '{{.TASKFILE_DIR}}'`` with flexible quoting and
    # whitespace. The value must reference ``TASKFILE_DIR`` (not a hard-coded
    # literal path) so the pin tracks the actual install location across
    # state-A (`deft/`) / state-B (`.deft/core/`) / hybrid layouts.
    pattern = re.compile(
        r"""^\s*UV_PROJECT\s*:\s*['\"]\s*\{\{\s*\.TASKFILE_DIR\s*\}\}\s*['\"]\s*$""",
        re.MULTILINE | re.VERBOSE,
    )
    assert pattern.search(text), (
        "Root Taskfile.yml must define `UV_PROJECT: '{{.TASKFILE_DIR}}'` in "
        "its top-level `env:` block as the Layer-1 safety net for #1011. "
        "See the env: rationale block in Taskfile.yml and the vBRIEF "
        "`vbrief/active/2026-05-11-1011-*.vbrief.json` Proposed-fix section "
        "for the full two-layer architecture."
    )


# ---------------------------------------------------------------------------
# Slow behaviour lane (#1011)
#
# Verifies the load-bearing property end-to-end: a hostile ancestor
# `pyproject.toml` with an unresolvable build backend MUST NOT crash a `uv run`
# invocation that pins the framework root via `--project`. The behaviour test
# is expensive (spawns a real `uv` process inside a tempdir with full pyproject
# resolution) so it carries `@pytest.mark.slow` per the #975 convention and
# skips cleanly when `uv` is not on PATH so contributor laptops without uv keep
# `task check` green.
# ---------------------------------------------------------------------------


_POISON_PYPROJECT = """\
[build-system]
requires = ["setuptools >= 999.0.0"]
build-backend = "setuptools.backends._legacy:_Backend"

[project]
name = "deft-1011-poison-ancestor"
version = "0.0.0"
"""


@pytest.mark.slow
class TestAncestorPyprojectIsolation:
    """Behaviour regression for #1011 ancestor-pyproject leak.

    Each test creates a hostile parent ``pyproject.toml`` (build-backend
    resolves to a non-existent module), then exercises ``uv run`` from a
    subdirectory of that hostile parent against the framework root. The
    pinned form MUST succeed (proves ``--project`` short-circuits the upward
    walk); the unpinned form MUST fail (proves the hostile pyproject is
    actually reachable from the subdirectory, so the success case above is
    not vacuous).
    """

    @pytest.fixture
    def uv_bin(self) -> str:
        """Locate ``uv`` on PATH or skip the test if missing."""
        bin_path = shutil.which("uv")
        if bin_path is None:
            pytest.skip("uv not on PATH; #1011 behaviour regression skipped")
        return bin_path

    @pytest.fixture
    def hostile_tree(self, tmp_path: Path) -> Path:
        """Build a tempdir with a poison ``pyproject.toml`` at the root and
        an empty ``sub/`` directory one level beneath. Returns the path to
        the subdirectory (the cwd from which ``uv run`` will be invoked).
        """
        (tmp_path / "pyproject.toml").write_text(
            _POISON_PYPROJECT, encoding="utf-8"
        )
        sub = tmp_path / "sub"
        sub.mkdir()
        return sub

    def _strip_uv_env(self) -> dict[str, str]:
        """Return an env dict with any UV_* keys stripped.

        The behaviour test must measure raw ``uv run`` semantics, not the
        Taskfile-injected ``UV_PROJECT``. Strip every UV_* var so the
        unpinned invocation actually walks upward (otherwise an
        inherited ``UV_PROJECT=<framework>`` would mask the regression).
        """
        env = dict(os.environ)
        for k in list(env.keys()):
            if k.startswith("UV_") or k == "VIRTUAL_ENV":
                env.pop(k, None)
        # Keep PATH (for uv + python lookup) and PYTHONUTF8 (so the
        # subprocess does not crash on Windows cp1252 decode of uv's
        # stderr glyphs).
        env.setdefault("PYTHONUTF8", "1")
        return env

    def test_pinned_uv_run_ignores_ancestor_pyproject(
        self, uv_bin: str, hostile_tree: Path
    ) -> None:
        """``uv --project <framework> run python -c 'print(1)'`` MUST
        succeed even when cwd has a hostile ancestor ``pyproject.toml``
        with an unresolvable build backend.
        """
        result = subprocess.run(
            [
                uv_bin,
                "--project",
                str(REPO_ROOT),
                "run",
                "python",
                "-c",
                "print('pinned-ok')",
            ],
            cwd=hostile_tree,
            env=self._strip_uv_env(),
            capture_output=True,
            text=True,
            timeout=180,
        )
        assert result.returncode == 0, (
            "Pinned `uv --project ... run` failed against hostile ancestor "
            "pyproject (this is the load-bearing property for #1011).\n"
            f"  exit code: {result.returncode}\n"
            f"  stdout:    {result.stdout!r}\n"
            f"  stderr:    {result.stderr!r}"
        )
        assert "pinned-ok" in result.stdout

    def test_unpinned_uv_run_trips_ancestor_pyproject(
        self, uv_bin: str, hostile_tree: Path
    ) -> None:
        """``uv run python -c 'print(1)'`` (no ``--project``, no
        ``UV_PROJECT``) MUST fail because uv binds to the hostile ancestor
        ``pyproject.toml``. This is the *negative* control proving the
        regression environment is set up correctly -- if this case ever
        starts passing, the slow-lane positive assertion above becomes
        vacuous.
        """
        result = subprocess.run(
            [uv_bin, "run", "python", "-c", "print('unpinned-ok')"],
            cwd=hostile_tree,
            env=self._strip_uv_env(),
            capture_output=True,
            text=True,
            timeout=180,
        )
        # Two acceptable failure modes:
        #   - uv resolves the ancestor pyproject and fails to find the
        #     poison build backend (non-zero exit, stderr mentions the
        #     module name).
        #   - uv tries to build the parent project and aborts.
        # We do NOT require a specific exit code -- only that the run did
        # not succeed (since success would mean uv bypassed the ancestor
        # pyproject, in which case the bug never existed and #1011 is moot).
        if result.returncode == 0:
            pytest.fail(
                "Unpinned `uv run` unexpectedly succeeded against a hostile "
                "ancestor pyproject. Either uv's resolution semantics have "
                "changed and #1011 no longer applies, or the regression env "
                "is misconfigured.\n"
                f"  stdout: {result.stdout!r}\n  stderr: {result.stderr!r}"
            )
