#!/usr/bin/env python3
"""capacity_backfill.py -- one-time capacity-bucket classifier for completed vBRIEFs (#1606).

The capacity engine (``scripts/capacity_show.py``, #1419 Slice 4) counts a
completed vBRIEF toward a bucket only when it carries an explicit
``plan.metadata.capacityBucket`` (and a ``plan.metadata.completedAt`` inside
the trailing window). ``task scope:complete`` stamps both fields going
FORWARD -- but only from ``defaultBucket`` -- so a pre-adoption tree
(directive itself included) has completed work that is *classification
cold-start*: the history exists, but every completion is unclassified, so the
``minSampleSize`` guard pins capacity in advisory mode forever.

This module is the deferred ``task capacity:backfill`` migration the #1419 RFC
("Brownfield Backfill") specified: a one-time, dry-run-default, git-reversible
pass that derives the two missing facts onto ``completed/`` vBRIEFs:

* ``plan.metadata.completedAt`` -- the git landing time of the file (the most
  recent commit that touched it), when not already present. Deterministic,
  zero human input.
* ``plan.metadata.capacityBucket`` (+ ``plan.metadata.capacityBucketSource``)
  -- inferred from the vBRIEF's origin-issue labels (its ``x-vbrief/github-issue``
  reference) matched against the declared ``capacityAllocation.buckets[].match.labels``
  predicates. A label match yields ``source="match"`` (high confidence); no
  match (or no cached issue / no issue reference) falls to ``defaultBucket``
  with ``source="default"`` and is surfaced in the low-confidence batch for
  human review.

Guarantees:

* **Dry-run by default.** Writes only with ``--apply``.
* **Idempotent.** An explicit existing ``capacityBucket`` / ``completedAt`` is
  preserved; a re-run is a no-op for already-stamped files.
* **Never mutates ``cost``** -- historical cost actuals are not backfillable
  (no telemetry exists for past runs); ``cost`` accrues forward only.
* **Offline.** Reads cached issue labels from ``.deft-cache/github-issue/``;
  no ``gh`` / network calls. Git is the only subprocess (landing time).

Exit codes (three-state, mirrors ``scripts/triage_reconcile.py``):

* ``0`` -- backfill completed (or was a no-op on a re-run / dry-run).
* ``1`` -- a runtime step failed (e.g. a write raised).
* ``2`` -- config error: ``--project-root`` missing, or
  ``plan.policy.capacityAllocation`` is not configured (nothing to classify
  against).

Refs: #1606 (this tool), #1419 (parent RFC -- Brownfield Backfill), #1511
(flip gates advisory -> enforce; backfill is its prerequisite).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Make sibling ``scripts`` modules importable when invoked as
# ``python scripts/capacity_backfill.py`` from the project root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _safe_subprocess import run_text  # noqa: E402
from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from policy import (  # noqa: E402
    load_project_definition,
    resolve_capacity_allocation,
)

reconfigure_stdio()

#: Lifecycle folder the backfill operates on (the backward / completed view).
COMPLETED_FOLDER: str = "completed"

#: Default location of the github-issue label cache (offline label source).
CACHE_RELPATH: tuple[str, ...] = (".deft-cache", "github-issue")

#: ``capacityBucketSource`` values this tool records.
SOURCE_MATCH: str = "match"  # a bucket match.labels predicate matched
SOURCE_DEFAULT: str = "default"  # no match -> defaultBucket (low confidence)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BucketMatcher:
    """A bucket id paired with its ``match.labels.any-of`` label set."""

    bucket_id: str
    labels: frozenset[str]


@dataclass(frozen=True)
class BackfillItem:
    """One completed vBRIEF's resolved backfill facts."""

    rel_path: str
    issue_number: int | None
    bucket: str
    source: str  # SOURCE_MATCH | SOURCE_DEFAULT
    set_bucket: bool  # capacityBucket was absent and will be / was stamped
    set_completed_at: bool  # completedAt was absent and will be / was stamped


@dataclass
class BackfillResult:
    """Aggregate result returned by :func:`backfill`."""

    project_root: Path
    dry_run: bool
    scanned: int = 0
    stamped_bucket: int = 0
    stamped_completed_at: int = 0
    already_classified: int = 0
    matched: int = 0
    defaulted: int = 0
    fetched: int = 0
    skipped_out_of_window: int = 0
    skipped_unreadable: int = 0
    window_only: bool = False
    window_days: int = 0
    items: list[BackfillItem] = field(default_factory=list)
    low_confidence: list[BackfillItem] = field(default_factory=list)
    error: str | None = None
    exit_code: int = 0

    def summary(self) -> str:
        """Render the human-readable recap the operator sees."""
        verb = "would stamp" if self.dry_run else "stamped"
        mark = "✓" if self.exit_code == 0 else "✗"
        lines = ["", "Capacity backfill recap:"]
        lines.append(
            f"  {mark} scanned {self.scanned} completed vBRIEF(s); "
            f"{verb} capacityBucket on {self.stamped_bucket} "
            f"(matched {self.matched}, defaulted {self.defaulted}); "
            f"{verb} completedAt on {self.stamped_completed_at}; "
            f"{self.already_classified} already classified"
        )
        if self.fetched:
            lines.append(
                f"      fetched labels for {self.fetched} uncached issue(s) via REST"
            )
        if self.window_only:
            lines.append(
                f"      window-only: skipped {self.skipped_out_of_window} "
                f"completion(s) outside the trailing {self.window_days}d window"
            )
        if self.skipped_unreadable:
            lines.append(
                f"      skipped {self.skipped_unreadable} unreadable/malformed "
                "completed vBRIEF file(s) (not counted in scanned)"
            )
        if self.error:
            lines.append(f"      error: {self.error}")
        if self.low_confidence:
            lines.append("")
            lines.append(
                f"  Low-confidence batch ({len(self.low_confidence)}) -- "
                "no label match, fell to defaultBucket; review + re-bucket as needed:"
            )
            for item in self.low_confidence:
                issue = f"#{item.issue_number}" if item.issue_number else "(no issue ref)"
                lines.append(f"    {issue} -> {item.bucket}  [{item.rel_path}]")
        if self.dry_run and self.exit_code == 0:
            lines.append("")
            lines.append("  Dry-run -- re-run with --apply to write these changes.")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Bucket-matcher resolution (reads the RAW match.labels the policy resolver drops)
# ---------------------------------------------------------------------------


def load_bucket_matchers(project_root: Path) -> tuple[list[BucketMatcher], str]:
    """Return ``(ordered matchers, default_bucket)`` from PROJECT-DEFINITION.

    ``resolve_capacity_allocation`` intentionally exposes only ``id`` + ``target``
    per bucket, so the raw ``match.labels.any-of`` predicate is read directly
    here (mirrors ``_lifecycle_hygiene.resolve_epic_thresholds`` reading the raw
    block for ``epicStrandedDays``). Matchers preserve declaration order so the
    first bucket whose label set intersects wins.
    """
    data, _err = load_project_definition(project_root)
    matchers: list[BucketMatcher] = []
    if not isinstance(data, dict):
        return matchers, ""
    plan = data.get("plan")
    policy = plan.get("policy") if isinstance(plan, dict) else None
    cap = policy.get("capacityAllocation") if isinstance(policy, dict) else None
    if not isinstance(cap, dict):
        return matchers, ""
    buckets = cap.get("buckets")
    if isinstance(buckets, list):
        for bucket in buckets:
            if not isinstance(bucket, dict):
                continue
            bucket_id = bucket.get("id")
            if not isinstance(bucket_id, str) or not bucket_id.strip():
                continue
            labels = _match_labels(bucket.get("match"))
            matchers.append(
                BucketMatcher(bucket_id=bucket_id.strip(), labels=frozenset(labels))
            )
    default_bucket = cap.get("defaultBucket")
    return matchers, default_bucket if isinstance(default_bucket, str) else ""


def _match_labels(match: Any) -> set[str]:
    """Extract the ``match.labels.any-of`` string set from a bucket block."""
    if not isinstance(match, dict):
        return set()
    labels = match.get("labels")
    if not isinstance(labels, dict):
        return set()
    any_of = labels.get("any-of")
    if not isinstance(any_of, list):
        return set()
    return {x for x in any_of if isinstance(x, str) and x}


def classify_bucket(
    issue_labels: set[str], matchers: list[BucketMatcher], default_bucket: str
) -> tuple[str, str]:
    """Return ``(bucket_id, source)`` for an issue's label set.

    First matcher (declaration order) whose ``labels`` intersect *issue_labels*
    wins with ``source="match"``. No intersection -> ``(default_bucket, "default")``.
    """
    for matcher in matchers:
        if matcher.labels & issue_labels:
            return matcher.bucket_id, SOURCE_MATCH
    return default_bucket, SOURCE_DEFAULT


# ---------------------------------------------------------------------------
# vBRIEF + cache + git helpers
# ---------------------------------------------------------------------------


def _parse_iso(value: Any) -> datetime | None:
    """Parse an ISO-8601 timestamp (``...Z`` or offset form) to aware UTC."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _to_iso_z(dt: datetime) -> str:
    """Render an aware datetime as the canonical ``...Z`` form used on disk."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def extract_issue_ref(plan: dict[str, Any]) -> tuple[str | None, int | None]:
    """Pull ``(repo, issue_number)`` from a vBRIEF plan's ``x-vbrief/github-issue`` ref."""
    refs = plan.get("references")
    if not isinstance(refs, list):
        return None, None
    for ref in refs:
        if not isinstance(ref, dict) or ref.get("type") != "x-vbrief/github-issue":
            continue
        uri = ref.get("uri")
        if not isinstance(uri, str):
            continue
        cleaned = uri.strip().rstrip("/")
        parts = [p for p in cleaned.split("://", 1)[-1].split("/") if p]
        if len(parts) >= 4 and parts[-2] == "issues" and parts[-1].isdigit():
            return f"{parts[-4]}/{parts[-3]}", int(parts[-1])
    return None, None


def cached_issue_labels(
    project_root: Path, repo: str, issue_number: int, *, cache_dir: Path | None = None
) -> set[str] | None:
    """Return the cached label set for ``repo#issue_number`` (offline), or None.

    None means the issue is not in the cache (a label match cannot be attempted);
    an empty set means the issue is cached but carries no labels.
    """
    base = cache_dir or project_root.joinpath(*CACHE_RELPATH)
    raw_path = base / repo / str(issue_number) / "raw.json"
    if not raw_path.is_file():
        return None
    try:
        data = json.loads(raw_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    labels = data.get("labels") if isinstance(data, dict) else None
    if not isinstance(labels, list):
        return set()
    out: set[str] = set()
    for label in labels:
        if isinstance(label, str) and label:
            out.add(label)
        elif isinstance(label, dict):
            name = label.get("name")
            if isinstance(name, str) and name:
                out.add(name)
    return out


def git_landing_time(repo_rel_path: str, project_root: Path) -> str | None:
    """Return the most recent commit timestamp touching *repo_rel_path*, as ``...Z``.

    *repo_rel_path* MUST be relative to the git repository root (e.g.
    ``vbrief/completed/<name>``), not the lifecycle folder. Uses
    ``git log -1 --format=%cI -- <path>`` (committer date, ISO-8601 strict) as a
    deterministic proxy for when the vBRIEF landed in ``completed/``. Returns None
    when git is unavailable or the file is untracked.
    """
    try:
        result = run_text(
            ["git", "log", "-1", "--format=%cI", "--", repo_rel_path],
            cwd=str(project_root),
        )
    except (OSError, ValueError):
        return None
    if result.returncode != 0:
        return None
    parsed = _parse_iso(result.stdout.strip())
    return _to_iso_z(parsed) if parsed is not None else None


def fetch_issue_labels(repo: str, issue_number: int) -> set[str] | None:
    """Fetch an issue's label set via the REST shim (closed-issue-safe), or None.

    Routes through ``scripts/gh_rest.rest_issue_view`` (REST, never GraphQL --
    respects the #954 bucket-hygiene rule and the #1145 scm-boundary). Imported
    lazily so the offline default path has no ``gh`` dependency and the unit
    tests need no network. Any failure (no gh, network error, malformed
    response) returns None so the caller falls back to the default bucket.
    """
    try:
        from gh_rest import rest_issue_view  # noqa: PLC0415 -- lazy, opt-in only

        issue = rest_issue_view(repo, issue_number)
    except Exception:  # noqa: BLE001 -- any fetch failure degrades to default
        return None
    labels = issue.get("labels") if isinstance(issue, dict) else None
    if not isinstance(labels, list):
        return set()
    out: set[str] = set()
    for label in labels:
        if isinstance(label, str) and label:
            out.add(label)
        elif isinstance(label, dict):
            name = label.get("name")
            if isinstance(name, str) and name:
                out.add(name)
    return out


# ---------------------------------------------------------------------------
# Core backfill logic
# ---------------------------------------------------------------------------


def backfill(
    project_root: Path,
    *,
    cache_dir: Path | None = None,
    dry_run: bool = True,
    window_only: bool = False,
    fetch: bool = False,
    now: datetime | None = None,
) -> BackfillResult:
    """Backfill ``capacityBucket`` / ``completedAt`` on completed vBRIEFs.

    Idempotent: explicit existing values are preserved. ``cost`` is never
    touched. When *window_only* is set, completions whose effective
    ``completedAt`` falls outside the trailing ``capacityAllocation.window``
    are skipped (the activation-critical subset is exactly the in-window one).
    When *fetch* is set, origin-issue labels missing from the local cache are
    pulled via the REST shim (the one-time online opt-in for brownfield history
    whose closed issues are not in the open-issue-scoped triage cache).
    """
    now_dt = now or datetime.now(UTC)
    allocation = resolve_capacity_allocation(project_root)
    result = BackfillResult(
        project_root=project_root,
        dry_run=dry_run,
        window_only=window_only,
        window_days=allocation.window_days,
    )
    if not allocation.configured:
        result.error = (
            "plan.policy.capacityAllocation is not configured -- configure "
            "buckets before backfilling (see #1419 / task capacity:show)"
        )
        result.exit_code = 2
        return result

    matchers, default_bucket = load_bucket_matchers(project_root)
    if not default_bucket:
        # resolve_capacity_allocation validated the block, but a missing
        # defaultBucket means unmatched work has nowhere to go -- fail loud.
        result.error = (
            "capacityAllocation.defaultBucket is required for backfill "
            "(unmatched completions must have a fallback bucket)"
        )
        result.exit_code = 2
        return result

    completed_dir = project_root / "vbrief" / COMPLETED_FOLDER
    if not completed_dir.is_dir():
        return result

    for path in sorted(completed_dir.glob("*.vbrief.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # Corrupted / non-UTF-8 / malformed-JSON files are skipped, but the
            # skip is now counted so the summary's ``scanned`` figure is not
            # silently lower than the actual file count (#1606 review).
            result.skipped_unreadable += 1
            continue
        plan = data.get("plan") if isinstance(data, dict) else None
        if not isinstance(plan, dict):
            continue
        result.scanned += 1
        rel_path = f"{COMPLETED_FOLDER}/{path.name}"
        git_rel_path = f"vbrief/{rel_path}"

        metadata = plan.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}

        existing_bucket = metadata.get("capacityBucket")
        has_bucket = isinstance(existing_bucket, str) and bool(existing_bucket.strip())
        existing_completed_at = metadata.get("completedAt")
        has_completed_at = (
            isinstance(existing_completed_at, str) and bool(existing_completed_at.strip())
        )

        # Resolve the effective completedAt (existing, else git landing time)
        # so the window filter and the stamp share one value.
        effective_completed_at = existing_completed_at if has_completed_at else None
        git_completed_at: str | None = None
        if not has_completed_at:
            git_completed_at = git_landing_time(git_rel_path, project_root)
            effective_completed_at = git_completed_at

        if window_only and not _in_window(effective_completed_at, allocation.window_days, now_dt):
            result.skipped_out_of_window += 1
            continue

        repo, issue_number = extract_issue_ref(plan)
        if has_bucket:
            result.already_classified += 1
            bucket = existing_bucket.strip()
            source = "preserved"
        else:
            labels: set[str] | None = None
            if repo and issue_number is not None:
                labels = cached_issue_labels(
                    project_root, repo, issue_number, cache_dir=cache_dir
                )
                if labels is None and fetch:
                    labels = fetch_issue_labels(repo, issue_number)
                    if labels is not None:
                        result.fetched += 1
            bucket, source = classify_bucket(labels or set(), matchers, default_bucket)

        set_bucket = not has_bucket
        set_completed_at = not has_completed_at and git_completed_at is not None

        item = BackfillItem(
            rel_path=rel_path,
            issue_number=issue_number,
            bucket=bucket,
            source=source,
            set_bucket=set_bucket,
            set_completed_at=set_completed_at,
        )
        result.items.append(item)

        # Write FIRST (apply mode), then tally -- so an OSError mid-run leaves
        # the summary counting only what actually reached disk, not the failed
        # item (#1606 review). Dry-run performs no write and falls straight to
        # the tally so it reports what it WOULD stamp.
        if not dry_run and (set_bucket or set_completed_at):
            try:
                _write_metadata(
                    path,
                    data,
                    plan,
                    metadata,
                    bucket=bucket if set_bucket else None,
                    source=source if set_bucket else None,
                    completed_at=git_completed_at if set_completed_at else None,
                )
            except OSError as exc:
                result.error = f"{type(exc).__name__}: {exc} ({rel_path})"
                result.exit_code = 1
                return result

        if set_bucket:
            result.stamped_bucket += 1
            if source == SOURCE_MATCH:
                result.matched += 1
            else:
                result.defaulted += 1
                result.low_confidence.append(item)
        if set_completed_at:
            result.stamped_completed_at += 1

    return result


def _in_window(completed_at: str | None, window_days: int, now: datetime) -> bool:
    """True when *completed_at* parses and falls within ``[0, window_days]`` of now."""
    parsed = _parse_iso(completed_at)
    if parsed is None:
        return False
    age_days = (now - parsed).total_seconds() / 86400.0
    return 0 <= age_days <= window_days


def _write_metadata(
    path: Path,
    data: dict[str, Any],
    plan: dict[str, Any],
    metadata: dict[str, Any],
    *,
    bucket: str | None,
    source: str | None,
    completed_at: str | None,
) -> None:
    """Stamp the resolved fields onto *plan.metadata* and write the file.

    ``cost`` is never read or written here. Mirrors the JSON write style of
    ``scripts/scope_lifecycle.py`` (2-space indent, ensure_ascii=False, trailing
    newline) so the diff stays minimal and encoding-clean.
    """
    if not isinstance(plan.get("metadata"), dict):
        plan["metadata"] = metadata
    if completed_at is not None:
        metadata["completedAt"] = completed_at
    if bucket is not None:
        metadata["capacityBucket"] = bucket
        if source is not None:
            metadata["capacityBucketSource"] = source
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _emit_json(result: BackfillResult) -> str:
    payload = {
        "project_root": str(result.project_root),
        "dry_run": result.dry_run,
        "scanned": result.scanned,
        "stamped_bucket": result.stamped_bucket,
        "stamped_completed_at": result.stamped_completed_at,
        "already_classified": result.already_classified,
        "matched": result.matched,
        "defaulted": result.defaulted,
        "fetched": result.fetched,
        "skipped_out_of_window": result.skipped_out_of_window,
        "skipped_unreadable": result.skipped_unreadable,
        "window_only": result.window_only,
        "window_days": result.window_days,
        "exit_code": result.exit_code,
        "error": result.error,
        "low_confidence": [
            {"issue_number": it.issue_number, "bucket": it.bucket, "rel_path": it.rel_path}
            for it in result.low_confidence
        ],
    }
    return json.dumps(payload, sort_keys=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="capacity_backfill.py",
        description=(
            "One-time capacity-bucket classifier for completed vBRIEFs (#1606). "
            "Stamps plan.metadata.capacityBucket (inferred from origin-issue "
            "labels via the configured bucket match rules) and completedAt "
            "(git landing time) onto completed/ vBRIEFs that lack them. "
            "Dry-run by default; idempotent; never touches cost."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=os.environ.get("DEFT_PROJECT_ROOT", "."),
        help="Path to the project root (default: $DEFT_PROJECT_ROOT or cwd).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write the changes. Without this flag the tool is a dry-run.",
    )
    parser.add_argument(
        "--window-only",
        action="store_true",
        dest="window_only",
        help=(
            "Only backfill completions whose completedAt falls within the "
            "trailing capacityAllocation.window -- the activation-critical "
            "subset capacity:show actually counts."
        ),
    )
    parser.add_argument(
        "--fetch",
        action="store_true",
        help=(
            "Pull origin-issue labels via the REST shim for issues missing from "
            "the local cache (a one-time online opt-in for brownfield history; "
            "closed issues are not in the open-issue-scoped triage cache). "
            "Without this flag the tool is fully offline."
        ),
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help=(
            "Override the github-issue label cache directory "
            "(default: <project-root>/.deft-cache/github-issue)."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="emit_json",
        help="Emit a structured JSON payload instead of the human recap.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        print(
            f"❌ capacity:backfill: --project-root {project_root} does not exist "
            "or is not a directory.",
            file=sys.stderr,
        )
        return 2

    cache_dir = Path(args.cache_dir).resolve() if args.cache_dir else None
    result = backfill(
        project_root,
        cache_dir=cache_dir,
        dry_run=not args.apply,
        window_only=args.window_only,
        fetch=args.fetch,
    )

    if args.emit_json:
        print(_emit_json(result))
    else:
        print(result.summary(), file=sys.stderr if result.exit_code else sys.stdout)

    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
