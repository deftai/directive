#!/usr/bin/env python3
"""release_publish.py -- Flip a draft GitHub release to public (#716).

Companion to ``scripts/release.py`` per the #716 safety hardening.
``task release`` lands the release as a draft so the *artifact
production* phase (release.yml CI + binary upload) is decoupled from
the *consumer-visibility* phase. After manually reviewing the draft's
binaries / notes / asset list, the operator runs::

    task release:publish -- <version>

which dispatches this script to flip ``--draft=false``.

Pipeline
--------
1. Pre-flight: verify ``gh release view v<version>`` resolves and is in
   draft state. State machine:

   - **not-found** → exit 1 (cannot publish a release that does not exist)
   - **already-published** → exit 0 no-op (publish is idempotent; running
     it twice is safe)
   - **draft** → proceed
2. ``gh release edit v<version> --draft=false --repo <owner/repo>``
3. Re-read the release and verify ``isDraft == false`` flipped
4. Print summary line; return exit 0

Exit codes
----------
    0 -- release published (or already-published no-op)
    1 -- pre-flight or step-level violation (release missing, gh failure,
         post-edit verification mismatch)
    2 -- config / argument error (malformed version, repo unresolvable, ...)

Refs #716 (canonical spec; safety hardening Item 2 of 7),
#74 (foundation), #233, #642, #635, #709, #710.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# Make sibling scripts importable so we can re-use _resolve_repo /
# _resolve_project_root / _validate_version + the EXIT_* constants from
# release.py without duplicating them.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

import release  # noqa: E402

# Re-export the exit codes so callers (tests + downstream) get a single
# source of truth identical to scripts/release.py.
EXIT_OK = release.EXIT_OK
EXIT_VIOLATION = release.EXIT_VIOLATION
EXIT_CONFIG_ERROR = release.EXIT_CONFIG_ERROR


# ---- Data classes -----------------------------------------------------------


@dataclass
class PublishConfig:
    version: str
    repo: str
    project_root: Path
    dry_run: bool


# ---- argument parsing -------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="release_publish",
        description=(
            "Flip a draft GitHub release to public (#716 safety hardening). "
            "Companion to `task release` -- after reviewing the draft's "
            "binaries / notes / asset list, run `task release:publish -- "
            "<version>` to publish."
        ),
    )
    parser.add_argument(
        "version",
        help="Release version, e.g. 0.21.0 (no leading 'v', strict X.Y.Z).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the publish plan without invoking gh release edit.",
    )
    parser.add_argument(
        "--repo",
        default=None,
        metavar="OWNER/REPO",
        help=(
            "Override the GitHub repository (default: resolved from "
            "`git remote get-url origin`, falling back to "
            f"{release.DEFAULT_REPO!r})."
        ),
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Repository root (default: $DEFT_PROJECT_ROOT or the parent of "
            "the scripts/ directory)."
        ),
    )
    return parser


# ---- gh helpers -------------------------------------------------------------


def view_release(version: str, repo: str) -> tuple[str, dict | None, str]:
    """Probe the current state of the GitHub release for ``v<version>``.

    Returns ``(state, payload, reason)`` where ``state`` is one of:

    - ``"draft"`` -- release exists with isDraft=true (proceed to publish)
    - ``"published"`` -- release exists with isDraft=false (already done)
    - ``"not-found"`` -- gh reports the release is missing (cannot publish)
    - ``"gh-error"`` -- gh failed for an unexpected reason (CLI missing,
      auth, network); ``reason`` carries the diagnostic
    """
    if shutil.which("gh") is None:
        return "gh-error", None, "gh CLI not found on PATH"
    tag = f"v{version}"
    cmd = [
        "gh", "release", "view", tag,
        "--repo", repo,
        "--json", "isDraft,name,tagName,url",
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except FileNotFoundError:
        return "gh-error", None, "gh CLI not found on PATH"
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        # gh exits non-zero for both "release not found" and other failures;
        # the not-found error message contains "release not found" / "Not Found"
        # / "release not found in this repository". Treat the missing-release
        # case distinctly so callers can no-op vs. report a real failure.
        lowered = stderr.lower()
        if "not found" in lowered or "release not found" in lowered:
            return "not-found", None, stderr
        return "gh-error", None, f"gh release view failed: {stderr}"
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        return "gh-error", None, f"gh release view returned non-JSON: {exc}"
    if payload.get("isDraft", False):
        return "draft", payload, ""
    return "published", payload, ""


def edit_release_publish(version: str, repo: str) -> tuple[bool, str]:
    """Invoke ``gh release edit`` to flip ``--draft=false``."""
    if shutil.which("gh") is None:
        return False, "gh CLI not found on PATH"
    tag = f"v{version}"
    cmd = ["gh", "release", "edit", tag, "--repo", repo, "--draft=false"]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh release edit failed: {result.stderr.strip()}"
    return True, f"flipped {tag} to published"


# ---- Pipeline ---------------------------------------------------------------


def _emit(label: str, status: str) -> None:
    # Resolve sys.stderr at call time (matches scripts/release.py emit pattern
    # so test capture via capsys works).
    print(f"[publish] {label}... {status}", file=sys.stderr)


def run_publish(config: PublishConfig) -> int:
    """Execute the publish pipeline; returns the process exit code."""
    version = config.version
    repo = config.repo
    tag = f"v{version}"

    # Step 1: view current state.
    label = f"View {tag} on {repo}"
    if config.dry_run:
        _emit(label, f"DRYRUN (would run `gh release view {tag} --repo {repo}`)")
        _emit(
            f"Edit {tag}",
            f"DRYRUN (would run `gh release edit {tag} --repo {repo} --draft=false`)",
        )
        return EXIT_OK

    state, payload, reason = view_release(version, repo)
    if state == "not-found":
        _emit(label, f"FAIL (release {tag} not found on {repo}: {reason})")
        return EXIT_VIOLATION
    if state == "gh-error":
        _emit(label, f"FAIL ({reason})")
        return EXIT_VIOLATION
    if state == "published":
        _emit(label, f"NOOP ({tag} is already published; nothing to do)")
        return EXIT_OK
    # state == "draft" -> proceed.
    assert payload is not None
    _emit(label, f"OK (draft found at {payload.get('url', '<no url>')})")

    # Step 2: edit to flip draft=false.
    label = f"Edit {tag} (--draft=false)"
    ok, reason = edit_release_publish(version, repo)
    if not ok:
        _emit(label, f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit(label, f"OK ({reason})")

    # Step 3: verify the edit actually flipped the draft state. A successful
    # exit from `gh release edit` does not by itself prove the state changed
    # (e.g. a stale cache, a permissions silently-noop, a wrong tag); the
    # post-edit re-read is defense in depth so the script never reports
    # success unless the consumer-visible state matches.
    label = f"Verify {tag} is published"
    state2, payload2, reason2 = view_release(version, repo)
    if state2 != "published":
        _emit(
            label,
            (
                f"FAIL (post-edit state is {state2!r}; expected 'published'; "
                f"reason: {reason2})"
            ),
        )
        return EXIT_VIOLATION
    _emit(label, f"OK ({tag} is now public)")

    print(
        f"Release {tag} published successfully on {repo}.",
        file=sys.stderr,
    )
    return EXIT_OK


# ---- main -------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        release._validate_version(args.version)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    project_root = release._resolve_project_root(args.project_root)
    repo = release._resolve_repo(args.repo, project_root)

    config = PublishConfig(
        version=args.version,
        repo=repo,
        project_root=project_root,
        dry_run=args.dry_run,
    )
    return run_publish(config)


if __name__ == "__main__":
    sys.exit(main())
