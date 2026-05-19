#!/usr/bin/env python3
"""triage_smoketest.py -- end-to-end synthetic test for the triage cache surface (#1146 / N6).

`task triage:smoketest` runs the full triage lifecycle against the
hermetic ``tests/fixtures/triage_smoketest/`` fixture and asserts the
expected audit-log shape at every stage. Exits 0 on PASS, 1 on the first
failing assertion (named).

Stages (in order; the per-stage asserts live in
``scripts/_triage_smoketest_stages.py`` to keep this driver under the
1000-line MUST cap)::

    1. triage:bootstrap + auto-classify (D10 / #1129)
    2. triage:audit decision counts     (D11 / #1128)
    3. triage:queue ranking determinism (D11 / #1128)
    4. triage:defer with resume-on      (D3  / #1123)
    5. triage:audit --evaluate-resume   (D3  / #1123)
    6. scope:promote (D18 #1136 fallback -- existing `scope:promote <file>` form)
    7. scope:demote                     (D1  / #1121)
    8. scope:undo (graceful skip when D15 / #1134 has not landed)
    9. triage:summary bounded output    (D2  / #1122)

Flags::

    --verbose         Print each assertion as it runs to stderr.
    --keep-tempdir    Don't clean up the temp working dir on exit (debug).
    --cache-only      Skip vBRIEF-mutating steps (6 / 7 / 8) for fast smoketest.

JSON-formatted assert log written to
``tests/fixtures/triage_smoketest/last_run.json`` (gitignored). Exit 0
on PASS; exit 1 on first failure with the failing assertion named.

Refs:

* Umbrella: #1119
* This deliverable: #1146 (N6)
* Smoketested verbs: D10 / #1129, D11 / #1128, D3 / #1123, D1 / #1121, D2 / #1122
* Parallel: D15 / #1134 (``scope:undo``)
* Future integration: D18 / #1136 (``scope:promote --from-issue``)
"""

from __future__ import annotations

import argparse
import contextlib
import json
import shutil
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Resolve framework + scripts directories first so we can import sibling
# modules (cache, _triage_smoketest_stages, ...). The smoketest lives at
# ``deft/scripts/triage_smoketest.py``; ``_DEFT_ROOT`` is the framework
# root one level up.
_SCRIPTS_DIR = Path(__file__).resolve().parent
_DEFT_ROOT = _SCRIPTS_DIR.parent
sys.path.insert(0, str(_SCRIPTS_DIR))

# UTF-8 self-reconfigure for Windows cp1252 default.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

#: Default fixture-root location relative to the framework root.
DEFAULT_FIXTURE_REL: str = "tests/fixtures/triage_smoketest"

#: Path (relative to the fixture root) where the assert log is dumped.
LAST_RUN_FILENAME: str = "last_run.json"

#: Total assertion stage count -- used for the ``[i/N]`` progress prefix.
TOTAL_STAGES: int = 9

#: Stage labels. Index 1..9 maps to the issue body's demoability block.
STAGE_LABELS: tuple[str, ...] = (
    "",  # index 0 unused (stages are 1-based)
    "bootstrap + auto-classify",
    "audit decision counts",
    "queue ranking determinism",
    "defer with resume-on",
    "evaluate-resume marker",
    "scope:promote (D18 fallback)",
    "scope:demote single-file",
    "scope:undo idempotency",
    "triage:summary bounded output",
)


# ---------------------------------------------------------------------------
# Assertion bookkeeping
# ---------------------------------------------------------------------------


class SmoketestError(RuntimeError):
    """Raised when an assertion fails. Carries the stage index + name."""

    def __init__(
        self, stage: int, name: str, expected: Any, actual: Any, cause: str
    ) -> None:
        super().__init__(
            f"[{stage}/{TOTAL_STAGES}] {name} FAIL: expected={expected!r} "
            f"actual={actual!r} cause={cause}"
        )
        self.stage = stage
        self.name = name
        self.expected = expected
        self.actual = actual
        self.cause = cause


class AssertLog:
    """Accumulator for per-assertion outcomes; rendered to last_run.json."""

    def __init__(self, *, verbose: bool) -> None:
        self.records: list[dict[str, Any]] = []
        self.verbose = verbose

    def _emit(self, stage: int, suffix: str) -> None:
        label = STAGE_LABELS[stage] if 1 <= stage < len(STAGE_LABELS) else "stage"
        print(
            f"[{stage}/{TOTAL_STAGES}] {label} ".ljust(56, ".") + f" {suffix}",
            file=sys.stderr,
        )

    def passed(self, stage: int, name: str, detail: str = "") -> None:
        self.records.append(
            {"stage": stage, "name": name, "status": "PASS", "detail": detail}
        )
        if self.verbose:
            self._emit(stage, "PASS")

    def fail(
        self, stage: int, name: str, *, expected: Any, actual: Any, cause: str
    ) -> SmoketestError:
        self.records.append(
            {
                "stage": stage,
                "name": name,
                "status": "FAIL",
                "expected": expected,
                "actual": actual,
                "cause": cause,
            }
        )
        return SmoketestError(stage, name, expected, actual, cause)

    def skipped(self, stage: int, name: str, reason: str) -> None:
        self.records.append(
            {"stage": stage, "name": name, "status": "SKIP", "reason": reason}
        )
        if self.verbose:
            self._emit(stage, f"SKIP ({reason})")

    def write_json(self, path: Path, *, exit_code: int, fixture_repo: str) -> None:
        payload = {
            "schema": "deft.triage.smoketest.v1",
            "fixture_repo": fixture_repo,
            "emitted_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "exit_code": exit_code,
            "stage_count": TOTAL_STAGES,
            "records": self.records,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )


# ---------------------------------------------------------------------------
# Fixture handling -- copy template + render the .deft-cache layout
# ---------------------------------------------------------------------------


def _copy_fixture_to_tmp(fixture_root: Path, tmp_root: Path) -> Path:
    """Copy the on-disk fixture (vbrief/, PROJECT-DEFINITION) into ``tmp_root``."""
    project = tmp_root
    project.mkdir(parents=True, exist_ok=True)

    src_pd = fixture_root / "PROJECT-DEFINITION.vbrief.json"
    (project / "vbrief").mkdir(parents=True, exist_ok=True)
    shutil.copy(src_pd, project / "vbrief" / "PROJECT-DEFINITION.vbrief.json")

    src_vbrief = fixture_root / "vbrief"
    for sub in ("active", "proposed", "pending", "completed", "cancelled"):
        src_dir = src_vbrief / sub
        dst_dir = project / "vbrief" / sub
        dst_dir.mkdir(parents=True, exist_ok=True)
        if src_dir.is_dir():
            for vfile in src_dir.glob("*.vbrief.json"):
                shutil.copy(vfile, dst_dir / vfile.name)

    (project / "vbrief" / ".eval").mkdir(parents=True, exist_ok=True)
    return project


def _render_cache(project_root: Path, issues_spec: dict[str, Any]) -> None:
    """Populate ``<project>/.deft-cache/github-issue/<owner>/<repo>/<N>/`` from spec."""
    from cache import cache_put  # local import: deferred until tmpdir is ready

    now_dt = datetime.fromisoformat(issues_spec["now_iso"].replace("Z", "+00:00"))
    repo = issues_spec["repo"]
    cache_root = project_root / ".deft-cache"

    for issue in issues_spec["issues"]:
        n = int(issue["number"])
        raw = {
            "number": n,
            "title": issue["title"],
            "state": issue.get("state", "open"),
            "labels": [{"name": label} for label in issue.get("labels", [])],
            "body": issue.get("body", ""),
            "updated_at": issue.get("updated_at", issues_spec["now_iso"]),
            "created_at": issue.get("created_at", issues_spec["now_iso"]),
            "url": f"https://api.github.com/repos/{repo}/issues/{n}",
            "html_url": f"https://github.com/{repo}/issues/{n}",
        }
        cache_put(
            "github-issue",
            f"{repo}/{n}",
            raw,
            cache_root=cache_root,
            fetched_at=now_dt,
        )


# ---------------------------------------------------------------------------
# Top-level orchestration
# ---------------------------------------------------------------------------


def run_smoketest(
    fixture_root: Path,
    *,
    verbose: bool = False,
    keep_tempdir: bool = False,
    cache_only: bool = False,
) -> int:
    """Execute the full 9-stage smoketest and return the exit code."""
    # Delegated per-stage helpers live in a sibling module so this driver
    # stays under the 1000-line cap.
    from _triage_smoketest_stages import (
        FIXTURE_REPO,
        stage_audit_counts,
        stage_bootstrap_and_classify,
        stage_defer_resume_on,
        stage_evaluate_resume,
        stage_queue_determinism,
        stage_scope_demote,
        stage_scope_promote,
        stage_scope_undo,
        stage_triage_summary,
    )

    last_run_path = fixture_root / LAST_RUN_FILENAME
    log = AssertLog(verbose=verbose)

    issues_spec_path = fixture_root / "issues.json"
    if not issues_spec_path.is_file():
        sys.stderr.write(
            f"[triage:smoketest] FAIL: fixture issues.json not found at "
            f"{issues_spec_path}\n"
        )
        log.records.append(
            {
                "stage": 0,
                "name": "fixture-load",
                "status": "FAIL",
                "cause": f"issues.json missing at {issues_spec_path}",
            }
        )
        log.write_json(last_run_path, exit_code=1, fixture_repo=FIXTURE_REPO)
        return 1
    issues_spec = json.loads(issues_spec_path.read_text(encoding="utf-8"))

    tmp_dir = Path(tempfile.mkdtemp(prefix="deft-triage-smoketest-"))
    try:
        project_root = _copy_fixture_to_tmp(fixture_root, tmp_dir / "project")
        _render_cache(project_root, issues_spec)

        # Stages 1-5: cache + audit-log surface (always runs).
        stage_bootstrap_and_classify(project_root, issues_spec, log)
        stage_audit_counts(project_root, log)
        stage_queue_determinism(project_root, log)
        prior_defer_id = stage_defer_resume_on(project_root, log)
        stage_evaluate_resume(project_root, prior_defer_id, log)

        # Stages 6-8: vBRIEF-mutating (skip block under --cache-only).
        if cache_only:
            for stage in (6, 7, 8):
                label = (
                    STAGE_LABELS[stage] if stage < len(STAGE_LABELS) else f"stage-{stage}"
                )
                log.skipped(stage, label, reason="--cache-only")
        else:
            pending = stage_scope_promote(project_root, log)
            stage_scope_demote(project_root, pending, log)
            stage_scope_undo(project_root, log)

        # Stage 9: summary (always runs).
        stage_triage_summary(project_root, log)

        log.write_json(last_run_path, exit_code=0, fixture_repo=FIXTURE_REPO)
        if verbose:
            print("[triage:smoketest] exit 0", file=sys.stderr)
        return 0

    except SmoketestError as failure:
        print(str(failure), file=sys.stderr)
        log.write_json(last_run_path, exit_code=1, fixture_repo=FIXTURE_REPO)
        return 1
    finally:
        if keep_tempdir:
            sys.stderr.write(
                f"[triage:smoketest] --keep-tempdir: temp working dir preserved "
                f"at {tmp_dir}\n"
            )
        else:
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_smoketest.py",
        description=(
            "End-to-end synthetic test of the cache-as-operator-working-set "
            "surface (#1146 / N6). Runs the full triage lifecycle against the "
            "tests/fixtures/triage_smoketest/ fixture and asserts the expected "
            "audit-log shape at every stage."
        ),
    )
    parser.add_argument(
        "--fixture",
        default=str(_DEFT_ROOT / DEFAULT_FIXTURE_REL),
        help=(
            "Path to the fixture root (default: "
            f"<framework-root>/{DEFAULT_FIXTURE_REL}). Tests override."
        ),
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print each assertion as it runs to stderr.",
    )
    parser.add_argument(
        "--keep-tempdir",
        action="store_true",
        dest="keep_tempdir",
        help="Don't clean up the temp working dir on exit (debug).",
    )
    parser.add_argument(
        "--cache-only",
        action="store_true",
        dest="cache_only",
        help=(
            "Skip vBRIEF-mutating steps (6 / 7 / 8) -- exercises only the "
            "cache + audit-log surface for fast smoketests."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_smoketest", argv)
    if rc is not None:
        return rc
    parser = _build_parser()
    args = parser.parse_args(argv)
    fixture_root = Path(args.fixture).resolve()
    if not fixture_root.is_dir():
        sys.stderr.write(
            f"[triage:smoketest] FAIL: fixture root {fixture_root} does not "
            "exist or is not a directory.\n"
        )
        return 1
    return run_smoketest(
        fixture_root,
        verbose=args.verbose,
        keep_tempdir=args.keep_tempdir,
        cache_only=args.cache_only,
    )


if __name__ == "__main__":
    raise SystemExit(main())
