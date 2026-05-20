"""Tests for scripts/_cache_fetch.py FetchAllReport rename (#1247).

The pre-#1247 ``succeeded`` / ``failed`` / ``skipped`` counters misled
operators reading the ``triage:bootstrap step 1`` / ``task
cache:fetch-all`` recap (they read ``skipped=396`` as "396 items
dropped" when the value actually counted already-fresh cache entries
that did NOT need re-fetching). The rename introduces unambiguous
canonical names while keeping the legacy aliases for one release of
back-compat.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_cache_fetch = importlib.import_module("_cache_fetch")
FetchAllReport = _cache_fetch.FetchAllReport


# ---------------------------------------------------------------------------
# Canonical attribute names (#1247)
# ---------------------------------------------------------------------------


def test_canonical_attributes_default_to_zero():
    report = FetchAllReport()
    assert report.issues_written == 0
    assert report.already_fresh == 0
    assert report.issues_failed == 0
    assert report.failures == []


def test_canonical_attributes_assignable_directly():
    report = FetchAllReport()
    report.issues_written = 5
    report.already_fresh = 10
    report.issues_failed = 1
    assert report.issues_written == 5
    assert report.already_fresh == 10
    assert report.issues_failed == 1


# ---------------------------------------------------------------------------
# Legacy alias back-compat (#1247)
# ---------------------------------------------------------------------------


def test_legacy_aliases_read_through_to_canonical():
    report = FetchAllReport(issues_written=7, already_fresh=3, issues_failed=1)
    # Legacy alias accessors must read through to the canonical fields
    # so external callers (triage_bootstrap recap formatter,
    # tests/test_cache.py, tests/integration/test_cache_*.py) keep
    # working without modification.
    assert report.succeeded == 7
    assert report.skipped == 3
    assert report.failed == 1


def test_legacy_aliases_write_through_to_canonical():
    report = FetchAllReport()
    report.succeeded = 4
    report.failed = 2
    report.skipped = 8
    # Setters update the canonical attributes.
    assert report.issues_written == 4
    assert report.issues_failed == 2
    assert report.already_fresh == 8


def test_legacy_increments_compose_with_canonical_reads():
    """`report.succeeded += 1` must increment via the property setter.

    This is the exact pattern :func:`run_fetch_all` uses internally;
    breaking it would silently zero the counters on every run.
    """
    report = FetchAllReport()
    report.succeeded += 1
    report.succeeded += 1
    report.failed += 1
    report.skipped += 3
    assert report.issues_written == 2
    assert report.issues_failed == 1
    assert report.already_fresh == 3


# ---------------------------------------------------------------------------
# to_json() emits both canonical and legacy keys (#1247)
# ---------------------------------------------------------------------------


def test_to_json_includes_canonical_keys():
    report = FetchAllReport(issues_written=1, already_fresh=396, issues_failed=0)
    payload = json.loads(report.to_json())
    # Canonical keys present and carry the right values.
    assert payload["issues_written"] == 1
    assert payload["already_fresh"] == 396
    assert payload["issues_failed"] == 0


def test_to_json_preserves_legacy_keys_for_back_compat():
    """Legacy aliases survive in to_json() for one release of back-compat.

    Existing consumers (``tests/test_cache.py::test_partial_failure_exit_shape``
    reads ``payload['succeeded']`` / ``payload['failed']``) keep working.
    """
    report = FetchAllReport(issues_written=1, already_fresh=396, issues_failed=2)
    payload = json.loads(report.to_json())
    assert payload["succeeded"] == 1
    assert payload["skipped"] == 396
    assert payload["failed"] == 2


def test_to_json_emits_failures_list_unchanged():
    failures = [{"key": "owner/repo/42", "reason": "boom"}]
    report = FetchAllReport(issues_written=0, issues_failed=1, failures=list(failures))
    payload = json.loads(report.to_json())
    assert payload["failures"] == failures


# ---------------------------------------------------------------------------
# summary_line() renders the unambiguous human-readable recap (#1247)
# ---------------------------------------------------------------------------


def test_summary_line_uses_unambiguous_noun_names():
    report = FetchAllReport(issues_written=1, already_fresh=396, issues_failed=0)
    line = report.summary_line(source="github-issue", repo="deftai/directive")
    # The unambiguous counter names are present.
    assert "issues_written=1" in line
    assert "already_fresh=396" in line
    assert "issues_failed=0" in line
    # And the misleading legacy nouns are NOT in the user-visible line.
    assert "succeeded=" not in line
    assert "skipped=" not in line
    # The "skipped" suffix appears only inside "already_fresh" never as
    # a standalone token -- check exact word boundary by re-asserting.
    assert " skipped " not in f" {line} "


def test_summary_line_includes_source_and_repo():
    report = FetchAllReport()
    line = report.summary_line(source="github-issue", repo="owner/name")
    assert "source=github-issue" in line
    assert "repo=owner/name" in line
    assert line.startswith("cache:fetch-all ")


def test_summary_line_renders_when_all_three_counters_nonzero():
    report = FetchAllReport(issues_written=10, already_fresh=20, issues_failed=2)
    line = report.summary_line(source="github-issue", repo="o/r")
    assert "issues_written=10" in line
    assert "already_fresh=20" in line
    assert "issues_failed=2" in line
