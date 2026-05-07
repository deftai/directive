#!/usr/bin/env python3
"""migrate_preflight.py -- agent-side environment preflight for ``task migrate:vbrief`` (#793).

Reifies the prose contract documented in
``skills/deft-directive-setup/SKILL.md`` § Environment Preflight as a runnable
task so consumers running ``task migrate:vbrief`` directly (not via the
agent-driven setup skill) get the same three checks before any destructive
mutation runs.

Pure stdlib + ``subprocess``. Three-state exit (mirrors
``scripts/preflight_branch.py`` (#747) and ``scripts/preflight_implementation.py``
(#810) shape):

- ``0`` -- ready: every check PASS (or non-blocking WARN, e.g. dirty git tree).
- ``1`` -- not-ready: any check FAIL with an actionable remediation pointer.
- ``2`` -- config error: e.g. ``--project-root`` does not exist or is not a
  directory. Distinct from FAIL so callers can disambiguate "user can fix"
  from "calling environment is wrong".

The three checks are:

1. ``uv`` on PATH -- the migrator runs via ``uv run python``; absence is fatal.
2. v0.20+ layout -- ``<deft-root>/scripts/migrate_vbrief.py`` and
   ``<project>/vbrief/`` (with the ``schemas/`` subdirectory carried by the
   framework checkout) must exist; absence indicates an incomplete or
   pre-cutover checkout.
3. Git working-tree state -- a dirty tree is reported as WARN (the migrator's
   own dirty-tree guard fires with an actionable ``--force`` pointer; we do
   NOT block here so ``--dry-run`` previews remain usable). Non-git
   directories are also a WARN-level skip rather than a FAIL.

The intent is to surface every fixable blocker at once, with one line per
check, so operators can resolve them in a single pass instead of fighting
through three separate subprocess error tracebacks.

Soft-dep on #792 (``cmd_doctor`` uv-detection helper): a local
``_uv_available()`` is defined here for now to keep this PR self-contained;
when #792 lands a future small follow-up can DRY both surfaces against a
single shared helper.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple


class CheckResult(NamedTuple):
    """A single preflight check's outcome.

    Attributes:
        name: Short, stable identifier (e.g. ``uv``, ``layout``, ``git-clean``).
        status: One of ``PASS`` / ``WARN`` / ``FAIL``.
        message: Human-readable remediation pointer or status note.
    """

    name: str
    status: str  # "PASS" | "WARN" | "FAIL"
    message: str


# ---------------------------------------------------------------------------
# Individual check primitives
# ---------------------------------------------------------------------------


def _uv_available() -> bool:
    """Return True when the ``uv`` executable is resolvable on PATH.

    Local helper for #793; once #792 lands a shared ``cmd_doctor`` helper a
    follow-up should DRY this against a single source of truth (the brief's
    ``soft_dep_on: #792`` note).
    """
    return shutil.which("uv") is not None


def check_uv() -> CheckResult:
    """Verify ``uv`` is on PATH.

    The migrator dispatches via ``uv run python ...``; without ``uv`` the
    consumer hits a raw ``FileNotFoundError`` with no recovery pointer. This
    check is the actionable replacement for that traceback.
    """
    if _uv_available():
        return CheckResult("uv", "PASS", "uv is on PATH.")
    return CheckResult(
        "uv",
        "FAIL",
        "uv is not on PATH. Install from https://docs.astral.sh/uv/ and re-run.",
    )


def check_layout(deft_root: Path, project_root: Path) -> CheckResult:
    """Verify the framework checkout + project root carry the v0.20+ layout.

    Two pieces are required:

    1. ``<deft-root>/scripts/migrate_vbrief.py`` -- the migrator script the
       ``task migrate:vbrief`` target dispatches to. A missing file means the
       framework checkout is incomplete or came from a pre-v0.20 release.
    2. ``<project-root>/vbrief/`` -- the lifecycle root the migrator ingests
       into. It is created on first run for greenfield projects, but most
       v0.20+ projects already have it; existence here is informational
       (``WARN`` when missing, not ``FAIL``).

    The framework's ``vbrief/schemas/`` directory MUST exist on the deft root
    too (carried by the checkout, not regenerated) -- absence indicates a
    framework checkout problem and is FAIL.
    """
    migrator = deft_root / "scripts" / "migrate_vbrief.py"
    if not migrator.is_file():
        return CheckResult(
            "layout",
            "FAIL",
            (
                f"Migrator script missing at {migrator}. The framework checkout "
                "appears incomplete or pre-v0.20; refresh per "
                "deft/QUICK-START.md."
            ),
        )

    schemas_dir = deft_root / "vbrief" / "schemas"
    if not schemas_dir.is_dir():
        return CheckResult(
            "layout",
            "FAIL",
            (
                f"Framework schemas dir missing at {schemas_dir}. Refresh the "
                "deft checkout (see deft/QUICK-START.md)."
            ),
        )

    project_vbrief = project_root / "vbrief"
    if not project_vbrief.exists():
        return CheckResult(
            "layout",
            "WARN",
            (
                f"Project vbrief/ not present at {project_vbrief} -- migrator "
                "will create it on first run; this is expected for greenfield "
                "projects."
            ),
        )

    return CheckResult(
        "layout",
        "PASS",
        f"Framework migrator + schemas present; project vbrief/ at {project_vbrief}.",
    )


def check_git_clean(project_root: Path) -> CheckResult:
    """Surface git working-tree state non-blockingly.

    A dirty tree is reported as WARN (not FAIL) because:

    - ``task migrate:vbrief -- --dry-run`` is the recommended preview path and
      runs fine against a dirty tree.
    - The migrator itself has a dirty-tree guard with a ``--force`` recovery
      pointer (#497); double-blocking here would be redundant.

    A non-git directory is also a WARN: the gate has nothing to assert, but
    the operator deserves to know the standard recovery path won't apply.
    """
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return CheckResult(
            "git-clean",
            "WARN",
            (
                "git executable not on PATH; skipping working-tree check. "
                "Migrator's dirty-tree guard will still fire if applicable."
            ),
        )

    if proc.returncode != 0:
        # Non-zero typically means "not a git repository". Treat as WARN.
        return CheckResult(
            "git-clean",
            "WARN",
            (
                f"Not a git repository at {project_root} (git exit "
                f"{proc.returncode}); skipping working-tree check."
            ),
        )

    if proc.stdout.strip():
        return CheckResult(
            "git-clean",
            "WARN",
            (
                "Working tree is dirty. The migrator will refuse to run "
                "without --force; preview with `task migrate:vbrief -- "
                "--dry-run` first."
            ),
        )

    return CheckResult("git-clean", "PASS", "Working tree is clean.")


# ---------------------------------------------------------------------------
# Aggregate evaluation
# ---------------------------------------------------------------------------


def evaluate(deft_root: Path, project_root: Path) -> tuple[int, list[CheckResult]]:
    """Run every check and return ``(exit_code, results)``.

    Pure function -- separated from :func:`main` so tests can drive every
    state without ``capsys`` plumbing or env-var leak. Mirrors the
    ``scripts/preflight_branch.py::evaluate`` surface.

    Exit-code semantics:

    - ``0`` -- every check PASS or WARN.
    - ``1`` -- one or more checks FAIL.
    - ``2`` is reserved for the CLI :func:`main` to signal config error
      (e.g. ``--project-root`` does not exist); :func:`evaluate` itself never
      emits 2.
    """
    results = [
        check_uv(),
        check_layout(deft_root, project_root),
        check_git_clean(project_root),
    ]
    if any(r.status == "FAIL" for r in results):
        return 1, results
    return 0, results


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------


def _format_result(result: CheckResult) -> str:
    """Return the canonical ``CHECK <name>: <STATUS> <message>`` line."""
    return f"CHECK {result.name}: {result.status} {result.message}"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="migrate_preflight.py",
        description=(
            "Agent-side environment preflight for `task migrate:vbrief` "
            "(#793). Verifies uv on PATH, v0.20+ layout, and git working-tree "
            "state before destructive migration mutations."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help=(
            "Path to the consumer project root (default: current working "
            "directory)."
        ),
    )
    parser.add_argument(
        "--deft-root",
        default=None,
        help=(
            "Path to the deft framework checkout (default: parent of this "
            "script's directory)."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress PASS lines (FAIL/WARN still print).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # #814 + parity with scripts/preflight_branch.py: force UTF-8 stdout/stderr
    # at entry so the gate's status lines render under Windows cp1252 default
    # without a UnicodeEncodeError. Guarded by ``hasattr`` because reconfigure
    # is only available on TextIOWrapper streams; ``errors='replace'`` is the
    # belt-and-suspenders fallback per #814.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = _build_parser()
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        print(
            f"ERROR: --project-root does not exist or is not a directory: "
            f"{project_root}",
            file=sys.stderr,
        )
        return 2

    if args.deft_root is None:
        # Default: the directory containing scripts/ (this file's parent's
        # parent). Mirrors the lookup pattern used by other framework scripts
        # invoked via ``uv run python <script>`` from a Taskfile target.
        deft_root = Path(__file__).resolve().parent.parent
    else:
        deft_root = Path(args.deft_root).resolve()
        if not deft_root.exists() or not deft_root.is_dir():
            print(
                f"ERROR: --deft-root does not exist or is not a directory: "
                f"{deft_root}",
                file=sys.stderr,
            )
            return 2

    code, results = evaluate(deft_root, project_root)

    for result in results:
        if args.quiet and result.status == "PASS":
            continue
        stream = sys.stderr if result.status == "FAIL" else sys.stdout
        print(_format_result(result), file=stream)

    if code != 0:
        print(
            "migrate:preflight FAILED -- resolve the FAIL line(s) above before "
            "re-running `task migrate:vbrief`.",
            file=sys.stderr,
        )
    return code


if __name__ == "__main__":
    sys.exit(main())
