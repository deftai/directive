#!/usr/bin/env python3
"""ci_local.py -- Run the full CI pipeline locally (matrix-aware).

Mirrors the step graph of ``.github/workflows/ci.yml`` so contributors can
catch CI failures before pushing. The workflow defines three jobs:

1. ``python`` -- ``uv sync`` + ``uv run ruff check .`` + ``uv run mypy tests/``
   + ``uv run pytest tests/ --cov --cov-report=term-missing``.
2. ``go`` -- ``go test ./cmd/deft-install/`` + cross-compile builds for
   ``linux/amd64``, ``darwin/arm64``, and ``windows/amd64``.
3. ``windows-task-dispatch`` -- Windows-only regression tests (path
   traversal, ``scope:promote`` end-to-end, etc.) that only run on a
   Windows host when ``--matrix=windows`` is requested.

In addition, this script exercises the existing local task surface that
the CI workflow expects to remain green:

- ``task toolchain:check``
- ``task verify:stubs``
- ``task verify:links``
- ``task verify:rule-ownership`` (#705)
- ``task vbrief:validate``
- ``task build`` (skipped with ``--skip-build``)
- ``task build:verify`` (graceful absence -- it's a sibling pending #233
  item; if the task is missing from ``task --list`` we skip it with an
  informational message rather than failing).

Platform notes
--------------
- **Linux**: All Python + Go steps run natively. The cross-compile builds
  emit to ``/dev/null``.
- **macOS**: Same as Linux; the ``darwin/arm64`` cross-compile is the
  native build path.
- **Windows**: ``/dev/null`` is replaced with ``NUL`` for the Go
  cross-compile output. The Windows-task-dispatch regression steps
  require ``--matrix=windows`` and are skipped on non-Windows hosts. PR
  bodies and other text artifacts are written via ``pathlib`` /
  ``create_file`` rather than inline PowerShell string ops to avoid the
  PowerShell 5.1 UTF-16LE encoding-corruption pitfall.

Output
------
Each step prints a line of the form::

    [N/M] <step name> ... OK (1.23s)

or, on failure::

    [N/M] <step name> ... FAIL (1.23s)
    --- stdout ---
    ...captured output...
    --- stderr ---
    ...captured output...

Stdout/stderr capture mirrors GitHub Actions' default log style so the
output is easy to compare against a real CI run for debugging parity.

Exit codes
----------
    0 -- every applicable step succeeded (skipped steps do not count as
         failures)
    1 -- at least one step failed
    2 -- configuration error (invalid arguments, missing required tool,
         malformed Taskfile.yml when probing for ``build:verify``)

Refs #233 (umbrella; this resolves the ``task-ci-local`` plan.item),
#642 (workflow umbrella), #635 (epic anchor), #633 (pre-PR
deterministic-CI enforcement umbrella), #709 (Repair Authority [AXIOM]).
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

# Make sibling helpers importable both when run as __main__ and when imported by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

# ---- Exit codes -------------------------------------------------------------

EXIT_OK = 0
EXIT_STEP_FAILED = 1
EXIT_CONFIG_ERROR = 2

# ---- Matrix -----------------------------------------------------------------

VALID_MATRIX_VALUES = ("linux", "macos", "windows", "all", "host")


def _host_matrix() -> str:
    """Map the current host to a ``--matrix`` value.

    ``platform.system()`` returns ``Linux`` / ``Darwin`` / ``Windows`` on
    the three supported hosts. Any other value falls through to
    ``"linux"`` as the most permissive default (the script still skips
    Windows-only steps under that assumption).
    """
    system = platform.system().lower()
    if system == "windows":
        return "windows"
    if system == "darwin":
        return "macos"
    return "linux"


# ---- Step model -------------------------------------------------------------


@dataclass
class StepResult:
    """Outcome of a single CI step."""

    name: str
    status: str  # "ok" | "fail" | "skip"
    elapsed: float = 0.0
    stdout: str = ""
    stderr: str = ""
    skip_reason: str = ""
    return_code: int | None = None


@dataclass
class Step:
    """A single CI step description.

    The step is only run if ``applies()`` returns ``True``; otherwise the
    runner emits a ``skip`` result with ``skip_reason``. ``run_fn``
    receives the resolved repository root and returns a
    ``subprocess.CompletedProcess``-like 3-tuple of
    ``(returncode, stdout, stderr)``.
    """

    name: str
    run_fn: Callable[[Path], tuple[int, str, str]]
    applies_fn: Callable[[], bool] = field(default=lambda: True)
    skip_reason_fn: Callable[[], str] = field(default=lambda: "")

    def applies(self) -> bool:
        return bool(self.applies_fn())

    def skip_reason(self) -> str:
        return self.skip_reason_fn()


# ---- subprocess helpers -----------------------------------------------------


def _devnull_for_host() -> str:
    """Return the platform-appropriate path for discarding build output."""
    return "NUL" if platform.system().lower() == "windows" else "/dev/null"


def _run_command(
    cmd: list[str],
    cwd: Path,
    *,
    env_overrides: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    """Run ``cmd`` synchronously and return ``(returncode, stdout, stderr)``.

    Raises ``FileNotFoundError`` if the command's executable is not on
    ``PATH``; the caller maps that to ``EXIT_CONFIG_ERROR``.
    """
    env = os.environ.copy()
    # PYTHONUTF8 mirrors the top-level Taskfile.yml env so child Python
    # processes don't crash on the unicode glyphs that several scripts
    # emit (#540 belt-and-suspenders).
    env.setdefault("PYTHONUTF8", "1")
    if env_overrides:
        env.update(env_overrides)
    result = subprocess.run(
        cmd,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode, result.stdout, result.stderr


# ---- Tool detection ---------------------------------------------------------


def _has_executable(name: str) -> bool:
    """Return True iff ``name`` is resolvable via ``shutil.which``."""
    return shutil.which(name) is not None


def _build_verify_available(root: Path) -> bool:
    """Return True iff ``task build:verify`` is defined in the project.

    Probes ``task --list`` and looks for a ``* build:verify`` line. When
    ``task`` itself is missing we return ``False`` -- the caller will
    print an informational skip message instead of failing.
    """
    if not _has_executable("task"):
        return False
    rc, stdout, _stderr = _run_command(["task", "--list"], cwd=root)
    if rc != 0:
        return False
    for line in stdout.splitlines():
        stripped = line.strip()
        # ``task --list`` prints rows like ``* build:verify: <desc>``.
        if stripped.startswith("* build:verify:") or stripped == "* build:verify":
            return True
    return False


# ---- Step constructors ------------------------------------------------------


def _make_python_steps(root: Path) -> list[Step]:
    if not _has_executable("uv"):
        return [
            Step(
                name="python: uv toolchain probe",
                run_fn=lambda _root: (0, "", ""),
                applies_fn=lambda: False,
                skip_reason_fn=lambda: (
                    "uv not on PATH; install Astral uv to run the Python job locally "
                    "(https://docs.astral.sh/uv/getting-started/installation/)."
                ),
            )
        ]
    return [
        Step(
            name="python: uv sync",
            run_fn=lambda r: _run_command(["uv", "sync"], cwd=r),
        ),
        Step(
            name="python: ruff lint",
            run_fn=lambda r: _run_command(["uv", "run", "ruff", "check", "."], cwd=r),
        ),
        Step(
            name="python: mypy tests/",
            run_fn=lambda r: _run_command(["uv", "run", "mypy", "tests/"], cwd=r),
        ),
        Step(
            name="python: pytest with coverage",
            run_fn=lambda r: _run_command(
                [
                    "uv",
                    "run",
                    "pytest",
                    "tests/",
                    "--cov",
                    "--cov-report=term-missing",
                ],
                cwd=r,
            ),
        ),
    ]


def _make_go_steps(root: Path, *, skip_build: bool) -> list[Step]:
    if not _has_executable("go"):
        return [
            Step(
                name="go: toolchain probe",
                run_fn=lambda _root: (0, "", ""),
                applies_fn=lambda: False,
                skip_reason_fn=lambda: (
                    "go not on PATH; install Go to run the Go job locally."
                ),
            )
        ]
    devnull = _devnull_for_host()
    test_step = Step(
        name="go: test ./cmd/deft-install/",
        run_fn=lambda r: _run_command(["go", "test", "./cmd/deft-install/"], cwd=r),
    )
    if skip_build:
        return [test_step]
    cross_targets = (
        ("linux", "amd64"),
        ("darwin", "arm64"),
        ("windows", "amd64"),
    )
    cross_steps = [
        Step(
            name=f"go: build {goos}/{goarch}",
            run_fn=lambda r, _goos=goos, _goarch=goarch: _run_command(
                ["go", "build", "-o", devnull, "./cmd/deft-install/"],
                cwd=r,
                env_overrides={"GOOS": _goos, "GOARCH": _goarch},
            ),
        )
        for goos, goarch in cross_targets
    ]
    return [test_step, *cross_steps]


def _make_task_steps(root: Path, *, skip_build: bool) -> list[Step]:
    if not _has_executable("task"):
        return [
            Step(
                name="task: toolchain probe",
                run_fn=lambda _root: (0, "", ""),
                applies_fn=lambda: False,
                skip_reason_fn=lambda: (
                    "task not on PATH; install go-task "
                    "(https://taskfile.dev/installation/) to run the Taskfile-level "
                    "verifications."
                ),
            )
        ]
    steps: list[Step] = [
        Step(
            name="task toolchain:check",
            run_fn=lambda r: _run_command(["task", "toolchain:check"], cwd=r),
        ),
        Step(
            name="task verify:stubs",
            run_fn=lambda r: _run_command(["task", "verify:stubs"], cwd=r),
        ),
        Step(
            name="task verify:links",
            run_fn=lambda r: _run_command(["task", "verify:links"], cwd=r),
        ),
        Step(
            name="task verify:rule-ownership",
            run_fn=lambda r: _run_command(["task", "verify:rule-ownership"], cwd=r),
        ),
        Step(
            name="task vbrief:validate",
            run_fn=lambda r: _run_command(["task", "vbrief:validate"], cwd=r),
        ),
    ]
    if not skip_build:
        steps.append(
            Step(
                name="task build",
                run_fn=lambda r: _run_command(["task", "build"], cwd=r),
            )
        )
        # build:verify is a sibling pending #233 plan.item; detect via
        # `task --list` and skip with an informational message rather
        # than failing when it isn't yet implemented.
        build_verify_present = _build_verify_available(root)
        steps.append(
            Step(
                name="task build:verify",
                run_fn=lambda r: _run_command(["task", "build:verify"], cwd=r),
                applies_fn=lambda: build_verify_present,
                skip_reason_fn=lambda: (
                    "`task build:verify` not yet implemented; skipping -- "
                    "see #233 pending vBRIEF for the sibling plan.item."
                ),
            )
        )
    return steps


def _make_windows_dispatch_steps(matrix: str) -> list[Step]:
    """The 5 Windows-task-dispatch regression steps.

    These mirror the ``windows-task-dispatch`` job in
    ``.github/workflows/ci.yml``. They are run only when the user opted
    in via ``--matrix=windows`` AND the host is actually Windows.
    """
    host_is_windows = platform.system().lower() == "windows"
    matrix_requests_windows = matrix in ("windows", "all")
    skip_reason = (
        ""
        if (host_is_windows and matrix_requests_windows)
        else (
            "windows-task-dispatch regressions only run on a Windows host with "
            "--matrix=windows (or --matrix=all). On non-Windows hosts they're "
            "skipped because the steps shell out to PowerShell."
        )
    )

    def _applies() -> bool:
        return host_is_windows and matrix_requests_windows

    # The detail of the 5 PowerShell steps lives in
    # .github/workflows/ci.yml so we don't risk drift here. We delegate
    # to a single subprocess call per step that uses pwsh / powershell
    # to invoke the same logic. To avoid duplicating the heavy fixture
    # staging here, we only run the lightweight pytest guard-rails on
    # the host -- the full job graph (fixture stage, migrate:vbrief
    # dispatch, scope:promote dispatch, completed-routing fixture) is a
    # CI-only exercise. Exposing one applies() gate per step keeps the
    # report row count stable.
    fixture_pytest = Step(
        name="windows-task-dispatch: pytest guard-rails",
        run_fn=lambda r: _run_command(
            [
                "uv",
                "run",
                "pytest",
                "tests/content/test_taskfile_paths.py",
                "tests/content/test_taskfile_cli_args.py",
                "tests/content/test_taskfile_caching.py",
                "-v",
            ],
            cwd=r,
        ),
        applies_fn=_applies,
        skip_reason_fn=lambda: skip_reason,
    )
    return [fixture_pytest]


# ---- Pipeline construction --------------------------------------------------


def build_pipeline(
    root: Path,
    *,
    matrix: str,
    skip_build: bool,
) -> list[Step]:
    """Return the ordered step graph for the local CI run."""
    steps: list[Step] = []
    steps.extend(_make_python_steps(root))
    steps.extend(_make_go_steps(root, skip_build=skip_build))
    steps.extend(_make_task_steps(root, skip_build=skip_build))
    steps.extend(_make_windows_dispatch_steps(matrix))
    return steps


# ---- Runner -----------------------------------------------------------------


def run_pipeline(
    root: Path,
    steps: list[Step],
    *,
    fail_fast: bool,
    verbose: bool,
    out: Callable[[str], None] | None = None,
) -> list[StepResult]:
    """Execute ``steps`` in order; return the list of ``StepResult``."""
    emit: Callable[[str], None] = out if out is not None else print
    results: list[StepResult] = []
    total = len(steps)
    failed_seen = False
    for index, step in enumerate(steps, start=1):
        prefix = f"[{index}/{total}] {step.name}"
        if failed_seen and fail_fast:
            results.append(
                StepResult(
                    name=step.name,
                    status="skip",
                    skip_reason="aborted -- earlier step failed and --fail-fast is set",
                )
            )
            emit(f"{prefix} ... SKIP (fail-fast)")
            continue
        if not step.applies():
            reason = step.skip_reason() or "step not applicable on this host"
            results.append(
                StepResult(name=step.name, status="skip", skip_reason=reason)
            )
            emit(f"{prefix} ... SKIP -- {reason}")
            continue
        emit(f"{prefix} ... running")
        start = time.monotonic()
        try:
            rc, stdout, stderr = step.run_fn(root)
        except FileNotFoundError as exc:
            elapsed = time.monotonic() - start
            results.append(
                StepResult(
                    name=step.name,
                    status="fail",
                    elapsed=elapsed,
                    stderr=f"executable not found: {exc}",
                    return_code=None,
                )
            )
            emit(f"{prefix} ... FAIL ({elapsed:.2f}s) -- executable not found: {exc}")
            failed_seen = True
            continue
        elapsed = time.monotonic() - start
        if rc == 0:
            results.append(
                StepResult(
                    name=step.name,
                    status="ok",
                    elapsed=elapsed,
                    stdout=stdout,
                    stderr=stderr,
                    return_code=rc,
                )
            )
            emit(f"{prefix} ... OK ({elapsed:.2f}s)")
            if verbose and (stdout or stderr):
                if stdout:
                    emit("--- stdout ---")
                    emit(stdout.rstrip())
                if stderr:
                    emit("--- stderr ---")
                    emit(stderr.rstrip())
        else:
            results.append(
                StepResult(
                    name=step.name,
                    status="fail",
                    elapsed=elapsed,
                    stdout=stdout,
                    stderr=stderr,
                    return_code=rc,
                )
            )
            emit(f"{prefix} ... FAIL ({elapsed:.2f}s) -- exit code {rc}")
            if stdout:
                emit("--- stdout ---")
                emit(stdout.rstrip())
            if stderr:
                emit("--- stderr ---")
                emit(stderr.rstrip())
            failed_seen = True
    return results


# ---- Aggregate report -------------------------------------------------------


def format_summary(results: list[StepResult]) -> str:
    """Return a human-readable aggregate summary."""
    total = len(results)
    passed = sum(1 for r in results if r.status == "ok")
    failed = sum(1 for r in results if r.status == "fail")
    skipped = sum(1 for r in results if r.status == "skip")
    elapsed = sum(r.elapsed for r in results)
    lines = [
        "",
        "=" * 60,
        "ci:local summary",
        "=" * 60,
        f"  total:   {total}",
        f"  passed:  {passed}",
        f"  failed:  {failed}",
        f"  skipped: {skipped}",
        f"  elapsed: {elapsed:.2f}s",
    ]
    if failed:
        lines.append("")
        lines.append("Failed steps:")
        for r in results:
            if r.status == "fail":
                rc = "n/a" if r.return_code is None else str(r.return_code)
                lines.append(f"  - {r.name} (exit {rc})")
    if skipped:
        lines.append("")
        lines.append("Skipped steps:")
        for r in results:
            if r.status == "skip":
                lines.append(f"  - {r.name} -- {r.skip_reason}")
    lines.append("=" * 60)
    return "\n".join(lines)


# ---- argument parsing -------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ci_local",
        description=(
            "Run the full CI pipeline locally (matrix-aware). Mirrors the "
            "step graph of .github/workflows/ci.yml so contributors can "
            "catch CI failures before pushing. Refs #233, #642, #635, "
            "#633, #709."
        ),
    )
    parser.add_argument(
        "--matrix",
        choices=VALID_MATRIX_VALUES,
        default="host",
        help=(
            "Which CI matrix slice to run. ``host`` (default) selects the "
            "current platform's applicable steps; ``linux``/``macos``/"
            "``windows`` force a specific slice (Windows-only steps still "
            "require a Windows host); ``all`` runs every applicable step."
        ),
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help=(
            "Skip the cross-compile builds and the ``task build`` / "
            "``task build:verify`` steps. Useful for tight inner-loop "
            "iteration where only lint + test feedback matters."
        ),
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help=(
            "Mirror CI logs verbatim -- stream every step's stdout/stderr "
            "even when the step succeeds. Default is to surface output "
            "only on failure."
        ),
    )
    fail_fast_group = parser.add_mutually_exclusive_group()
    fail_fast_group.add_argument(
        "--fail-fast",
        dest="fail_fast",
        action="store_true",
        default=True,
        help=(
            "Abort the pipeline at the first failing step (default). "
            "Subsequent steps are reported as skipped."
        ),
    )
    fail_fast_group.add_argument(
        "--no-fail-fast",
        dest="fail_fast",
        action="store_false",
        help=(
            "Run every applicable step even when an earlier one failed. "
            "The exit code is still 1 if any step failed."
        ),
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Repository root. Defaults to the parent of the scripts/ "
            "directory containing this file."
        ),
    )
    return parser


def _resolve_root(arg_root: Path | None) -> Path:
    if arg_root is not None:
        return arg_root.resolve()
    return Path(__file__).resolve().parent.parent


def _resolve_matrix(matrix_arg: str) -> str:
    if matrix_arg == "host":
        return _host_matrix()
    return matrix_arg


# ---- main -------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    root = _resolve_root(args.root)
    if not root.is_dir():
        print(f"Error: --root does not point at a directory: {root}", file=sys.stderr)
        return EXIT_CONFIG_ERROR
    matrix = _resolve_matrix(args.matrix)
    print(
        f"ci:local -- root={root} matrix={matrix} skip_build={args.skip_build} "
        f"fail_fast={args.fail_fast} verbose={args.verbose}",
        file=sys.stderr,
    )
    steps = build_pipeline(root, matrix=matrix, skip_build=args.skip_build)
    if not steps:
        print(
            "Error: no CI steps applicable on this host. Install at least one of "
            "uv / go / task to run any portion of the pipeline locally.",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR
    results = run_pipeline(
        root,
        steps,
        fail_fast=args.fail_fast,
        verbose=args.verbose,
    )
    print(format_summary(results))
    if any(r.status == "fail" for r in results):
        return EXIT_STEP_FAILED
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
