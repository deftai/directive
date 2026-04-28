#!/usr/bin/env python3
"""release_rollback.py -- State-aware release unwind (#716).

Companion to ``scripts/release.py`` and ``scripts/release_publish.py``
per the #716 safety hardening Q3 decision. ``task release:rollback --
<version>`` performs a state-aware unwind, tailoring its action to one
of four detected post-release states:

+----+----------------------------------------+--------------------------------------------+
| #  | Detected state                          | Action                                     |
+====+========================================+============================================+
| 1  | Local commit + tag, no push            | git tag -d + git reset --hard HEAD~1       |
| 2  | Tag pushed, no release                 | git push --delete origin v* + tag -d +     |
|    |                                        | git push --force-with-lease origin <base>  |
| 3  | Release published, downloads <= guard  | gh release delete --yes --cleanup-tag,     |
|    |                                        | then unwind commit                         |
| 4  | Release published, downloads > guard   | Refuse unless --allow-data-loss; recommend |
|    |                                        | hot-fix-path (next patch with withdrawal   |
|    |                                        | note)                                      |
+----+----------------------------------------+--------------------------------------------+

Time-windowed download-count guard (Q3)
---------------------------------------
The threshold for "low download count" varies with release age::

    release_age = now - release.created_at
    if release_age < 5_minutes:
        threshold = 0          # nobody noticed yet; safe
    elif release_age < 30_minutes:
        threshold = max(args.allow_low_downloads, 10)  # filter bots
    else:
        require(args.allow_data_loss, "release > 30 min old")

Three escape hatches (progressive warnings):
- ``--allow-low-downloads N`` -- accept up to N downloads
- ``--allow-data-loss`` -- accept any download count (consumer impact)
- ``--force-strict-0`` -- override time-window; require exactly 0 regardless
  of release age (use for security-incident hot-rollbacks)

Race-condition mitigation
-------------------------
GitHub's release-asset download_count is eventually-consistent (~30s
cache staleness). The guard reads ``download_count`` once, sleeps
5 seconds, reads again; only proceeds if BOTH reads agree below the
threshold (catches a download arriving between read 1 and the rollback
action).

Three-state exit codes
----------------------
    0 -- rollback completed (or already-clean no-op)
    1 -- refusal due to guard (downloads > threshold without escape hatch),
         or step-level failure (gh / git failure during unwind)
    2 -- config / argument error (malformed version, repo unresolvable, ...)

Refs #716 (canonical spec; safety hardening Item 3 of 7),
#74 (foundation), #233, #642, #635, #709, #710.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import json
import os
import shutil  # noqa: F401  -- kept for tests that monkeypatch release_rollback.shutil.which
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# Make sibling scripts importable so we can re-use _resolve_repo /
# _resolve_project_root / _validate_version + the EXIT_* constants from
# release.py without duplicating them.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

import release  # noqa: E402

EXIT_OK = release.EXIT_OK
EXIT_VIOLATION = release.EXIT_VIOLATION
EXIT_CONFIG_ERROR = release.EXIT_CONFIG_ERROR

# ---- Constants --------------------------------------------------------------

# Download-count guard time windows. Comments use minutes for readability;
# the constants are seconds so we can compare against `(now - created_at).seconds`.
_FIVE_MINUTES_SECONDS = 5 * 60
_THIRTY_MINUTES_SECONDS = 30 * 60

# Default threshold inside the 5-30 minute window (filters bot fetches that
# typically scrape new releases for indexing).
_DEFAULT_BOT_THRESHOLD = 10

# Race-condition double-read sleep duration. GitHub's release asset
# download_count cache typically takes ~30s to invalidate; 5s gives
# downstream callers a chance to surface a fresh count without
# meaningfully extending rollback wall-clock time.
_DOUBLE_READ_SLEEP_SECONDS = 5


# ---- Data classes -----------------------------------------------------------


@dataclass
class RollbackConfig:
    version: str
    repo: str
    base_branch: str
    project_root: Path
    dry_run: bool
    allow_low_downloads: int  # 0 = no override
    allow_data_loss: bool
    force_strict_0: bool
    # When True, skip the wall-clock sleep between download_count reads
    # (used by tests to keep latency negligible without disabling the
    # double-read semantic).
    skip_sleep: bool = False


# ---- argument parsing -------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="release_rollback",
        description=(
            "State-aware release unwind (#716 safety hardening). Detects "
            "one of four post-release states (local-only / tag-pushed / "
            "released-low-downloads / released-high-downloads) and applies "
            "the matching tiered recovery."
        ),
    )
    parser.add_argument(
        "version",
        help="Release version, e.g. 0.21.0 (no leading 'v', strict X.Y.Z).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the rollback plan without invoking gh / git side-effects.",
    )
    parser.add_argument(
        "--repo",
        default=None,
        metavar="OWNER/REPO",
        help="Override repo (default: resolved from `git remote get-url origin`).",
    )
    parser.add_argument(
        "--base-branch",
        default=release.DEFAULT_BASE_BRANCH,
        metavar="BRANCH",
        help=f"Base branch (default: {release.DEFAULT_BASE_BRANCH}).",
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=None,
        metavar="PATH",
        help="Repository root (default: $DEFT_PROJECT_ROOT or scripts/.. ).",
    )
    parser.add_argument(
        "--allow-low-downloads",
        type=int,
        default=0,
        metavar="N",
        help=(
            "Accept up to N downloads (defaults to the time-window-derived "
            "value). The maximum of this flag and the time-window default "
            "wins, so passing N=5 with a 10-min-old release still allows up "
            f"to {_DEFAULT_BOT_THRESHOLD}."
        ),
    )
    parser.add_argument(
        "--allow-data-loss",
        action="store_true",
        help=(
            "Accept any download count; explicit acknowledgment of consumer "
            "impact. Required when the release is > 30 minutes old."
        ),
    )
    parser.add_argument(
        "--force-strict-0",
        action="store_true",
        help=(
            "Override the time-window: require exactly 0 downloads regardless "
            "of release age. Use for security-incident hot-rollbacks where "
            "even bot scrapes are unacceptable."
        ),
    )
    return parser


# ---- gh helpers -------------------------------------------------------------


def _gh_release_view_json(version: str, repo: str) -> tuple[bool, dict | None, str]:
    """Fetch full release metadata as JSON; returns (ok, payload, reason).

    Includes ``createdAt`` and the ``assets[]`` array (each with
    ``downloadCount``). Used by the guard logic.
    """
    gh_path = release._resolve_gh()
    if gh_path is None:
        return False, None, "gh CLI not found on PATH"
    tag = f"v{version}"
    cmd = [
        gh_path, "release", "view", tag,
        "--repo", repo,
        "--json", "isDraft,name,tagName,createdAt,publishedAt,assets,url",
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
        return False, None, "gh CLI not found on PATH"
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        return False, None, stderr
    try:
        return True, json.loads(result.stdout), ""
    except json.JSONDecodeError as exc:
        return False, None, f"non-JSON: {exc}"


def gh_release_exists(version: str, repo: str) -> tuple[str, dict | None, str]:
    """Returns ('exists', payload, '') / ('not-found', None, '...') / ('error', None, '...')."""
    ok, payload, reason = _gh_release_view_json(version, repo)
    if ok:
        return "exists", payload, ""
    lowered = reason.lower()
    if "not found" in lowered:
        return "not-found", None, reason
    return "error", None, reason


def gh_release_delete(version: str, repo: str) -> tuple[bool, str]:
    gh_path = release._resolve_gh()
    if gh_path is None:
        return False, "gh CLI not found on PATH"
    tag = f"v{version}"
    cmd = [
        gh_path, "release", "delete", tag,
        "--repo", repo,
        "--yes",
        "--cleanup-tag",
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
        return False, f"gh release delete failed: {result.stderr.strip()}"
    return True, f"deleted release {tag} (with tag cleanup)"


# ---- git helpers ------------------------------------------------------------


def git_tag_exists_local(project_root: Path, version: str) -> bool:
    tag = f"v{version}"
    result = release._run_git(project_root, "tag", "-l", tag)
    return bool(result.stdout.strip())


def git_tag_exists_origin(project_root: Path, version: str) -> bool:
    tag = f"v{version}"
    result = release._run_git(
        project_root, "ls-remote", "--tags", "origin", f"refs/tags/{tag}"
    )
    return bool(result.stdout.strip())


def git_delete_local_tag(project_root: Path, version: str) -> tuple[bool, str]:
    tag = f"v{version}"
    result = release._run_git(project_root, "tag", "-d", tag)
    if result.returncode != 0:
        return False, f"git tag -d failed: {result.stderr.strip()}"
    return True, f"deleted local tag {tag}"


def git_delete_remote_tag(project_root: Path, version: str) -> tuple[bool, str]:
    tag = f"v{version}"
    result = release._run_git(
        project_root, "push", "--delete", "origin", tag
    )
    if result.returncode != 0:
        return False, f"git push --delete failed: {result.stderr.strip()}"
    return True, f"deleted remote tag {tag}"


def git_reset_head_minus_one(project_root: Path) -> tuple[bool, str]:
    """Unwind the local release commit via ``git reset --hard HEAD~1``.

    ``--hard`` is intentional: the release commit only carries the
    auto-promoted CHANGELOG / ROADMAP, which we want discarded so the
    next release attempt starts from a clean Unreleased section. The
    operator's personal/in-progress edits should never be staged into a
    release commit (commit_release_artifacts only stages the canonical
    artifacts), so reset --hard is safe in this context.
    """
    result = release._run_git(project_root, "reset", "--hard", "HEAD~1")
    if result.returncode != 0:
        return False, f"git reset failed: {result.stderr.strip()}"
    return True, "reset HEAD to HEAD~1 (release commit unwound)"


def git_force_push_base(
    project_root: Path, base_branch: str
) -> tuple[bool, str]:
    """Force-with-lease push the (now-unwound) base branch to origin."""
    result = release._run_git(
        project_root, "push", "--force-with-lease", "origin", base_branch
    )
    if result.returncode != 0:
        return False, f"git push --force-with-lease failed: {result.stderr.strip()}"
    return True, f"force-with-lease pushed {base_branch}"


# ---- guard logic ------------------------------------------------------------


def _sum_downloads(payload: dict) -> int:
    """Sum the ``downloadCount`` across all assets in a release payload."""
    assets = payload.get("assets", []) or []
    total = 0
    for asset in assets:
        # gh returns the field as ``downloadCount`` (camelCase under --json).
        count = asset.get("downloadCount", 0)
        with contextlib.suppress(TypeError, ValueError):
            total += int(count)
    return total


def _release_age_seconds(payload: dict, *, now: _dt.datetime | None = None) -> int:
    """Age of the release in seconds, derived from ``createdAt``.

    Returns 0 when the timestamp cannot be parsed (which lets the
    "release age < 5 min" branch evaluate True so the strict-0 default
    threshold applies -- safe-by-default).
    """
    created_at = payload.get("createdAt") or payload.get("publishedAt")
    if not created_at:
        return 0
    try:
        # gh ISO-8601 with trailing Z; Python 3.11 accepts a trailing 'Z'
        # via fromisoformat as long as we strip it manually for older.
        if created_at.endswith("Z"):
            created_at = created_at[:-1] + "+00:00"
        dt = _dt.datetime.fromisoformat(created_at)
    except ValueError:
        return 0
    now = now or _dt.datetime.now(_dt.UTC)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.UTC)
    delta = now - dt
    return max(0, int(delta.total_seconds()))


def compute_threshold(
    age_seconds: int,
    *,
    allow_low_downloads: int,
    allow_data_loss: bool,
    force_strict_0: bool,
) -> tuple[int | None, str]:
    """Compute the maximum acceptable download count given the time window.

    Returns ``(threshold, reason)`` where:

    - ``threshold`` is an int (the count below or equal to which rollback is
      permitted), or ``None`` if rollback is unconditionally refused at the
      time-window level (the operator must pass ``--allow-data-loss``).
    - ``reason`` is a one-line operator-readable explanation.

    ``--force-strict-0`` short-circuits the time window and always returns
    threshold=0; ``--allow-data-loss`` accepts any download count.
    """
    if force_strict_0:
        return 0, "--force-strict-0 override (require exactly 0 downloads)"
    if allow_data_loss:
        # int(2**31 - 1) avoids overflow surprises on 32-bit pickle paths.
        return 2**31 - 1, "--allow-data-loss override (accept any count)"
    if age_seconds < _FIVE_MINUTES_SECONDS:
        return 0, "release age < 5 min; threshold=0 (rollback safe)"
    if age_seconds < _THIRTY_MINUTES_SECONDS:
        threshold = max(allow_low_downloads, _DEFAULT_BOT_THRESHOLD)
        return threshold, (
            f"release age 5-30 min; threshold={threshold} "
            f"(filters bot fetches; --allow-low-downloads={allow_low_downloads})"
        )
    # 30+ minutes old: refuse without --allow-data-loss.
    return None, (
        "release age > 30 min; downloads likely consumer-driven. "
        "Pass --allow-data-loss to acknowledge consumer impact, OR "
        "abandon rollback in favour of a hot-fix release with a "
        "withdrawal note in the next CHANGELOG entry."
    )


def double_read_downloads(
    version: str, repo: str, *, sleep_seconds: int = _DOUBLE_READ_SLEEP_SECONDS
) -> tuple[bool, int, int, str]:
    """Read ``download_count`` twice with a sleep between; require agreement.

    Returns ``(ok, first_count, second_count, reason)``.

    ``ok`` is True when both reads succeed AND ``second_count <=
    first_count`` (a count cannot legitimately decrease over a 5-second
    window without manual intervention; any decrease signals a stale
    cache and rollback should re-read). Otherwise ``ok`` is False and
    ``reason`` carries the diagnostic.

    Tests that want to skip the wall-clock sleep can pass
    ``sleep_seconds=0`` (the double-read semantic still applies).
    """
    ok1, payload1, reason1 = _gh_release_view_json(version, repo)
    if not ok1 or payload1 is None:
        return False, 0, 0, f"first read failed: {reason1}"
    first_count = _sum_downloads(payload1)
    if sleep_seconds > 0:
        time.sleep(sleep_seconds)
    ok2, payload2, reason2 = _gh_release_view_json(version, repo)
    if not ok2 or payload2 is None:
        return False, first_count, 0, f"second read failed: {reason2}"
    second_count = _sum_downloads(payload2)
    if second_count > first_count:
        return False, first_count, second_count, (
            f"download_count grew between reads ({first_count} -> "
            f"{second_count}); a real consumer downloaded the asset during "
            "the rollback window. Re-run with the new count visible."
        )
    return True, first_count, second_count, ""


# ---- state detection --------------------------------------------------------


def detect_state(
    config: RollbackConfig,
) -> tuple[str, dict | None, str]:
    """Return the post-release state for ``v<version>``.

    States:
      - ``"local-only"`` -- local commit + tag, NOT pushed to origin
      - ``"tag-pushed-no-release"`` -- tag exists on origin, no GH release
      - ``"released"`` -- GH release exists; payload returned
      - ``"absent"`` -- nothing to roll back (no local tag, no remote tag,
        no release)
      - ``"error"`` -- gh / git probe failed; reason carries diagnostic
    """
    project_root = config.project_root
    version = config.version
    repo = config.repo

    # First check whether a GH release exists; if so, return early with the
    # payload so the caller has the assets[] array for guard evaluation.
    state, payload, reason = gh_release_exists(version, repo)
    if state == "exists":
        return "released", payload, ""
    if state == "error":
        # gh probe failed; surface the error so the caller can refuse rather
        # than guess at local/remote state.
        return "error", None, reason

    # No GH release. Probe local + remote tag.
    local = git_tag_exists_local(project_root, version)
    remote = git_tag_exists_origin(project_root, version)
    if remote:
        return "tag-pushed-no-release", None, ""
    if local:
        return "local-only", None, ""
    return "absent", None, ""


# ---- pipeline ---------------------------------------------------------------


def _emit(label: str, status: str) -> None:
    print(f"[rollback] {label}... {status}", file=sys.stderr)


def _unwind_local(config: RollbackConfig) -> int:
    """State 1: local commit + tag, no push."""
    project_root = config.project_root
    version = config.version
    if config.dry_run:
        _emit(
            f"Unwind local v{version}",
            f"DRYRUN (would run `git tag -d v{version}` + `git reset --hard HEAD~1`)",
        )
        return EXIT_OK
    # Delete local tag first so a follow-up `git reset --hard HEAD~1` does
    # not orphan the tag pointing at the unwound commit.
    ok, reason = git_delete_local_tag(project_root, version)
    if not ok:
        _emit(f"Delete local tag v{version}", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit(f"Delete local tag v{version}", f"OK ({reason})")
    ok, reason = git_reset_head_minus_one(project_root)
    if not ok:
        _emit("Reset HEAD~1", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit("Reset HEAD~1", f"OK ({reason})")
    return EXIT_OK


def _unwind_tag_pushed_no_release(config: RollbackConfig) -> int:
    """State 2: tag pushed, no release."""
    project_root = config.project_root
    version = config.version
    base_branch = config.base_branch
    if config.dry_run:
        _emit(
            f"Unwind pushed tag v{version}",
            (
                f"DRYRUN (would run `git push --delete origin v{version}` + "
                f"`git tag -d v{version}` + `git reset --hard HEAD~1` + "
                f"`git push --force-with-lease origin {base_branch}`)"
            ),
        )
        return EXIT_OK

    ok, reason = git_delete_remote_tag(project_root, version)
    if not ok:
        _emit(f"Delete remote tag v{version}", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit(f"Delete remote tag v{version}", f"OK ({reason})")

    if git_tag_exists_local(project_root, version):
        ok, reason = git_delete_local_tag(project_root, version)
        if not ok:
            _emit(f"Delete local tag v{version}", f"FAIL ({reason})")
            return EXIT_VIOLATION
        _emit(f"Delete local tag v{version}", f"OK ({reason})")

    ok, reason = git_reset_head_minus_one(project_root)
    if not ok:
        _emit("Reset HEAD~1", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit("Reset HEAD~1", f"OK ({reason})")

    # Force-with-lease push so origin reflects the unwound base branch.
    # `--force-with-lease` (rather than `--force`) refuses to overwrite
    # remote work landed by other contributors after the operator started
    # the rollback, defending against the rare case where someone pushed
    # to master between the release tag and the rollback decision.
    ok, reason = git_force_push_base(project_root, base_branch)
    if not ok:
        _emit(f"Force-with-lease push {base_branch}", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit(f"Force-with-lease push {base_branch}", f"OK ({reason})")
    return EXIT_OK


def _unwind_released(
    config: RollbackConfig, payload: dict
) -> int:
    """States 3 & 4: GitHub release exists. Apply guard, then unwind."""
    project_root = config.project_root
    version = config.version
    repo = config.repo

    age_seconds = _release_age_seconds(payload)
    threshold, threshold_reason = compute_threshold(
        age_seconds,
        allow_low_downloads=config.allow_low_downloads,
        allow_data_loss=config.allow_data_loss,
        force_strict_0=config.force_strict_0,
    )
    _emit(
        f"Compute guard threshold (age={age_seconds}s)",
        threshold_reason,
    )
    if threshold is None:
        # Time-window refusal (release > 30 min old, no escape hatch).
        _emit(
            "Guard refusal",
            "FAIL (release > 30 min old without --allow-data-loss; "
            "see hot-fix-path recommendation in script docstring)",
        )
        return EXIT_VIOLATION

    if config.dry_run:
        _emit(
            f"Double-read download_count (threshold={threshold})",
            "DRYRUN (would read download_count, sleep 5s, re-read)",
        )
        _emit(
            f"Delete release v{version}",
            f"DRYRUN (would run `gh release delete v{version} --yes --cleanup-tag`)",
        )
        _emit(
            "Reset HEAD~1",
            "DRYRUN (would run `git reset --hard HEAD~1`)",
        )
        return EXIT_OK

    sleep_seconds = 0 if config.skip_sleep else _DOUBLE_READ_SLEEP_SECONDS
    ok, first_count, second_count, reason = double_read_downloads(
        version, repo, sleep_seconds=sleep_seconds
    )
    _emit(
        f"Double-read download_count (threshold={threshold})",
        f"first={first_count}, second={second_count}, ok={ok}; reason: {reason or 'agreed'}",
    )
    if not ok:
        # Race: download arrived during read window. Refuse so the operator
        # re-runs with the fresh count visible.
        return EXIT_VIOLATION
    if max(first_count, second_count) > threshold:
        _emit(
            "Guard refusal",
            (
                f"FAIL (download_count={max(first_count, second_count)} > "
                f"threshold={threshold}; pass --allow-low-downloads or "
                f"--allow-data-loss to override)"
            ),
        )
        return EXIT_VIOLATION

    # Guard passed: delete the release (with cleanup-tag) and unwind the commit.
    ok, reason = gh_release_delete(version, repo)
    if not ok:
        _emit(f"Delete release v{version}", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit(f"Delete release v{version}", f"OK ({reason})")

    # Tag deletion is handled by --cleanup-tag in the gh delete call; we
    # don't need a separate `git push --delete`. Local tag may still
    # exist (gh deletes only the remote ref); clean it up if present.
    if git_tag_exists_local(project_root, version):
        ok, reason = git_delete_local_tag(project_root, version)
        if not ok:
            _emit(f"Delete local tag v{version}", f"WARN ({reason})")
        else:
            _emit(f"Delete local tag v{version}", f"OK ({reason})")

    ok, reason = git_reset_head_minus_one(project_root)
    if not ok:
        _emit("Reset HEAD~1", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit("Reset HEAD~1", f"OK ({reason})")

    # Force-with-lease push so origin's base branch matches the unwound
    # local state; without this, master/origin would still carry the
    # release commit.
    ok, reason = git_force_push_base(project_root, config.base_branch)
    if not ok:
        _emit(f"Force-with-lease push {config.base_branch}", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit(f"Force-with-lease push {config.base_branch}", f"OK ({reason})")

    return EXIT_OK


def run_rollback(config: RollbackConfig) -> int:
    """Execute the rollback pipeline; returns the process exit code."""
    if config.dry_run:
        _emit(
            "Detect post-release state",
            f"DRYRUN (would probe gh release view v{config.version} + "
            f"git tag -l + git ls-remote)",
        )
        # In dry-run, we still need a state to exercise the right branch.
        # Default to "released" so the dry-run output covers the most
        # complex path (the others print as DRYRUN inside their own
        # branches as well; if the operator wants a specific branch they
        # can run the script live).
        # However, if we can probe live state (gh + git available), do so
        # and report the actual branch. Otherwise fall back to the
        # most-complex branch.
        state, payload, reason = detect_state(config)
        _emit("State (dry-run probe)", f"{state} ({reason or 'no reason'})")
        if state == "absent":
            _emit("Rollback", "DRYRUN (no-op; nothing to unwind)")
            return EXIT_OK
        if state == "local-only":
            return _unwind_local(config)
        if state == "tag-pushed-no-release":
            return _unwind_tag_pushed_no_release(config)
        if state == "released" and payload is not None:
            return _unwind_released(config, payload)
        if state == "error":
            _emit("State probe", f"FAIL ({reason})")
            return EXIT_VIOLATION
        # Fallback for unknown state (shouldn't happen): no-op.
        return EXIT_OK

    state, payload, reason = detect_state(config)
    _emit("Detect post-release state", f"{state} ({reason or 'ok'})")
    if state == "absent":
        _emit("Rollback", "NOOP (no local tag, no remote tag, no release)")
        return EXIT_OK
    if state == "error":
        return EXIT_VIOLATION
    if state == "local-only":
        return _unwind_local(config)
    if state == "tag-pushed-no-release":
        return _unwind_tag_pushed_no_release(config)
    if state == "released":
        assert payload is not None
        return _unwind_released(config, payload)
    # Unknown state: refuse rather than guess.
    _emit("Rollback", f"FAIL (unknown state {state!r})")
    return EXIT_VIOLATION


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

    if args.allow_low_downloads < 0:
        print(
            f"Error: --allow-low-downloads must be >= 0 (got {args.allow_low_downloads}).",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    config = RollbackConfig(
        version=args.version,
        repo=repo,
        base_branch=args.base_branch,
        project_root=project_root,
        dry_run=args.dry_run,
        allow_low_downloads=args.allow_low_downloads,
        allow_data_loss=args.allow_data_loss,
        force_strict_0=args.force_strict_0,
    )
    return run_rollback(config)


if __name__ == "__main__":
    sys.exit(main())
