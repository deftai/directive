"""Tests for scripts/_cache_fetch.py FetchAllReport rename (#1247).

The pre-#1247 ``succeeded`` / ``failed`` / ``skipped`` counters misled
operators reading the ``triage:bootstrap step 1`` / ``task
cache:fetch-all`` recap (they read ``skipped=396`` as "396 items
dropped" when the value actually counted already-fresh cache entries
that did NOT need re-fetching). The rename introduces unambiguous
canonical names while keeping the legacy aliases for one release of
back-compat.

Also covers #1562 REST-batched bootstrap defaults: zero local delay,
paginated REST enumeration (no per-issue fetch), and in-loop progress.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_cache_fetch = importlib.import_module("_cache_fetch")
cache = importlib.import_module("cache")
FetchAllReport = _cache_fetch.FetchAllReport
run_fetch_all = _cache_fetch.run_fetch_all
PROGRESS_EVERY_N = _cache_fetch.PROGRESS_EVERY_N


def _rest_issue(number: int) -> dict[str, Any]:
    return {
        "number": number,
        "title": f"issue {number}",
        "body": "body",
        "state": "open",
        "labels": [],
        "updated_at": "2026-06-09T00:00:00Z",
    }


# ---------------------------------------------------------------------------
# #1562 -- delay-free REST-batched defaults + progress + REST enumeration
# ---------------------------------------------------------------------------


def test_default_delay_ms_is_zero_for_rest_batched_fetch() -> None:
    """Production default must not reintroduce multi-minute local sleeps (#1562)."""
    assert cache.DEFAULT_DELAY_MS == 0


def test_run_fetch_all_default_delay_does_not_sleep(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """REST-batched fetch with default delay_ms=0 must not call _sleep locally."""
    cohort_size = 25
    sleeps: list[float] = []

    def fake_lister(repo: str, **_: Any) -> list[dict[str, Any]]:
        return [_rest_issue(n) for n in range(1, cohort_size + 1)]

    monkeypatch.setattr(_cache_fetch, "_paginated_lister", fake_lister)
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda s: sleeps.append(s))

    report = run_fetch_all(
        repo="deftai/directive",
        is_fresh=lambda _p: False,
        entry_dir_for=lambda key: tmp_path / key.replace("/", "-"),
        do_put=lambda _k, _r: None,
        batch_size=10,
        delay_ms=cache.DEFAULT_DELAY_MS,
        state="open",
        limit=1000,
    )

    assert report.issues_written == cohort_size
    assert sleeps == []


def test_run_fetch_all_explicit_delay_ms_still_paces(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Operators can still opt into local pacing via a positive delay_ms."""
    sleeps: list[float] = []

    def fake_lister(repo: str, **_: Any) -> list[dict[str, Any]]:
        return [_rest_issue(1), _rest_issue(2)]

    monkeypatch.setattr(_cache_fetch, "_paginated_lister", fake_lister)
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda s: sleeps.append(s))

    run_fetch_all(
        repo="deftai/directive",
        is_fresh=lambda _p: False,
        entry_dir_for=lambda key: tmp_path / key.replace("/", "-"),
        do_put=lambda _k, _r: None,
        batch_size=1,
        delay_ms=500,
        state="open",
        limit=1000,
    )

    # Two issues at batch_size=1 -> per-issue sleep + batch checkpoint each.
    assert len(sleeps) >= 2
    assert all(s == pytest.approx(0.5) for s in sleeps)


def test_run_fetch_all_uses_paginated_rest_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Enumeration stays on rest_issue_list_paginated; no per-issue reads (#1562)."""
    list_calls: list[str] = []
    subprocess_calls: list[Any] = []

    def fake_lister(repo: str, **_: Any) -> list[dict[str, Any]]:
        list_calls.append(repo)
        return [_rest_issue(1), _rest_issue(2)]

    def spy_subprocess(*args: Any, **kwargs: Any) -> Any:
        subprocess_calls.append((args, kwargs))
        raise AssertionError("legacy GraphQL subprocess path must not run")

    monkeypatch.setattr(_cache_fetch, "_paginated_lister", fake_lister)
    monkeypatch.setattr(_cache_fetch, "_run_subprocess", spy_subprocess)
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)

    report = run_fetch_all(
        repo="deftai/directive",
        is_fresh=lambda _p: False,
        entry_dir_for=lambda key: tmp_path / key.replace("/", "-"),
        do_put=lambda _k, _r: None,
        batch_size=10,
        delay_ms=0,
        state="open",
        limit=1000,
    )

    assert report.issues_written == 2
    assert list_calls == ["deftai/directive"]
    assert subprocess_calls == []


def test_run_fetch_all_emits_progress_for_large_cohort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Large cohorts emit enumerated + periodic writing progress (#1562)."""
    total = PROGRESS_EVERY_N * 2
    progress_lines: list[str] = []

    def fake_lister(repo: str, **_: Any) -> list[dict[str, Any]]:
        return [_rest_issue(n) for n in range(1, total + 1)]

    monkeypatch.setattr(_cache_fetch, "_paginated_lister", fake_lister)
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)
    monkeypatch.setattr(
        _cache_fetch,
        "_progress_writer",
        lambda line: progress_lines.append(line),
    )

    report = run_fetch_all(
        repo="deftai/directive",
        is_fresh=lambda _p: False,
        entry_dir_for=lambda key: tmp_path / key.replace("/", "-"),
        do_put=lambda _k, _r: None,
        batch_size=10,
        delay_ms=0,
        state="open",
        limit=1000,
    )

    assert report.issues_written == total
    joined = "".join(progress_lines)
    assert "enumerated=" in joined
    assert "writing cache entries" in joined
    assert f"processed={PROGRESS_EVERY_N}/{total}" in joined
    assert f"processed={total}/{total}" in joined
    assert "issues_written=" in joined
    assert "already_fresh=" in joined
    assert "issues_failed=" in joined


def test_run_fetch_all_progress_counts_already_fresh_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Progress tracks loop position even when many entries are already fresh."""
    total = PROGRESS_EVERY_N * 2
    progress_lines: list[str] = []
    writes: list[str] = []

    def fake_lister(repo: str, **_: Any) -> list[dict[str, Any]]:
        return [_rest_issue(n) for n in range(1, total + 1)]

    def is_fresh(path: Path) -> bool:
        number = int(path.parent.name.rsplit("-", 1)[-1])
        return number <= PROGRESS_EVERY_N

    monkeypatch.setattr(_cache_fetch, "_paginated_lister", fake_lister)
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)
    monkeypatch.setattr(
        _cache_fetch,
        "_progress_writer",
        lambda line: progress_lines.append(line),
    )

    report = run_fetch_all(
        repo="deftai/directive",
        is_fresh=is_fresh,
        entry_dir_for=lambda key: tmp_path / key.replace("/", "-"),
        do_put=lambda key, _r: writes.append(key),
        batch_size=10,
        delay_ms=0,
        state="open",
        limit=1000,
    )

    assert report.already_fresh == PROGRESS_EVERY_N
    assert report.issues_written == PROGRESS_EVERY_N
    assert len(writes) == PROGRESS_EVERY_N
    joined = "".join(progress_lines)
    assert f"processed={PROGRESS_EVERY_N}/{total}" in joined
    assert f"processed={total}/{total}" in joined
    assert f"already_fresh={PROGRESS_EVERY_N}" in joined


def test_emit_fetch_progress_uses_rebindable_flusher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tests and log adapters can replace both progress writer and flusher."""
    progress_lines: list[str] = []
    flushes: list[str] = []

    monkeypatch.setattr(
        _cache_fetch,
        "_progress_writer",
        lambda line: progress_lines.append(line),
    )
    monkeypatch.setattr(_cache_fetch, "_progress_flusher", lambda: flushes.append("flush"))

    _cache_fetch._emit_fetch_progress(
        repo="deftai/directive",
        phase="writing",
        processed=1,
        total=1,
        report=FetchAllReport(issues_written=1),
    )

    assert progress_lines == [
        "cache:fetch-all progress repo=deftai/directive "
        "processed=1/1 issues_written=1 already_fresh=0 issues_failed=0\n"
    ]
    assert flushes == ["flush"]


def test_run_fetch_all_skips_progress_for_small_cohort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cohorts below PROGRESS_EVERY_N stay quiet (fast enough without chatter)."""
    progress_lines: list[str] = []

    def fake_lister(repo: str, **_: Any) -> list[dict[str, Any]]:
        return [_rest_issue(n) for n in range(1, PROGRESS_EVERY_N)]

    monkeypatch.setattr(_cache_fetch, "_paginated_lister", fake_lister)
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)
    monkeypatch.setattr(
        _cache_fetch,
        "_progress_writer",
        lambda line: progress_lines.append(line),
    )

    run_fetch_all(
        repo="deftai/directive",
        is_fresh=lambda _p: False,
        entry_dir_for=lambda key: tmp_path / key.replace("/", "-"),
        do_put=lambda _k, _r: None,
        batch_size=10,
        delay_ms=0,
        state="open",
        limit=1000,
    )

    assert progress_lines == []


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
