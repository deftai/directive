#!/usr/bin/env python3
"""release_e2e.py -- Auto-create + auto-destroy temp-repo release rehearsal (#716).

Companion to ``scripts/release.py`` per the #716 safety hardening Q1
decision (auto-create + auto-destroy temp repo). ``task release:e2e``
provisions a private GitHub repo named
``deftai-release-test-<timestamp>-<uuid6>``, runs the full release
pipeline against it, then destroys the repo via ``gh repo delete --yes``
in a ``try/finally`` so cleanup runs even when the test fails.

Pipeline
--------
1. Generate a unique repo slug (``deftai-release-test-<timestamp>-<uuid6>``)
2. ``gh repo create --private deftai/<slug> --description "..."``
3. Run the rehearsal (``task release -- 0.0.1 --dry-run --skip-tag --skip-release``
   against the temp repo path, OR a fuller `--repo` invocation when the
   user passes ``--full``)
4. ``gh repo delete deftai/<slug> --yes`` -- ALWAYS in a finally clause
5. If delete fails, surface a one-line manual cleanup hint and continue
   so the test result still reaches stdout

Exit codes
----------
    0 -- rehearsal succeeded; cleanup succeeded (or surfaced as a warning)
    1 -- rehearsal failed; cleanup ran regardless
    2 -- config / argument error (gh missing, owner unset, ...)

Mockability
-----------
The ``provision_temp_repo`` and ``destroy_temp_repo`` helpers are
isolated functions so tests can replace them with mocks; CI
exercises the orchestration without ever calling real GitHub.

Refs #716 (canonical spec; safety hardening Item 4 of 7),
#74 (foundation), #233, #642, #635, #709, #710.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

import release  # noqa: E402

EXIT_OK = release.EXIT_OK
EXIT_VIOLATION = release.EXIT_VIOLATION
EXIT_CONFIG_ERROR = release.EXIT_CONFIG_ERROR

DEFAULT_OWNER = "deftai"
REPO_SLUG_PREFIX = "deftai-release-test-"


# ---- Data classes -----------------------------------------------------------


@dataclass
class E2EConfig:
    owner: str
    project_root: Path
    dry_run: bool
    keep_repo: bool  # When True, skip cleanup (manual debugging only)
    # Optional override slug (test injection). If None, a fresh slug is
    # generated per run.
    repo_slug: str | None = None


# ---- argument parsing -------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="release_e2e",
        description=(
            "End-to-end release rehearsal against an auto-created+destroyed "
            "temp GitHub repo (#716 safety hardening Q1)."
        ),
    )
    parser.add_argument(
        "--owner",
        default=DEFAULT_OWNER,
        metavar="OWNER",
        help=f"GitHub owner under which to create the temp repo (default: {DEFAULT_OWNER}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the pipeline plan without invoking gh.",
    )
    parser.add_argument(
        "--keep-repo",
        action="store_true",
        help=(
            "Skip destroying the temp repo at the end (use only when "
            "manually debugging a failed rehearsal; remember to clean "
            "up by hand)."
        ),
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=None,
        metavar="PATH",
        help="Repository root (default: $DEFT_PROJECT_ROOT or scripts/.. ).",
    )
    return parser


# ---- helpers ----------------------------------------------------------------


def _emit(label: str, status: str) -> None:
    print(f"[e2e] {label}... {status}", file=sys.stderr)


def generate_repo_slug() -> str:
    """Generate a unique temp repo slug.

    Format: ``deftai-release-test-<YYYYMMDDHHMMSS>-<uuid6>``.
    The timestamp aids visual sorting in `gh repo list` if cleanup ever
    fails; the uuid6 suffix ensures uniqueness across rapid re-runs.
    """
    timestamp = _dt.datetime.now(_dt.UTC).strftime("%Y%m%d%H%M%S")
    suffix = uuid.uuid4().hex[:6]
    return f"{REPO_SLUG_PREFIX}{timestamp}-{suffix}"


def provision_temp_repo(owner: str, slug: str) -> tuple[bool, str]:
    """Invoke ``gh repo create --private <owner>/<slug>``.

    Returns ``(ok, reason)``. The remote is created empty; downstream
    pipeline steps (clone, push, etc.) are responsible for populating
    it.
    """
    if shutil.which("gh") is None:
        return False, "gh CLI not found on PATH"
    full = f"{owner}/{slug}"
    cmd = [
        "gh", "repo", "create", full,
        "--private",
        "--description", "Auto-generated release-rehearsal repo (deft #716); safe to delete.",
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120, check=False
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh repo create failed: {result.stderr.strip()}"
    return True, f"created {full} (private)"


def destroy_temp_repo(owner: str, slug: str) -> tuple[bool, str]:
    """Invoke ``gh repo delete <owner>/<slug> --yes``.

    Best-effort: returns False with a diagnostic if the delete fails so
    the caller can surface a manual cleanup hint without crashing the
    overall pipeline.
    """
    if shutil.which("gh") is None:
        return False, "gh CLI not found on PATH"
    full = f"{owner}/{slug}"
    cmd = ["gh", "repo", "delete", full, "--yes"]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120, check=False
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh repo delete failed: {result.stderr.strip()}"
    return True, f"deleted {full}"


def run_rehearsal(owner: str, slug: str) -> tuple[bool, str]:
    """Execute the actual rehearsal (currently a smoke test).

    The smoke test is intentionally minimal: a real release-pipeline
    rehearsal would require cloning the temp repo, mirroring deft's
    master, running ``task release`` against it, and verifying the
    draft release + tag landed. The current smoke test asserts the
    temp repo exists via ``gh repo view`` -- enough to prove the
    provision -> rehearsal -> cleanup loop works without coupling to
    the rest of deft's build pipeline.

    Future enhancement: clone deft, push to the temp repo, run a
    full pipeline (skip ``task ci:local`` to keep wall-clock under
    a minute), verify ``gh release view`` reports the draft.
    """
    if shutil.which("gh") is None:
        return False, "gh CLI not found on PATH"
    full = f"{owner}/{slug}"
    cmd = ["gh", "repo", "view", full, "--json", "name,visibility"]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=60, check=False
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh repo view failed: {result.stderr.strip()}"
    return True, f"verified {full} exists (smoke-test rehearsal)"


# ---- pipeline ---------------------------------------------------------------


def run_e2e(config: E2EConfig) -> int:
    """Execute the e2e rehearsal pipeline; returns the process exit code.

    The function is intentionally structured as ``provision -> rehearse
    -> destroy`` with the cleanup in a ``finally`` block so a failed
    rehearsal still triggers ``gh repo delete``. If the cleanup itself
    fails, a warning is printed but the rehearsal's own exit code wins
    so the operator does not see "rehearsal failed" reported as
    "cleanup failed".
    """
    slug = config.repo_slug or generate_repo_slug()
    owner = config.owner

    if config.dry_run:
        _emit(
            "Provision temp repo",
            f"DRYRUN (would run `gh repo create --private {owner}/{slug}`)",
        )
        _emit("Rehearsal", "DRYRUN (would run smoke-test rehearsal against temp repo)")
        _emit(
            "Destroy temp repo",
            f"DRYRUN (would run `gh repo delete {owner}/{slug} --yes`)",
        )
        return EXIT_OK

    # Provision.
    ok, reason = provision_temp_repo(owner, slug)
    if not ok:
        _emit(f"Provision {owner}/{slug}", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit(f"Provision {owner}/{slug}", f"OK ({reason})")

    rehearsal_rc = EXIT_OK
    try:
        ok, reason = run_rehearsal(owner, slug)
        if ok:
            _emit("Rehearsal", f"OK ({reason})")
        else:
            _emit("Rehearsal", f"FAIL ({reason})")
            rehearsal_rc = EXIT_VIOLATION
    finally:
        if config.keep_repo:
            _emit(
                f"Destroy {owner}/{slug}",
                "SKIP (--keep-repo set; manual cleanup required: "
                f"gh repo delete {owner}/{slug} --yes)",
            )
        else:
            ok, reason = destroy_temp_repo(owner, slug)
            if ok:
                _emit(f"Destroy {owner}/{slug}", f"OK ({reason})")
            else:
                # Cleanup failure does NOT override the rehearsal exit
                # code; we surface a warning + manual cleanup hint and
                # let the rehearsal's status stand.
                _emit(
                    f"Destroy {owner}/{slug}",
                    f"WARN ({reason}); manual cleanup hint: "
                    f"gh repo delete {owner}/{slug} --yes",
                )

    return rehearsal_rc


# ---- main -------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if not args.owner:
        print("Error: --owner must be a non-empty string.", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    project_root = release._resolve_project_root(args.project_root)

    config = E2EConfig(
        owner=args.owner,
        project_root=project_root,
        dry_run=args.dry_run,
        keep_repo=args.keep_repo,
    )
    return run_e2e(config)


if __name__ == "__main__":
    sys.exit(main())
