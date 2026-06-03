"""Regression tests for #1476 -- upstream-closed issues in triage:queue.

`task triage:queue` ranks issues whose cached ``raw.json`` still says
``state=open`` even after the upstream GitHub issue closed, because
``cache:fetch-all`` defaults to ``state=open`` and never rewrites a closed
entry within its 7-day TTL (the #1322 shape recorded in #1476). These tests
cover the two-part fix:

1. The cache state-refresh path (``_cache_fetch.run_state_refresh`` +
   ``cache.cache_refresh_closed``) revisits cached-open entries that
   dropped out of the open enumeration and rewrites the closed ones to
   ``state=closed``.
2. The end-to-end #1322 shape: after the refresh runs, ``task triage:queue``
   omits the closed candidate.
3. The queue's read-side defensive ``state_resolver`` seam in
   ``triage_queue.load_cached_issues``.
4. The shared ``preflight_cache.is_fetched_at_stale`` freshness predicate.

The suite is hermetic: the gh REST seams (``_paginated_lister`` and
``_single_issue_fetcher``) are monkeypatched so no network is touched.
"""

from __future__ import annotations

import importlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_queue = importlib.import_module("triage_queue")
preflight_cache = importlib.import_module("preflight_cache")
cache = importlib.import_module("cache")
_cache_fetch = importlib.import_module("_cache_fetch")

REPO = "deftai/directive"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _seed_entry(
    cache_root: Path,
    repo: str,
    number: int,
    *,
    state: str,
    fetched_at: str,
    title: str = "title",
    labels: list[str] | None = None,
) -> Path:
    """Write a ``raw.json`` + ``meta.json`` cache entry under ``cache_root``."""
    owner, name = repo.split("/", 1)
    edir = cache_root / "github-issue" / owner / name / str(number)
    edir.mkdir(parents=True, exist_ok=True)
    raw = {
        "number": number,
        "state": state,
        "title": title,
        "body": "body",
        "labels": [{"name": label} for label in (labels or [])],
        "updated_at": "2026-06-01T00:00:00Z",
    }
    (edir / "raw.json").write_text(json.dumps(raw, sort_keys=True), encoding="utf-8")
    (edir / "meta.json").write_text(
        json.dumps({"fetched_at": fetched_at}), encoding="utf-8"
    )
    return edir


def _read_state(cache_root: Path, repo: str, number: int) -> str:
    owner, name = repo.split("/", 1)
    raw_path = cache_root / "github-issue" / owner / name / str(number) / "raw.json"
    return json.loads(raw_path.read_text(encoding="utf-8"))["state"]


# ---------------------------------------------------------------------------
# preflight_cache.is_fetched_at_stale (#1476 shared predicate)
# ---------------------------------------------------------------------------


_NOW = datetime(2026, 6, 3, 19, 0, 0, tzinfo=UTC)


def test_is_fetched_at_stale_fresh_entry_is_not_stale() -> None:
    assert (
        preflight_cache.is_fetched_at_stale("2026-06-03T18:30:00Z", now=_NOW) is False
    )


def test_is_fetched_at_stale_old_entry_is_stale() -> None:
    # 2 days old, default 24h window.
    assert preflight_cache.is_fetched_at_stale("2026-06-01T17:09:02Z", now=_NOW) is True


def test_is_fetched_at_stale_missing_is_stale() -> None:
    assert preflight_cache.is_fetched_at_stale(None, now=_NOW) is True
    assert preflight_cache.is_fetched_at_stale("", now=_NOW) is True


def test_is_fetched_at_stale_window_zero_disables() -> None:
    assert (
        preflight_cache.is_fetched_at_stale(
            "2020-01-01T00:00:00Z", max_age_hours=0, now=_NOW
        )
        is False
    )


def test_is_fetched_at_stale_future_clock_skew_is_fresh() -> None:
    assert (
        preflight_cache.is_fetched_at_stale("2026-06-04T00:00:00Z", now=_NOW) is False
    )


# ---------------------------------------------------------------------------
# _cache_fetch.run_state_refresh (A2 -- rewrite closed entries)
# ---------------------------------------------------------------------------


def test_run_state_refresh_rewrites_closed_upstream_entry() -> None:
    puts: list[tuple[str, dict]] = []

    report = _cache_fetch.run_state_refresh(
        repo=REPO,
        open_numbers={100},
        cached_open=[
            (100, {"number": 100, "state": "open"}),
            (1322, {"number": 1322, "state": "open"}),
        ],
        do_put=lambda key, raw: puts.append((key, raw)),
        fetch_single=lambda _repo, n: {"number": n, "state": "CLOSED", "title": "x"},
        delay_ms=0,
    )

    # #100 stays (still in the open enumeration) -- never revisited.
    # #1322 vanished from the enumeration -> revisited -> closed -> rewritten.
    assert report.revisited == 1
    assert report.closed_rewritten == 1
    assert report.still_open == 0
    assert report.refresh_failed == 0
    assert len(puts) == 1
    key, raw = puts[0]
    assert key == "deftai/directive/1322"
    # State is normalised to lowercase before the rewrite.
    assert raw["state"] == "closed"


def test_run_state_refresh_leaves_still_open_entries_untouched() -> None:
    puts: list[tuple[str, dict]] = []
    report = _cache_fetch.run_state_refresh(
        repo=REPO,
        open_numbers=set(),
        cached_open=[(1322, {"number": 1322, "state": "open"})],
        do_put=lambda key, raw: puts.append((key, raw)),
        fetch_single=lambda _repo, _n: {"number": 1322, "state": "open"},
        delay_ms=0,
    )
    assert report.revisited == 1
    assert report.still_open == 1
    assert report.closed_rewritten == 0
    assert puts == []


def test_run_state_refresh_records_fetch_failures() -> None:
    def _boom(_repo: str, _n: int) -> dict:
        raise RuntimeError("network unreachable")

    report = _cache_fetch.run_state_refresh(
        repo=REPO,
        open_numbers=set(),
        cached_open=[(1322, {"number": 1322, "state": "open"})],
        do_put=lambda *_a: None,
        fetch_single=_boom,
        delay_ms=0,
    )
    assert report.revisited == 1
    assert report.refresh_failed == 1
    assert report.closed_rewritten == 0
    assert report.failures and report.failures[0]["key"] == "deftai/directive/1322"


def test_list_open_issue_numbers_projects_numbers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        _cache_fetch,
        "_paginated_lister",
        lambda _repo, *, state, limit: [
            {"number": 1},
            {"number": 2},
            {"no_number": True},
        ],
    )
    assert _cache_fetch.list_open_issue_numbers(REPO) == {1, 2}


# ---------------------------------------------------------------------------
# cache.cache_refresh_closed (end-to-end against a tmp cache)
# ---------------------------------------------------------------------------


def test_cache_refresh_closed_rewrites_disk_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache_root = tmp_path / ".deft-cache"
    _seed_entry(cache_root, REPO, 100, state="open", fetched_at="2026-06-03T18:00:00Z")
    _seed_entry(
        cache_root, REPO, 1322, state="open", fetched_at="2026-06-01T17:09:02Z"
    )

    # Open enumeration no longer returns #1322; the single-issue fetch
    # reports it closed.
    monkeypatch.setattr(
        _cache_fetch,
        "_paginated_lister",
        lambda _repo, *, state, limit: [{"number": 100}],
    )
    monkeypatch.setattr(
        _cache_fetch,
        "_single_issue_fetcher",
        lambda _repo, n: {"number": n, "state": "closed", "title": "deft-install"},
    )

    report = cache.cache_refresh_closed(
        source="github-issue", repo=REPO, cache_root=cache_root, delay_ms=0
    )

    assert report.closed_rewritten == 1
    # #1322 rewritten to closed on disk; #100 left open.
    assert _read_state(cache_root, REPO, 1322) == "closed"
    assert _read_state(cache_root, REPO, 100) == "open"


def test_cache_refresh_closed_no_op_on_empty_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    called = {"listed": False}

    def _lister(*_a, **_k):
        called["listed"] = True
        return []

    monkeypatch.setattr(_cache_fetch, "_paginated_lister", _lister)
    report = cache.cache_refresh_closed(
        source="github-issue", repo=REPO, cache_root=tmp_path / ".deft-cache"
    )
    assert report.closed_rewritten == 0
    assert report.revisited == 0
    # No cached-open entries -> the open enumeration is skipped entirely.
    assert called["listed"] is False


def test_cache_refresh_closed_rejects_bad_source(tmp_path: Path) -> None:
    with pytest.raises(cache.CacheError):
        cache.cache_refresh_closed(
            source="gitlab-issue", repo=REPO, cache_root=tmp_path
        )


# ---------------------------------------------------------------------------
# End-to-end #1322 regression: refresh, then triage:queue omits the candidate
# ---------------------------------------------------------------------------


def test_refresh_then_queue_omits_closed_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    cache_root = tmp_path / ".deft-cache"
    _seed_entry(cache_root, REPO, 100, state="open", fetched_at="2026-06-03T18:00:00Z")
    _seed_entry(
        cache_root,
        REPO,
        1322,
        state="open",
        fetched_at="2026-06-01T17:09:02Z",
        title="deft-install adoption blocker",
        labels=["adoption-blocker"],
    )

    # Before the refresh runs, the queue still ranks the closed-upstream
    # candidate (this is the #1322 bug).
    before = triage_queue.load_cached_issues(REPO, project_root=tmp_path)
    assert 1322 in [i["number"] for i in before]

    monkeypatch.setattr(
        _cache_fetch,
        "_paginated_lister",
        lambda _repo, *, state, limit: [{"number": 100}],
    )
    monkeypatch.setattr(
        _cache_fetch,
        "_single_issue_fetcher",
        lambda _repo, n: {"number": n, "state": "closed", "title": "deft-install"},
    )
    cache.cache_refresh_closed(
        source="github-issue", repo=REPO, cache_root=cache_root, delay_ms=0
    )

    audit = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    audit.parent.mkdir(parents=True, exist_ok=True)
    audit.write_text("", encoding="utf-8")

    rc = triage_queue.main(
        [
            "queue",
            "--project-root",
            str(tmp_path),
            "--repo",
            REPO,
            "--audit-log",
            str(audit),
            "--limit",
            "0",
        ]
    )
    out = capsys.readouterr().out
    assert rc == 0, out
    assert "#1322" not in out, out
    assert "#100" in out, out


# ---------------------------------------------------------------------------
# Queue read-side defensive resolver (load_cached_issues state_resolver)
# ---------------------------------------------------------------------------


def test_load_cached_issues_resolver_excludes_stale_closed(tmp_path: Path) -> None:
    cache_root = tmp_path / ".deft-cache"
    _seed_entry(cache_root, REPO, 100, state="open", fetched_at="2026-06-03T18:30:00Z")
    _seed_entry(
        cache_root, REPO, 1322, state="open", fetched_at="2026-06-01T00:00:00Z"
    )

    resolver_calls: list[int] = []

    def resolver(_repo: str, n: int) -> str:
        resolver_calls.append(n)
        return "closed"

    issues = triage_queue.load_cached_issues(
        REPO,
        project_root=tmp_path,
        state_resolver=resolver,
        now=_NOW,
    )

    nums = sorted(i["number"] for i in issues)
    # #1322 (stale, re-resolved closed) excluded; #100 (fresh) kept.
    assert nums == [100]
    # Only the stale entry triggers a re-resolution -- the fresh one does not.
    assert resolver_calls == [1322]


def test_load_cached_issues_default_keeps_stale_open(tmp_path: Path) -> None:
    """Without a resolver the defensive path is OFF -- behaviour is unchanged."""
    cache_root = tmp_path / ".deft-cache"
    _seed_entry(
        cache_root, REPO, 1322, state="open", fetched_at="2026-06-01T00:00:00Z"
    )
    issues = triage_queue.load_cached_issues(REPO, project_root=tmp_path)
    assert [i["number"] for i in issues] == [1322]


def test_load_cached_issues_resolver_failure_keeps_entry(tmp_path: Path) -> None:
    """A resolver error must not drop a genuinely-cached open entry."""
    cache_root = tmp_path / ".deft-cache"
    _seed_entry(
        cache_root, REPO, 1322, state="open", fetched_at="2026-06-01T00:00:00Z"
    )

    def resolver(_repo: str, _n: int) -> str:
        raise RuntimeError("network down")

    issues = triage_queue.load_cached_issues(
        REPO, project_root=tmp_path, state_resolver=resolver, now=_NOW
    )
    assert [i["number"] for i in issues] == [1322]
