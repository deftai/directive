#!/usr/bin/env python3
"""slice_record_existing.py -- ``task slice:record-existing`` driver (#1147 / N7 of #1119).

Retrofit a ``vbrief/.eval/slices.jsonl`` entry for a cohort that the
framework did NOT produce (hand-filed umbrella + manually-created
children -- the dominant historical pattern in deftai/directive,
including #1119 itself). D13 (#1132) writes ``slices.jsonl`` only when
slicing skills fire (``deft-directive-gh-slice``,
``deft-directive-gh-arch``, refinement's slice phase); this verb is
the canonical backfill path for everything else.

Two operating modes
-------------------

1. ``slice:record-existing`` (default sub-command):

       slice_record_existing.py record-existing \
           --umbrella=<N> --children=<N>,<M>,... \
           [--wave-1=<N>,...] [--wave-N=...] \
           [--actor=manual:operator] \
           [--expected-close-signal=all-children-merged] \
           [--sliced-at=<iso>] \
           [--notes=<text>] \
           [--dry-run] [--force] \
           [--repo OWNER/NAME] [--project-root PATH]

   Default ``actor`` is ``manual:operator`` (vs the skill-emitted
   ``skill:gh-slice``). Wave assignment: a child appearing in
   ``--wave-N`` is assigned to that wave; otherwise wave 1.

2. ``slice:list`` companion sub-command:

       slice_record_existing.py list [--repo OWNER/NAME] [--project-root PATH]

   Prints every recorded slice with umbrella + child count + actor +
   sliced_at timestamp. Useful for verifying the backfill landed
   alongside skill-produced entries.

Validation
----------

* Umbrella + each child issue number must exist (probed via
  ``scm.call("github-issue", "issue", ["view", str(N), ...])`` per N5
  / #1145). The probe is skipped only when ``--skip-validation`` is
  passed (an escape hatch for cohorts whose issues live in a private
  mirror -- documented but not advertised). ``--dry-run`` alone does
  NOT bypass the probe; validation still fires so the preview reflects
  the actual reachability of each issue (#1230 -- Greptile P2).
* Idempotency: a record with the same ``umbrella`` AND the same
  ``children`` set (compared by ``{n}`` set, order-insensitive) is
  treated as already-present -- the verb is a no-op with
  informational stderr and exits 0. ``--force`` bypasses this check
  so an umbrella can carry multiple slice records (legitimate when
  slicing happens in multiple sessions).

Exit codes
----------

* 0 -- record written, dry-run preview, or idempotent no-op.
* 1 -- validation failure (missing umbrella / child, scm error,
  invalid record schema, malformed flags).
* 2 -- usage error (missing required flag, unknown sub-command,
  undetectable project root / repo).

Refs: #1119 (umbrella), #1132 (D13 writer + schema this consumes),
#1144 (N4 ``vbrief/.eval/`` governance -- ``slices.jsonl`` is
committed, not gitignored), #1145 (N5 ``scm.call`` shim).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

# Make sibling helpers importable when run as __main__.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import slice_record  # noqa: E402
from _project_context import (  # noqa: E402
    resolve_project_repo,
    resolve_project_root,
)
from _stdio_utf8 import reconfigure_stdio  # noqa: E402

import scm  # noqa: E402

reconfigure_stdio()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_ACTOR = "manual:operator"
DEFAULT_EXPECTED_CLOSE_SIGNAL = "all-children-merged"
DEFAULT_ROLE = "manual"

_WAVE_FLAG_RE = re.compile(r"^--wave-(\d+)(?:=(.*))?$")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_children_csv(value: str) -> list[int]:
    """Parse a comma-separated list of issue numbers; raise on malformed input."""
    if not value:
        raise ValueError("expected at least one child issue number")
    out: list[int] = []
    seen: set[int] = set()
    for part in value.split(","):
        token = part.strip()
        if not token:
            continue
        try:
            n = int(token)
        except ValueError as exc:
            raise ValueError(
                f"invalid child issue number {token!r} (must be a positive int)"
            ) from exc
        if n < 1:
            raise ValueError(f"invalid child issue number {n} (must be a positive int)")
        if n in seen:
            raise ValueError(f"duplicate child issue number {n}")
        seen.add(n)
        out.append(n)
    if not out:
        raise ValueError("expected at least one child issue number")
    return out


def _consume_wave_flags(raw_args: list[str]) -> tuple[dict[int, list[int]], list[str]]:
    """Extract every ``--wave-N=<csv>`` / ``--wave-N <csv>`` occurrence.

    Returns ``(wave_map, remaining_args)`` where ``wave_map`` is keyed by
    the wave number (1, 2, ...) and carries the list of child numbers
    assigned to that wave. ``remaining_args`` carries every token argparse
    will then parse with the static flag list. ``argparse`` cannot model
    a dynamic flag prefix on its own, so this small pre-pass owns the
    ``--wave-N`` shape (mirrors the pattern in scripts/scm.py's
    ``_extract_value_flag``).
    """
    wave_map: dict[int, list[int]] = {}
    remaining: list[str] = []
    i = 0
    while i < len(raw_args):
        token = raw_args[i]
        match = _WAVE_FLAG_RE.match(token)
        if not match:
            remaining.append(token)
            i += 1
            continue
        wave_n = int(match.group(1))
        if wave_n < 1:
            raise ValueError(f"invalid wave number in {token!r} (must be >= 1)")
        value: str | None
        if match.group(2) is not None:
            value = match.group(2)
            i += 1
        elif i + 1 < len(raw_args):
            value = raw_args[i + 1]
            i += 2
        else:
            raise ValueError(f"missing value for {token!r}")
        children = _parse_children_csv(value)
        bucket = wave_map.setdefault(wave_n, [])
        for n in children:
            if n in bucket:
                # Tolerate intra-wave duplicates (cheap), surface
                # cross-wave duplicates below.
                continue
            bucket.append(n)
    # Cross-wave duplicates: a child cannot be in two waves.
    placement: dict[int, int] = {}
    for wave_n, members in wave_map.items():
        for n in members:
            if n in placement and placement[n] != wave_n:
                raise ValueError(
                    f"child {n} appears in both --wave-{placement[n]} "
                    f"and --wave-{wave_n}; each child belongs to one wave"
                )
            placement[n] = wave_n
    return wave_map, remaining


def _repo_slug_to_url(repo: str, n: int) -> str:
    return f"https://github.com/{repo}/issues/{n}"


def _issues_jsonl_path(project_root: Path) -> Path:
    return project_root / "vbrief" / ".eval" / "slices.jsonl"


# ---------------------------------------------------------------------------
# Issue existence validation (N5 shim)
# ---------------------------------------------------------------------------


class IssueValidationError(RuntimeError):
    """Raised when an issue number cannot be validated via the SCM shim."""


def _validate_issue_exists(
    n: int,
    *,
    repo: str,
    scm_module=scm,
) -> None:
    """Probe ``gh issue view <N> --repo <repo>`` via the N5 shim.

    Raises :class:`IssueValidationError` on a non-zero exit. The shim
    itself raises :class:`NotImplementedError` for non-``github-issue``
    sources -- that bubbles up so a consumer on GitLab / Gitea sees
    the deferred abstraction (#445 / #935 Workstream 6) immediately.
    """
    try:
        proc = scm_module.call(
            "github-issue",
            "issue",
            ["view", str(n), "--repo", repo, "--json", "number,url"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        raise IssueValidationError(f"timed out validating issue #{n} in {repo}") from exc
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip() or "(no stderr)"
        raise IssueValidationError(f"issue #{n} in {repo} not found / inaccessible: {stderr}")


# ---------------------------------------------------------------------------
# Build + write
# ---------------------------------------------------------------------------


def _build_children(
    children: list[int],
    wave_map: dict[int, list[int]],
    repo: str,
) -> list[dict[str, object]]:
    """Construct the per-child dicts in the slices.jsonl schema shape."""
    wave_for: dict[int, int] = {}
    for wave_n, members in wave_map.items():
        for n in members:
            wave_for[n] = wave_n
    out: list[dict[str, object]] = []
    for n in children:
        out.append(
            {
                "n": n,
                "url": _repo_slug_to_url(repo, n),
                "wave": wave_for.get(n, 1),
                "role": DEFAULT_ROLE,
            }
        )
    return out


def _children_set(record: dict) -> frozenset[int]:
    children = record.get("children")
    if not isinstance(children, list):
        return frozenset()
    out: set[int] = set()
    for child in children:
        if isinstance(child, dict):
            n = child.get("n")
            if isinstance(n, int):
                out.add(n)
    return frozenset(out)


def _find_duplicate(
    umbrella: int,
    children_numbers: list[int],
    *,
    slices_path: Path,
    record_module=slice_record,
) -> dict | None:
    """Return the first existing slice record that matches umbrella + child-set, or None."""
    target = frozenset(children_numbers)
    for record in record_module.read_all(path=slices_path):
        if record.get("umbrella") != umbrella:
            continue
        if _children_set(record) == target:
            return record
    return None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="slice_record_existing.py",
        description=(
            "Retrofit a slices.jsonl entry for a hand-filed cohort "
            "(#1147 / N7 of #1119). Default sub-command is 'record-existing'."
        ),
    )
    sub = parser.add_subparsers(dest="command")

    record = sub.add_parser(
        "record-existing",
        help="Write a backfill slice record (default sub-command).",
    )
    record.add_argument(
        "--umbrella",
        type=int,
        required=True,
        help="Umbrella issue number.",
    )
    record.add_argument(
        "--children",
        required=True,
        help="Comma-separated child issue numbers (e.g. 1121,1122,1123).",
    )
    record.add_argument(
        "--actor",
        default=DEFAULT_ACTOR,
        help=(
            f"Slicing actor identity (default: {DEFAULT_ACTOR}). "
            "Distinguishes backfill records from skill-emitted records."
        ),
    )
    record.add_argument(
        "--expected-close-signal",
        default=DEFAULT_EXPECTED_CLOSE_SIGNAL,
        help=(
            f"One of all-children-merged|wave-1-merged|manual "
            f"(default: {DEFAULT_EXPECTED_CLOSE_SIGNAL})."
        ),
    )
    record.add_argument(
        "--sliced-at",
        default=None,
        help="ISO-8601 UTC timestamp (e.g. 2026-05-14T17:00:00Z). Defaults to now.",
    )
    record.add_argument(
        "--notes",
        default=None,
        help="Free-text rationale recorded on the slice entry.",
    )
    record.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the proposed entry to stdout without writing.",
    )
    record.add_argument(
        "--force",
        action="store_true",
        help=(
            "Bypass idempotency: write a new record even when an entry "
            "with the same umbrella + child set already exists. "
            "Legitimate when slicing happens in multiple sessions."
        ),
    )
    record.add_argument(
        "--skip-validation",
        action="store_true",
        help=(
            "Skip the scm.call issue-existence probes. Documented escape "
            "hatch for cohorts whose issues live in a private mirror -- "
            "use sparingly."
        ),
    )
    record.add_argument(
        "--repo",
        default=None,
        help=(
            "Consumer GitHub repo (OWNER/NAME). Defaults to "
            "$DEFT_PROJECT_REPO or `git remote get-url origin`."
        ),
    )
    record.add_argument(
        "--project-root",
        default=None,
        help="Consumer project root. Overrides $DEFT_PROJECT_ROOT.",
    )

    list_cmd = sub.add_parser(
        "list",
        help="List recorded slices with umbrella + child counts + actor.",
    )
    list_cmd.add_argument(
        "--project-root",
        default=None,
        help="Consumer project root. Overrides $DEFT_PROJECT_ROOT.",
    )
    list_cmd.add_argument(
        "--json",
        dest="as_json",
        action="store_true",
        help="Emit the slice records as a JSON array (one object per slice).",
    )

    return parser


def _resolve_root_and_repo(
    cli_project_root: str | None,
    cli_repo: str | None,
    *,
    require_repo: bool,
) -> tuple[Path, str | None, int]:
    """Resolve ``(project_root, repo, error_exit_code)``.

    On success returns ``(root, repo_or_None, 0)``. On failure prints
    a loud error to stderr and returns ``(Path('.'), None, exit_code)``.
    """
    project_root = resolve_project_root(cli_project_root)
    if project_root is None:
        print(
            "error: cannot determine project root. Pass --project-root PATH, "
            "set $DEFT_PROJECT_ROOT, or run from inside a directory tree that "
            "contains vbrief/ or .git/ (#535).",
            file=sys.stderr,
        )
        return Path("."), None, 2
    if not require_repo:
        return project_root, None, 0
    repo = resolve_project_repo(cli_repo, project_root=project_root)
    if not repo:
        print(
            "error: cannot determine repo slug. Pass --repo OWNER/NAME, "
            "set $DEFT_PROJECT_REPO, or run inside a git checkout with an "
            "origin remote.",
            file=sys.stderr,
        )
        return project_root, None, 2
    return project_root, repo, 0


def _run_record_existing(args: argparse.Namespace, wave_map: dict[int, list[int]]) -> int:
    project_root, repo, exit_code = _resolve_root_and_repo(
        args.project_root, args.repo, require_repo=True
    )
    if exit_code != 0:
        return exit_code
    if repo is None:  # pragma: no cover -- guaranteed non-None when require_repo=True
        # Explicit guard so this safety check survives `python -O` (where
        # bare ``assert`` is stripped). See #1230 -- Greptile P2.
        raise RuntimeError(
            "repo is None despite require_repo=True; this is a bug in "
            "_resolve_root_and_repo"
        )

    try:
        children = _parse_children_csv(args.children)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    # Validate wave members are a subset of the declared children.
    declared = set(children)
    for wave_n, members in wave_map.items():
        for n in members:
            if n not in declared:
                print(
                    f"error: --wave-{wave_n} references child #{n} not present in --children",
                    file=sys.stderr,
                )
                return 2

    if args.umbrella in declared:
        print(
            f"error: umbrella #{args.umbrella} cannot also appear in --children",
            file=sys.stderr,
        )
        return 2

    # Issue-existence validation via scm.call (N5 shim). Skipped under
    # --skip-validation (documented escape hatch) so an operator can
    # backfill cohorts whose issues live in a private mirror or have
    # been deleted post-slice.
    if not args.skip_validation:
        try:
            _validate_issue_exists(args.umbrella, repo=repo)
            for n in children:
                _validate_issue_exists(n, repo=repo)
        except IssueValidationError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        except NotImplementedError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    # Idempotency: refuse to duplicate a record with the same umbrella +
    # child set unless --force. Pre-lock peek is a fast-path optimisation
    # for the common no-concurrency case (no file IO under the lock when
    # an obvious duplicate exists); the authoritative re-check fires
    # under the file lock below so two concurrent invocations cannot
    # both observe "no duplicate" and both append (P1 TOCTOU per #1231).
    slices_path = _issues_jsonl_path(project_root)
    duplicate = _find_duplicate(args.umbrella, children, slices_path=slices_path)
    if duplicate is not None and not args.force:
        print(
            f"slice:record-existing: umbrella #{args.umbrella} already has a "
            f"matching record (slice_id={duplicate.get('slice_id')}, "
            f"actor={duplicate.get('actor')}). Re-run with --force to write "
            "a second record.",
            file=sys.stderr,
        )
        return 0

    child_dicts = _build_children(children, wave_map, repo)

    # Dry-run path: build the proposed record without writing. No lock
    # needed -- dry-run is read-only and does not race against itself.
    if args.dry_run:
        proposed = {
            "slice_id": "<dry-run>",
            "umbrella": args.umbrella,
            "umbrella_url": _repo_slug_to_url(repo, args.umbrella),
            "sliced_at": args.sliced_at or slice_record.now_iso(),
            "actor": args.actor,
            "children": child_dicts,
            "expected_close_signal": args.expected_close_signal,
        }
        if args.notes is not None:
            proposed["notes"] = args.notes
        print(json.dumps(proposed, sort_keys=True, ensure_ascii=False, indent=2))
        wave_summary = _summarise_waves(wave_map, len(children))
        print(
            f"DRY-RUN: would write slices.jsonl entry for umbrella "
            f"#{args.umbrella} ({len(children)} children, {wave_summary}).",
            file=sys.stderr,
        )
        return 0

    # Atomic idempotency (#1231 / P1 TOCTOU fix): the duplicate check
    # AND the append must run under one critical section so two
    # concurrent invocations of `task slice:record-existing` (neither
    # passing --force) cannot both observe "no duplicate" between the
    # check and the append. Acquire the sidecar lock that already
    # serialises every slice_record.write_slice call, run a second
    # _find_duplicate inside the lock (this is the authoritative pass
    # -- the pre-lock peek above is only a fast path for the common
    # uncontended case), and then call write_slice_unlocked so we do
    # not deadlock on re-entry into the same lock.
    record: dict = {
        "slice_id": slice_record.new_slice_id(),
        "umbrella": args.umbrella,
        "umbrella_url": _repo_slug_to_url(repo, args.umbrella),
        "sliced_at": args.sliced_at or slice_record.now_iso(),
        "actor": args.actor,
        "children": child_dicts,
        "expected_close_signal": args.expected_close_signal,
    }
    if args.notes is not None:
        record["notes"] = args.notes

    slices_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with slice_record.append_lock(slices_path):
            authoritative_dup = _find_duplicate(
                args.umbrella, children, slices_path=slices_path
            )
            if authoritative_dup is not None and not args.force:
                print(
                    f"slice:record-existing: umbrella #{args.umbrella} "
                    f"already has a matching record (slice_id="
                    f"{authoritative_dup.get('slice_id')}, actor="
                    f"{authoritative_dup.get('actor')}). Re-run with "
                    "--force to write a second record.",
                    file=sys.stderr,
                )
                return 0
            slice_id = slice_record.write_slice_unlocked(
                record=record, path=slices_path
            )
    except slice_record.SliceRecordError as exc:
        print(f"error: invalid record -- {exc}", file=sys.stderr)
        return 1

    wave_summary = _summarise_waves(wave_map, len(children))
    print(
        f"Wrote vbrief/.eval/slices.jsonl entry for umbrella "
        f"#{args.umbrella} ({len(children)} children, {wave_summary}). "
        f"slice_id={slice_id}"
    )
    return 0


def _summarise_waves(wave_map: dict[int, list[int]], total_children: int) -> str:
    """Render the operator-facing wave-distribution summary.

    Children declared in ``--children`` but absent from every ``--wave-N``
    flag fall through to wave 1 (the default). Per #1230 -- Greptile P2,
    the unassigned-default count is MERGED into the wave-1 entry rather
    than rendered as a second ``wave-1=N (default)`` segment, so a caller
    passing ``--wave-1=2 --wave-2=3`` with one unassigned child sees
    ``"2 wave(s): wave-1=2, wave-2=1"`` rather than the pre-fix
    ``"3 wave(s): wave-1=1, wave-2=1, wave-1=1 (default)"``.
    """
    if not wave_map:
        return f"{total_children} in wave 1 (default)"
    placed_by_wave: dict[int, int] = {
        wave_n: len(members) for wave_n, members in wave_map.items()
    }
    placed_total = sum(placed_by_wave.values())
    unassigned = total_children - placed_total
    if unassigned > 0:
        placed_by_wave[1] = placed_by_wave.get(1, 0) + unassigned
    parts = [f"wave-{wave_n}={placed_by_wave[wave_n]}" for wave_n in sorted(placed_by_wave)]
    return f"{len(parts)} wave(s): " + ", ".join(parts)


def _run_list(args: argparse.Namespace) -> int:
    project_root, _repo, exit_code = _resolve_root_and_repo(
        args.project_root, None, require_repo=False
    )
    if exit_code != 0:
        return exit_code

    slices_path = _issues_jsonl_path(project_root)
    records = slice_record.read_all(path=slices_path)

    if args.as_json:
        print(json.dumps(records, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    if not records:
        print("slice:list: no records found in vbrief/.eval/slices.jsonl (file absent or empty).")
        return 0

    print(f"slice:list: {len(records)} record(s) in vbrief/.eval/slices.jsonl")
    for record in records:
        umbrella = record.get("umbrella", "?")
        actor = record.get("actor", "?")
        sliced_at = record.get("sliced_at", "?")
        slice_id = record.get("slice_id", "?")
        children = record.get("children")
        child_count = len(children) if isinstance(children, list) else 0
        signal = record.get("expected_close_signal", "?")
        notes = record.get("notes")
        line = (
            f"  - umbrella=#{umbrella} children={child_count} "
            f"actor={actor} sliced_at={sliced_at} "
            f"signal={signal} slice_id={slice_id}"
        )
        if notes:
            line += f" notes={notes!r}"
        print(line)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    # No sub-command and at least one non-flag arg is unusual; default
    # to `record-existing` to match the documented user-facing surface
    # (``task slice:record-existing --umbrella=N ...`` forwards the
    # remaining flags to this script with no positional sub-command).
    if raw and raw[0] not in {"record-existing", "list", "-h", "--help"}:
        raw = ["record-existing", *raw]
    elif not raw:
        raw = ["record-existing"]

    # Pre-pass: strip out --wave-N flags before argparse sees them
    # (argparse cannot model a dynamic flag prefix). Only relevant for
    # the `record-existing` sub-command; the `list` sub-command has no
    # --wave-N surface so the pre-pass is a no-op there.
    if raw and raw[0] == "record-existing":
        try:
            wave_map, raw = _consume_wave_flags(raw)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    else:
        wave_map = {}

    parser = _build_parser()
    try:
        args = parser.parse_args(raw)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    if args.command == "list":
        return _run_list(args)
    return _run_record_existing(args, wave_map)


if __name__ == "__main__":
    raise SystemExit(main())
