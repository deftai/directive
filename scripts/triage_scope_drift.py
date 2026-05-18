#!/usr/bin/env python3
"""triage_scope_drift.py -- subscription drift detection (D14 / #1133).

Walks the unified ``.deft-cache/github-issue/<owner>/<repo>/<N>/raw.json``
mirror (#883 Story 2) and computes:

* ``unsubscribed-labels``: labels appearing on >= ``_DRIFT_MIN_ISSUES``
  cached issues whose latest state is ``open`` AND that are NOT covered
  by any active ``plan.policy.triageScope[]`` rule.
* ``unsubscribed-milestones``: milestones with >= ``_DRIFT_MIN_ISSUES``
  open cached issues NOT covered by any ``milestone`` rule (D14 / #1133
  v1 exact-match shape).

The threshold is a framework constant at module top per umbrella #1119
section 12 framework-vs-consumer boundary; consumer tunability (e.g.
``plan.policy.driftMinIssues``) is explicitly v2 scope.

Entries that the operator has explicitly chosen to ignore via
``plan.policy.triageScopeIgnores[]`` are suppressed from the surfaced
counts AND from the rendered output (D14c / #1182 will introduce
sunset-on / mass-edit tuning verbs on top of this foundation).

Public surface:

* :data:`_DRIFT_MIN_ISSUES` -- the v1 threshold (3).
* :class:`DriftReport` -- frozen dataclass with per-signal counts and
  the total surfaced issue count (the number D2's one-liner segment
  consumes).
* :func:`compute_drift` -- read-only computation; never mutates state.
* :func:`render_drift_report` -- human-readable rendering of a report.
* :func:`add_ignore` -- atomic mutation that appends a
  ``{label|milestone: <name>}`` entry to
  ``plan.policy.triageScopeIgnores[]``.

CLI shim lives at ``scripts/_triage_scope_drift_cli.py`` so this module
stays under the 1000-line MUST cap from ``coding/coding.md``.
"""

from __future__ import annotations

import contextlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Sibling imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure (mirrors triage_scope.py / triage_summary.py).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Framework drift-threshold (D14 / #1133). A label or milestone is
#: surfaced as drift only if at least this many currently-open cached
#: issues carry it AND it is not covered by the active subscription.
#: The constant lives here so future tunability (``plan.policy.driftMinIssues``,
#: v2 scope) has a single source of truth to override.
_DRIFT_MIN_ISSUES: int = 3

#: Cache directory + source name. Mirrors ``triage_summary.CACHE_DIR_NAME``
#: + ``CACHE_SOURCE`` so the drift detector reads the same layout the
#: summary verb consumes.
CACHE_DIR_NAME = ".deft-cache"
CACHE_SOURCE = "github-issue"


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DriftReport:
    """Structured drift report.

    Two parallel mappings (label/milestone -> issue count) plus the
    aggregate ``total`` that D2's ``[scope-drift] N`` segment renders.
    The total equals the number of distinct open cached issues that
    would join the subscription if every surfaced signal were opted
    into (NOT the sum of counts: an issue with two unsubscribed labels
    counts once).
    """

    labels: dict[str, int] = field(default_factory=dict)
    milestones: dict[str, int] = field(default_factory=dict)
    total: int = 0
    threshold: int = _DRIFT_MIN_ISSUES

    def is_empty(self) -> bool:
        """True when neither labels nor milestones have any surfaced drift."""
        return not self.labels and not self.milestones


# ---------------------------------------------------------------------------
# Cache walker
# ---------------------------------------------------------------------------


def _iter_cache_issues(cache_root: Path) -> list[dict[str, Any]]:
    """Walk ``<cache_root>/github-issue/<owner>/<repo>/<N>/raw.json``.

    Returns the list of raw GitHub-issue payloads (each a dict). Bad /
    missing files are silently skipped -- the drift detector MUST NOT
    crash on a torn cache, mirroring the tolerance contract in
    ``triage_summary.read_audit_log``.
    """
    base = cache_root / CACHE_SOURCE
    if not base.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for owner_dir in sorted(base.iterdir(), key=lambda p: p.name):
        if not owner_dir.is_dir():
            continue
        for repo_dir in sorted(owner_dir.iterdir(), key=lambda p: p.name):
            if not repo_dir.is_dir():
                continue
            for issue_dir in sorted(repo_dir.iterdir(), key=lambda p: p.name):
                if not issue_dir.is_dir() or not issue_dir.name.isdecimal():
                    continue
                raw_path = issue_dir / "raw.json"
                if not raw_path.is_file():
                    continue
                try:
                    data = json.loads(raw_path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError, UnicodeDecodeError):
                    continue
                if isinstance(data, dict):
                    out.append(data)
    return out


def _extract_labels(issue: dict[str, Any]) -> set[str]:
    raw = issue.get("labels")
    if not isinstance(raw, list):
        return set()
    names: set[str] = set()
    for item in raw:
        if isinstance(item, dict):
            name = item.get("name")
            if isinstance(name, str) and name:
                names.add(name)
        elif isinstance(item, str) and item:
            names.add(item)
    return names


def _extract_milestone(issue: dict[str, Any]) -> str:
    raw = issue.get("milestone")
    if isinstance(raw, dict):
        title = raw.get("title")
        if isinstance(title, str) and title:
            return title
        alt = raw.get("name")
        if isinstance(alt, str) and alt:
            return alt
    elif isinstance(raw, str) and raw:
        return raw
    return ""


def _is_open(issue: dict[str, Any]) -> bool:
    return issue.get("state", "open") == "open"


# ---------------------------------------------------------------------------
# Subscription coverage helpers
# ---------------------------------------------------------------------------


def _subscribed_labels(rules: list[dict[str, Any]]) -> set[str]:
    """Return the set of label names covered by any ``labels`` rule.

    Both ``any-of`` and ``all-of`` shapes contribute -- the question
    the drift detector asks is "does the subscription mention this
    label at all?", not "does the subscription match issues with this
    label?". A label appearing in ``all-of`` still suppresses drift
    because the operator obviously already knows about it.
    """
    out: set[str] = set()
    for rule in rules:
        if not isinstance(rule, dict) or rule.get("rule") != "labels":
            continue
        for key in ("any-of", "all-of"):
            value = rule.get(key)
            if isinstance(value, list):
                for label in value:
                    if isinstance(label, str) and label:
                        out.add(label)
    return out


def _subscribed_milestones(rules: list[dict[str, Any]]) -> set[str]:
    """Return the set of milestone names covered by any ``milestone`` rule."""
    out: set[str] = set()
    for rule in rules:
        if not isinstance(rule, dict) or rule.get("rule") != "milestone":
            continue
        name = rule.get("name")
        if isinstance(name, str) and name:
            out.add(name)
    return out


# ---------------------------------------------------------------------------
# Public API: compute / render / mutate
# ---------------------------------------------------------------------------


def compute_drift(
    project_root: Path,
    *,
    cache_root: Path | None = None,
    threshold: int | None = None,
) -> DriftReport:
    """Compute the drift report for a project.

    ``cache_root`` defaults to ``<project_root>/.deft-cache``.
    ``threshold`` defaults to :data:`_DRIFT_MIN_ISSUES`; passing an
    override is supported for tests but consumers SHOULD let the
    framework default stand (D14 / #1133 ships the threshold as a
    framework constant; per-consumer tunability is v2 scope).

    Read-only: never mutates PROJECT-DEFINITION, the cache, or the
    audit log. Empty cache yields an empty report (``total == 0``).
    """
    from triage_scope import resolve_scope_ignores, resolve_scope_rules

    resolved_cache_root = cache_root or (project_root / CACHE_DIR_NAME)
    effective_threshold = (
        threshold if threshold is not None and threshold > 0 else _DRIFT_MIN_ISSUES
    )

    issues = _iter_cache_issues(resolved_cache_root)
    rules = resolve_scope_rules(project_root)
    ignores = resolve_scope_ignores(project_root)

    # `all-open` subscribes to every currently-open upstream issue by
    # definition (umbrella section 12 framework default when
    # ``plan.policy.triageScope[]`` is unset / missing). Under that
    # rule every cached open issue is already in scope, so no label
    # or milestone can be "unsubscribed" -- the drift detector would
    # otherwise spuriously flag every label/milestone on >=3 cached
    # open issues for the entire default-config consumer base.
    # Short-circuit to an empty report so D2's `[scope-drift] N`
    # segment stays suppressed (segment renders only when N > 0).
    if any(isinstance(r, dict) and r.get("rule") == "all-open" for r in rules):
        return DriftReport(threshold=effective_threshold)

    subscribed_labels = _subscribed_labels(rules)
    subscribed_milestones = _subscribed_milestones(rules)

    label_counts: dict[str, int] = {}
    milestone_counts: dict[str, int] = {}
    # Track which issues are surfaced under any drift signal so
    # ``total`` counts distinct issues, not signal-occurrences.
    surfaced_issues: set[tuple[str, int]] = set()

    for issue in issues:
        if not _is_open(issue):
            continue
        number = issue.get("number")
        if not isinstance(number, int):
            continue
        labels = _extract_labels(issue)
        for label in labels:
            if label in subscribed_labels or label in ignores["labels"]:
                continue
            label_counts[label] = label_counts.get(label, 0) + 1
        milestone = _extract_milestone(issue)
        if (
            milestone
            and milestone not in subscribed_milestones
            and milestone not in ignores["milestones"]
        ):
            milestone_counts[milestone] = milestone_counts.get(milestone, 0) + 1

    surfaced_labels = {
        label: count
        for label, count in label_counts.items()
        if count >= effective_threshold
    }
    surfaced_milestones = {
        name: count
        for name, count in milestone_counts.items()
        if count >= effective_threshold
    }

    # Re-walk to compute the distinct-issue total -- an issue counts
    # toward ``total`` if any of its labels / its milestone is surfaced.
    for issue in issues:
        if not _is_open(issue):
            continue
        number = issue.get("number")
        if not isinstance(number, int):
            continue
        repo_key = _issue_repo_key(issue)
        labels = _extract_labels(issue)
        milestone = _extract_milestone(issue)
        if any(label in surfaced_labels for label in labels) or (
            milestone and milestone in surfaced_milestones
        ):
            surfaced_issues.add((repo_key, number))

    return DriftReport(
        labels=dict(sorted(surfaced_labels.items())),
        milestones=dict(sorted(surfaced_milestones.items())),
        total=len(surfaced_issues),
        threshold=effective_threshold,
    )


def _issue_repo_key(issue: dict[str, Any]) -> str:
    """Best-effort repo identifier for a cached issue.

    Tries ``repository_url`` (the canonical REST field), falls back to
    ``html_url``, finally to the empty string. Only used to dedupe the
    distinct-issue total when an operator caches the same issue number
    under two different repos; consumers with a single repo see ``""``
    consistently and the dedupe degrades to a per-number set.
    """
    for key in ("repository_url", "html_url"):
        value = issue.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def render_drift_report(report: DriftReport) -> str:
    """Render a human-readable view of the report.

    Format (#1133 issue body, lightly adapted)::

        [scope-drift] labels not in subscription:
          priority:p0       (12 open issues)
          compat:breaking   (4 open issues)
        [scope-drift] milestones not in subscription:
          v2.0-blocker      (7 open issues)

        To subscribe:
          task triage:subscribe -- --label=priority:p0
          task triage:subscribe -- --milestone=v2.0-blocker

        To suppress (record explicit ignore):
          task triage:scope-drift -- --ignore-label=priority:p0
          task triage:scope-drift -- --ignore-milestone=v2.0-blocker

    Empty reports render a brief "no drift" notice so the operator can
    distinguish "ran, none surfaced" from "task failed silently".
    """
    if report.is_empty():
        return (
            "[scope-drift] no unsubscribed labels / milestones found "
            f"(threshold: >= {report.threshold} cached open issues)."
        )

    lines: list[str] = []
    if report.labels:
        lines.append("[scope-drift] labels not in subscription:")
        width = max(len(name) for name in report.labels)
        for name, count in report.labels.items():
            lines.append(f"  {name.ljust(width)}  ({count} open issues)")
    if report.milestones:
        if lines:
            lines.append("")
        lines.append("[scope-drift] milestones not in subscription:")
        width = max(len(name) for name in report.milestones)
        for name, count in report.milestones.items():
            lines.append(f"  {name.ljust(width)}  ({count} open issues)")

    lines.append("")
    lines.append("To subscribe:")
    for name in report.labels:
        lines.append(f"  task triage:subscribe -- --label={name}")
    for name in report.milestones:
        lines.append(f"  task triage:subscribe -- --milestone={name}")

    lines.append("")
    lines.append("To suppress (record explicit ignore):")
    for name in report.labels:
        lines.append(f"  task triage:scope-drift -- --ignore-label={name}")
    for name in report.milestones:
        lines.append(f"  task triage:scope-drift -- --ignore-milestone={name}")

    return "\n".join(lines)


def add_ignore(
    project_root: Path,
    *,
    label: str | None = None,
    milestone: str | None = None,
) -> tuple[bool, str]:
    """Append a ``{label|milestone: <name>}`` entry to ``plan.policy.triageScopeIgnores[]``.

    Exactly one of ``label`` / ``milestone`` MUST be set. Returns
    ``(changed, message)`` -- ``changed`` is False when the entry is
    already present (idempotent contract). Writes atomically via
    ``os.replace`` so a crash mid-write leaves the file untouched.

    Raises ``ValueError`` when both / neither argument is supplied or
    when the value is empty.
    """
    if (label is None) == (milestone is None):
        raise ValueError(
            "add_ignore() requires exactly one of label= / milestone="
        )
    key = "label" if label is not None else "milestone"
    value = (label if label is not None else milestone) or ""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string; got {value!r}")

    from _project_definition_io import (
        atomic_write_project_definition,
        load_project_definition_for_mutation,
    )

    data, path = load_project_definition_for_mutation(project_root)
    plan = data.setdefault("plan", {})
    if not isinstance(plan, dict):
        raise ValueError(
            f"PROJECT-DEFINITION at {path} has a non-object 'plan' key"
        )
    policy = plan.setdefault("policy", {})
    if not isinstance(policy, dict):
        raise ValueError(
            f"PROJECT-DEFINITION at {path} has a non-object 'plan.policy' key"
        )
    raw = policy.setdefault("triageScopeIgnores", [])
    if not isinstance(raw, list):
        raise ValueError(
            f"PROJECT-DEFINITION at {path} has a non-list 'plan.policy.triageScopeIgnores'"
        )

    for entry in raw:
        if isinstance(entry, dict) and entry.get(key) == value:
            return False, f"already-ignored ({key}={value})"

    raw.append({key: value})
    atomic_write_project_definition(path, data)
    return True, f"added ignore ({key}={value})"


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Delegates to :mod:`_triage_scope_drift_cli`."""
    import sys as _sys

    from _triage_scope_drift_cli import run_cli  # local import: 1000-line cap

    return run_cli(argv, _sys.modules[__name__])


if __name__ == "__main__":
    sys.exit(main())
