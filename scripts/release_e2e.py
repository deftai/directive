#!/usr/bin/env python3
"""release_e2e.py -- Auto-create + auto-destroy temp-repo release rehearsal (#716, #720).

Companion to ``scripts/release.py`` per the #716 safety hardening Q1
decision (auto-create + auto-destroy temp repo). ``task release:e2e``
provisions a private GitHub repo named
``deftai-release-test-<timestamp>-<uuid6>``, runs the full release
pipeline against it, then destroys the repo via ``gh repo delete --yes``
in a ``try/finally`` so cleanup runs even when the test fails.

Pipeline (#720 deepening)
-------------------------
The rehearsal step was previously a smoke-test existence check
(``gh repo view``); per #720 it now mirrors the directive repo into
the temp remote and exercises the actual ``task release`` pipeline
end-to-end:

1. Generate a unique repo slug (``deftai-release-test-<timestamp>-<uuid6>``)
2. ``gh repo create --private deftai/<slug> --description "..."``
3. Mirror the current directive repo into the temp remote and exercise
   the release pipeline:

   a. ``git clone <project_root> <tmpdir>`` -- shallow-style local clone
      (operates on the on-disk repo so we do not depend on network).
   b. ``git -C <tmpdir> remote set-url origin <temp-repo-url>`` -- point
      origin at the auto-created temp remote.
   c. ``git -C <tmpdir> push origin refs/heads/*:refs/heads/*
      refs/tags/*:refs/tags/*`` -- populate the temp remote with every
      branch and tag using explicit refspecs. We deliberately avoid
      ``git push --mirror`` here because ``--mirror`` also pushes
      ``refs/remotes/*`` (the local clone's remote-tracking refs);
      GitHub's receive-pack rejects writes to that namespace and the
      whole rehearsal would fail at the push step. Explicit refspecs
      cover the two namespaces we actually care about (heads + tags)
      without leaking remote-tracking refs.
   d. ``task release -- 0.0.1 --repo deftai/<slug> --skip-ci --skip-build``
      -- run the full 10-step pipeline against the temp repo. ``--skip-ci``
      and ``--skip-build`` (#720, see ``scripts/release.py``) keep the
      wall-clock manageable; CI / build semantics are covered by the
      unit-test suite at every commit on master.
   e. ``gh release view v0.0.1 --repo deftai/<slug>`` -- assert
      ``isDraft=true`` and ``tagName == v0.0.1`` (the production draft
      lifecycle, #716).
   f. ``git -C <tmpdir> ls-remote --tags origin v0.0.1`` -- assert the
      tag exists on the temp remote.
   g. ``task release:rollback -- 0.0.1 --repo deftai/<slug>`` -- exercise
      the rollback path against a known-state release (#725 forward-revert
      flow on a protected default branch).

4. ``gh repo delete deftai/<slug> --yes`` -- ALWAYS in a finally clause
5. If delete fails, surface a one-line manual cleanup hint and continue
   so the test result still reaches stdout

Wall-clock (#720)
-----------------
``--skip-ci`` and ``--skip-build`` keep the rehearsal wall-clock under
90 seconds on a typical operator machine. Skipping these is safe inside
the rehearsal because (a) CI runs at every commit on master via
``.github/workflows/ci.yml``; (b) build artefacts are not needed for
the draft-release verification step; (c) the unit-test suite covers
both paths in isolation.

Exit codes
----------
    0 -- rehearsal succeeded; cleanup succeeded (or surfaced as a warning)
    1 -- rehearsal failed; cleanup ran regardless
    2 -- config / argument error (gh missing, owner unset, ...)

Mockability
-----------
Every side-effecting step (``provision_temp_repo`` / ``destroy_temp_repo``
/ ``clone_repo_to_temp`` / ``set_origin_to_temp_repo`` / ``push_mirror``
/ ``dispatch_task_release`` / ``verify_draft_release`` / ``verify_tag``
/ ``dispatch_task_release_rollback``) is an isolated function so tests
can replace it with a mock; CI exercises the orchestration without
ever cloning, pushing, or hitting real GitHub.

Refs #720 (pipeline-mirror deepening), #716 (canonical spec; safety
hardening Item 4 of 7), #722 (subprocess PATHEXT fix; release._resolve_gh
helper re-used here), #725 (forward-revert + normal push in rollback),
#74 (foundation), #233, #642, #635, #709, #710.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import shutil  # noqa: F401  -- kept for tests that monkeypatch release_e2e.shutil.which
import subprocess
import sys
import tempfile
import uuid
from collections.abc import Callable
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

# #720: the rehearsal version is a fixed sentinel rather than a real
# release version. ``0.0.1`` is far enough below any real deft release
# that an operator scrolling release notes can immediately recognise it
# as a rehearsal artefact -- and ``X.Y.Z`` matches the strict semver
# regex enforced by ``release._validate_version``.
REHEARSAL_VERSION = "0.0.1"


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
    gh_path = release._resolve_gh()
    if gh_path is None:
        return False, "gh CLI not found on PATH"
    full = f"{owner}/{slug}"
    cmd = [
        gh_path, "repo", "create", full,
        "--private",
        "--description", "Auto-generated release-rehearsal repo (deft #716); safe to delete.",
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            env=os.environ.copy(),
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
    gh_path = release._resolve_gh()
    if gh_path is None:
        return False, "gh CLI not found on PATH"
    full = f"{owner}/{slug}"
    cmd = [gh_path, "repo", "delete", full, "--yes"]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh repo delete failed: {result.stderr.strip()}"
    return True, f"deleted {full}"


# ---- Rehearsal step helpers (#720) -----------------------------------------


def clone_repo_to_temp(
    project_root: Path, target_dir: Path
) -> tuple[bool, str]:
    """Clone the local directive repo into ``target_dir`` (#720).

    Uses ``git clone <project_root> <target_dir>`` so the rehearsal does
    not depend on network access during the clone step (the temp remote
    is populated via the explicit-refspec push in ``push_mirror``
    afterwards).
    """
    result = subprocess.run(
        ["git", "clone", str(project_root), str(target_dir)],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
        env=os.environ.copy(),
    )
    if result.returncode != 0:
        return False, f"git clone failed: {result.stderr.strip()}"
    return True, f"cloned {project_root} -> {target_dir}"


def set_origin_to_temp_repo(
    clone_dir: Path, owner: str, slug: str
) -> tuple[bool, str]:
    """Point the clone's origin at the auto-created temp repo (#720).

    Uses the canonical https URL shape so the rehearsal works on hosts
    that lack an SSH key registered with GitHub (which is the typical
    Windows operator environment for this project).
    """
    url = f"https://github.com/{owner}/{slug}.git"
    result = release._run_git(clone_dir, "remote", "set-url", "origin", url)
    if result.returncode != 0:
        return False, (
            f"git remote set-url failed: {result.stderr.strip()}"
        )
    return True, f"origin -> {url}"


def push_mirror(clone_dir: Path) -> tuple[bool, str]:
    """Populate the temp remote with branches and tags from the clone (#720).

    Pushes every branch and every tag from the local clone to the
    auto-created temp remote using two explicit refspecs:
    ``refs/heads/*:refs/heads/*`` and ``refs/tags/*:refs/tags/*``.

    The function name retains the historical ``push_mirror`` label so
    callers and tests stay stable, but the implementation deliberately
    avoids ``git push --mirror``. ``--mirror`` is documented to push
    every ref under ``refs/`` -- including ``refs/remotes/*``, the
    local clone's remote-tracking refs. GitHub's receive-pack rejects
    writes to that namespace, so a real ``--mirror`` push from a
    non-bare clone (which is what we have here -- ``git clone
    <project_root> <clone_dir>`` produces a normal working clone with
    a populated ``refs/remotes/origin/*``) would fail every real
    ``task release:e2e`` run at this step. Explicit refspecs cover
    the two namespaces the subsequent rehearsal cares about (branches
    + tags) without leaking remote-tracking refs.
    """
    result = release._run_git(
        clone_dir,
        "push",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
    )
    if result.returncode != 0:
        return False, f"git push (heads+tags refspecs) failed: {result.stderr.strip()}"
    return True, "pushed heads + tags to temp origin"


def dispatch_task_release(
    clone_dir: Path, version: str, repo: str
) -> tuple[bool, str]:
    """Invoke ``task release -- <version> --repo <repo> --skip-ci --skip-build``
    inside the clone (#720).

    Skipping CI + build keeps the rehearsal wall-clock manageable; both
    are covered by the unit-test suite. The 10-step pipeline still
    exercises CHANGELOG promotion, ROADMAP refresh, commit, tag, atomic
    push, and ``gh release create --draft``.
    """
    if shutil.which("task") is None:
        return False, "task binary not found on PATH"
    cmd = [
        "task", "release",
        "--", version,
        "--repo", repo,
        "--skip-ci",
        "--skip-build",
    ]
    try:
        result = subprocess.run(
            cmd,
            cwd=str(clone_dir),
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return False, "task binary not found on PATH"
    if result.returncode != 0:
        return False, (
            f"task release failed (exit {result.returncode}): "
            f"{(result.stderr or result.stdout).strip()}"
        )
    return True, f"task release -- {version} --repo {repo} (draft) ran clean"


def verify_draft_release(
    owner: str, slug: str, version: str
) -> tuple[bool, str]:
    """Assert ``gh release view`` reports the draft for ``v<version>`` (#720).

    Verifies (a) the release exists, (b) ``isDraft == true``, (c)
    ``tagName == v<version>``. Anything else returns False so the
    rehearsal fails loudly.
    """
    gh_path = release._resolve_gh()
    if gh_path is None:
        return False, "gh CLI not found on PATH"
    tag = f"v{version}"
    full = f"{owner}/{slug}"
    cmd = [
        gh_path, "release", "view", tag,
        "--repo", full,
        "--json", "isDraft,tagName,name,url",
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh release view failed: {result.stderr.strip()}"
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        return False, f"gh release view returned non-JSON: {exc}"
    if not payload.get("isDraft"):
        return False, (
            f"draft verify FAIL: expected isDraft=true on {full} {tag}, "
            f"got {payload!r}"
        )
    if payload.get("tagName") != tag:
        return False, (
            f"draft verify FAIL: expected tagName={tag!r} on {full}, "
            f"got tagName={payload.get('tagName')!r}"
        )
    return True, f"verified draft {tag} on {full}"


def verify_tag(clone_dir: Path, version: str) -> tuple[bool, str]:
    """Assert the tag ``v<version>`` exists on the temp remote (#720).

    Uses ``git ls-remote --tags origin`` so the assertion is independent
    of the local tag database (the local clone may have already pushed +
    cleaned up; what matters is the remote ref).
    """
    tag = f"v{version}"
    result = release._run_git(
        clone_dir, "ls-remote", "--tags", "origin", f"refs/tags/{tag}"
    )
    if result.returncode != 0:
        return False, f"git ls-remote failed: {result.stderr.strip()}"
    if not result.stdout.strip():
        return False, f"tag verify FAIL: {tag} not present on temp origin"
    return True, f"verified tag {tag} present on temp origin"


def dispatch_task_release_rollback(
    clone_dir: Path, version: str, repo: str
) -> tuple[bool, str]:
    """Invoke ``task release:rollback -- <version> --repo <repo>`` (#720).

    Exercises the rollback path against the temp repo so a regression in
    the state-aware unwind (states 1-3) surfaces in the e2e job rather
    than during a real production rollback.
    """
    if shutil.which("task") is None:
        return False, "task binary not found on PATH"
    cmd = [
        "task", "release:rollback",
        "--", version,
        "--repo", repo,
    ]
    try:
        result = subprocess.run(
            cmd,
            cwd=str(clone_dir),
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return False, "task binary not found on PATH"
    if result.returncode != 0:
        return False, (
            f"task release:rollback failed (exit {result.returncode}): "
            f"{(result.stderr or result.stdout).strip()}"
        )
    return True, f"task release:rollback -- {version} --repo {repo} ran clean"


def run_rehearsal(
    owner: str, slug: str, project_root: Path,
    version: str = REHEARSAL_VERSION,
) -> tuple[bool, str]:
    """Execute the full pipeline-mirror rehearsal (#720).

    Orchestrates seven steps inside a ``tempfile.TemporaryDirectory``:
    clone -> set-origin -> push-mirror -> task release -> verify draft
    -> verify tag -> task release:rollback. On the first step failure,
    short-circuits and returns the diagnostic; the caller is responsible
    for cleanup of the temp GitHub repo (run_e2e wraps this in
    ``try/finally``).

    Pre-#720 this function was a smoke-test ``gh repo view`` (existence
    check only). The deeper flow surfaces real regressions in the
    release pipeline before they hit master.
    """
    repo_full = f"{owner}/{slug}"
    with tempfile.TemporaryDirectory(prefix="deft-e2e-") as tmpdir:
        clone_dir = Path(tmpdir) / "clone"
        steps: list[tuple[str, Callable[[], tuple[bool, str]]]] = [
            ("clone", lambda: clone_repo_to_temp(project_root, clone_dir)),
            ("set-origin", lambda: set_origin_to_temp_repo(clone_dir, owner, slug)),
            ("push-mirror", lambda: push_mirror(clone_dir)),
            ("task release", lambda: dispatch_task_release(clone_dir, version, repo_full)),
            ("verify draft", lambda: verify_draft_release(owner, slug, version)),
            ("verify tag", lambda: verify_tag(clone_dir, version)),
            (
                "task release:rollback",
                lambda: dispatch_task_release_rollback(clone_dir, version, repo_full),
            ),
        ]
        for label, step in steps:
            ok, reason = step()
            _emit(f"  rehearsal step: {label}", f"{'OK' if ok else 'FAIL'} ({reason})")
            if not ok:
                return False, f"{label}: {reason}"
    return True, (
        f"pipeline-mirror rehearsal succeeded against {repo_full} "
        f"(7 steps; clone -> push heads+tags -> task release -> verify -> rollback)"
    )


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
        _emit(
            "Rehearsal",
            (
                "DRYRUN (would run pipeline-mirror rehearsal: clone -> "
                "push heads+tags -> task release -> verify draft + tag -> "
                "task release:rollback against temp repo)"
            ),
        )
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
        ok, reason = run_rehearsal(owner, slug, config.project_root)
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
