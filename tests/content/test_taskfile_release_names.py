"""
Guard-rail tests for #718.

Ensures that the four canonical release-pipeline task names are installed
verbatim by go-task and dispatch correctly:

- ``task release``
- ``task release:e2e``
- ``task release:publish``
- ``task release:rollback``

Background: PR #712 landed the release pipeline by including
``tasks/release.yml`` under namespace key ``release:`` while the inner
tasks themselves were named ``release:`` / ``release:publish:`` /
``release:rollback:`` / ``release:e2e:``. go-task concatenates the
namespace prefix with each inner task name, so the actual installed
names became ``release:release``, ``release:release:e2e``,
``release:release:publish``, and ``release:release:rollback`` -- doubled
``release:release*`` prefix that did NOT match the canonical names
documented in ``skills/deft-directive-release/SKILL.md`` (lines 44, 47,
75, 78, 199), the ``desc:`` strings in ``tasks/release.yml``, the
CHANGELOG entries from PR #712, or the AGENTS.md skill-routing entry.

The fix per the locked Option 2a in issue #718 inlines the four release
tasks directly into the root ``Taskfile.yml``'s ``tasks:`` block (and
``git rm`` ``tasks/release.yml``), so go-task installs the canonical
names verbatim with no namespace concatenation.

The 95+ unit tests landed with PR #712 do NOT catch this -- they exercise
``scripts/release*.py`` Python entry points directly via
``importlib.util.spec_from_file_location``, never invoking through
go-task. CI passed for the same reason. This module is the missing
end-to-end guard against regressions of the namespace flatten -- if a
future contributor re-introduces the doubled prefix (e.g. by moving the
4 tasks back into a namespace-included ``tasks/release.yml``), these
tests will fail loudly.

See:
  - deftai/directive#718 -- root bug + locked design decision
  - deftai/directive#74 -- release foundation (the documented invocation)
  - deftai/directive#716 -- release safety hardening (publish/rollback/e2e)
  - skills/deft-directive-release/SKILL.md -- canonical workflow
  - tests/content/test_taskfile_caching.py -- sibling subprocess-based guard
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TASKFILE = REPO_ROOT / "Taskfile.yml"

# The four canonical release-pipeline task names per issue #718's
# acceptance criteria. Order is the documented invocation order in
# skills/deft-directive-release/SKILL.md (cut, then the safety-net
# companions per #716).
CANONICAL_RELEASE_TASK_NAMES: tuple[str, ...] = (
    "release",
    "release:e2e",
    "release:publish",
    "release:rollback",
)

# Doubled-prefix names that the broken wiring used to install. None of
# these should appear as canonical entries post-#718; if any of them
# resurface, the namespace-flatten regressed and the documented
# invocations are broken again.
DOUBLED_PREFIX_NAMES: tuple[str, ...] = (
    "release:release",
    "release:release:e2e",
    "release:release:publish",
    "release:release:rollback",
)


def _task_binary_available() -> bool:
    return shutil.which("task") is not None


pytestmark = pytest.mark.skipif(
    not _task_binary_available(),
    reason=(
        "task binary not available on PATH -- the windows-task-dispatch "
        "CI job and contributors with go-task installed exercise this; "
        "skip on Python-only lanes (mirrors test_taskfile_caching.py)."
    ),
)


def _run_task(*args: str, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    """Invoke ``task -t <Taskfile.yml> <args>`` and return the process.

    ``cwd`` is pinned to ``REPO_ROOT`` so go-task resolves include paths
    consistently, and ``PYTHONUTF8=1`` is exported so any downstream
    Python invocation under ``--help`` does not corrupt non-ASCII output
    on Windows.
    """
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    return subprocess.run(
        ["task", "-t", str(TASKFILE), *args],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )


def _list_all_task_names() -> list[str]:
    """Return every task name parsed from ``task --list-all`` stdout.

    ``task --list-all`` (and ``--list``) emits one row per task formatted
    as ``* <name>:    <desc>``; we strip the leading ``*`` marker and
    take the colon-terminated first column. This matches the format
    observed across go-task v3.x; if go-task changes the format in a
    future major bump the assertions will fail with a diagnostic
    pointing at the raw output rather than silently passing.
    """
    result = _run_task("--list-all")
    assert result.returncode == 0, (
        f"task --list-all exited non-zero:\n"
        f"stdout=\n{result.stdout}\n"
        f"stderr=\n{result.stderr}\n"
    )
    names: list[str] = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped.startswith("* "):
            continue
        # Format: "* <name>:    <desc>"
        rest = stripped[2:]
        # The task name is everything up to the FIRST colon followed by
        # whitespace -- task names themselves contain colons (e.g.
        # ``release:e2e``), so a naive ``split(":", 1)`` would truncate
        # them. We split on the rightmost colon-then-whitespace boundary
        # by scanning for ":" + " ".
        idx = rest.find(":  ")
        # Fallback to trailing-colon strip when there is no description column;
        # otherwise take everything up to the colon-space boundary.
        name = rest.rstrip(":") if idx == -1 else rest[:idx]
        names.append(name)
    return names


def test_canonical_release_task_names_installed() -> None:
    """All 4 canonical release task names appear in ``task --list-all``.

    This is the primary acceptance criterion from issue #718: each of
    ``release``, ``release:e2e``, ``release:publish``,
    ``release:rollback`` MUST be installed verbatim so the documented
    invocation in ``skills/deft-directive-release/SKILL.md`` works as
    written.
    """
    names = _list_all_task_names()
    missing = [n for n in CANONICAL_RELEASE_TASK_NAMES if n not in names]
    assert not missing, (
        f"task --list-all is missing canonical release names: {missing}\n"
        f"All names found:\n  " + "\n  ".join(names)
    )


def test_doubled_release_prefix_names_not_installed() -> None:
    """No ``release:release*`` doubled-prefix names appear post-#718.

    The doubled-prefix names were the broken wiring that motivated #718
    in the first place. After Option 2a (flatten by inlining), they MUST
    NOT appear as canonical task names. If any of them resurface, the
    namespace-flatten regressed and the guard test catches it before
    operators trip over ``Task "release" does not exist`` (exit 200) at
    SKILL Phase 2.
    """
    names = set(_list_all_task_names())
    offenders = [n for n in DOUBLED_PREFIX_NAMES if n in names]
    assert not offenders, (
        f"task --list-all contains forbidden doubled-prefix release names: "
        f"{offenders}. The #718 namespace flatten regressed -- the "
        f"`release: ./tasks/release.yml` include was likely re-added to "
        f"Taskfile.yml. Inline the 4 release tasks directly under "
        f"`tasks:` instead (see Taskfile.yml comment block above the "
        f"`release:` task definition)."
    )


def test_task_release_help_dispatches_end_to_end() -> None:
    """``task release -- --help`` exits 0 and prints argparse usage.

    Smoke test that proves the dispatch wiring (go-task -> uv run python
    -> scripts/release.py) works end-to-end without actually running the
    release pipeline. ``--help`` is a non-destructive recovery flag; the
    script's argparse layer handles it before any production-touching
    code path. Mirrors the pattern in tests/cli/test_release.py.

    Combined with the `--list-all` assertions above, this tests the full
    chain: name installed correctly AND the script behind it can be
    reached. A future regression that, e.g., introduces a typo in the
    inline `cmds:` script path will fail this test even if the task
    name itself is listed.
    """
    result = _run_task("release", "--", "--help", timeout=60.0)
    assert result.returncode == 0, (
        f"task release -- --help exited non-zero (dispatch broken?):\n"
        f"exit={result.returncode}\n"
        f"stdout=\n{result.stdout}\n"
        f"stderr=\n{result.stderr}\n"
    )
    # argparse `--help` prints "usage:" prefix; tolerant of either case
    # in case argparse formatting drifts in a future Python version.
    combined = (result.stdout + result.stderr).lower()
    assert "usage" in combined, (
        f"task release -- --help did not print argparse usage:\n"
        f"stdout=\n{result.stdout}\n"
        f"stderr=\n{result.stderr}\n"
    )
