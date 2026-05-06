"""Tests for scripts/triage_refresh.py (#883 Story 3 rebind onto cache:*).

Covers the freshness-gate primitive consumed by ``task triage:refresh-active``:

- ``detect_drift`` walks ``vbrief/active/*.vbrief.json`` and compares
  cached ``meta.json.fetched_at`` to live ``gh issue view --json updatedAt``.
- Drift is the case where the live timestamp postdates the cached fetch
  (the issue moved upstream after we mirrored it).
- The three-way prompt routes to proceed-with-stale / refresh-and-update-local
  / defer-from-this-batch.
- A live-fetch error is logged + recorded in ``skipped`` rather than masked.
- An empty ``vbrief/active/`` returns a no-op summary.
"""

from __future__ import annotations

import importlib
import io
import json
import sys
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_refresh = importlib.import_module("triage_refresh")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _write_vbrief(active_dir: Path, name: str, *issue_uris: str) -> Path:
    active_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "id": name,
            "title": name,
            "status": "running",
            "references": [
                {"type": "x-vbrief/github-issue", "uri": uri} for uri in issue_uris
            ],
        },
    }
    path = active_dir / f"{name}.vbrief.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# _is_drift -- pure helper
# ---------------------------------------------------------------------------


def test_is_drift_missing_cache_is_drift() -> None:
    assert triage_refresh._is_drift(None, "2026-05-05T00:00:00Z") is True


def test_is_drift_live_postdates_cache_is_drift() -> None:
    # Upstream issue was updated AFTER we last fetched it.
    assert (
        triage_refresh._is_drift("2026-05-01T00:00:00Z", "2026-05-05T00:00:00Z")
        is True
    )


def test_is_drift_live_predates_or_equals_cache_is_fresh() -> None:
    assert (
        triage_refresh._is_drift("2026-05-05T00:00:00Z", "2026-05-05T00:00:00Z")
        is False
    )
    assert (
        triage_refresh._is_drift("2026-05-05T00:00:00Z", "2026-05-04T00:00:00Z")
        is False
    )


def test_is_drift_empty_live_short_circuits_to_no_drift() -> None:
    """A malformed gh response cannot fabricate drift."""

    assert triage_refresh._is_drift("2026-05-05T00:00:00Z", "") is False
    assert triage_refresh._is_drift(None, "") is False


# ---------------------------------------------------------------------------
# detect_drift -- consumes meta.json.fetched_at via injected cache_loader
# ---------------------------------------------------------------------------


def test_detect_drift_compares_cached_fetched_at_to_live_updated_at(
    tmp_path: Path,
) -> None:
    """The drift signal is built from cached meta.json.fetched_at vs live updatedAt."""

    active_dir = tmp_path / "vbrief" / "active"
    _write_vbrief(
        active_dir,
        "story-1",
        "https://github.com/deftai/directive/issues/100",
        "https://github.com/deftai/directive/issues/101",
    )

    cached_map = {
        ("deftai/directive", 100): "2026-05-01T00:00:00Z",  # drift -- live newer
        ("deftai/directive", 101): "2026-05-10T00:00:00Z",  # fresh -- live older
    }
    live_map = {
        ("deftai/directive", 100): "2026-05-05T00:00:00Z",
        ("deftai/directive", 101): "2026-05-05T00:00:00Z",
    }

    drifts = triage_refresh.detect_drift(
        active_dir,
        tmp_path,
        fetch_live=lambda repo, n: live_map[(repo, n)],
        cache_loader=lambda repo, n, _root: cached_map[(repo, n)],
        out=io.StringIO(),
    )

    assert len(drifts) == 1
    record = drifts[0]
    assert record.repo == "deftai/directive"
    assert record.issue_number == 100
    assert record.cached_fetched_at == "2026-05-01T00:00:00Z"
    assert record.live_updated_at == "2026-05-05T00:00:00Z"


def test_detect_drift_logs_skipped_live_fetches(tmp_path: Path) -> None:
    """A live-fetch error is logged + recorded as skipped, not masked as fresh."""

    active_dir = tmp_path / "vbrief" / "active"
    _write_vbrief(
        active_dir,
        "story-1",
        "https://github.com/deftai/directive/issues/200",
    )

    def _failing_fetch(_repo: str, _n: int) -> str:
        raise OSError("network unreachable")

    skipped: list[tuple[str, int, str]] = []
    sink = io.StringIO()
    drifts = triage_refresh.detect_drift(
        active_dir,
        tmp_path,
        fetch_live=_failing_fetch,
        cache_loader=lambda *_a: "2026-05-05T00:00:00Z",
        skipped_out=skipped,
        out=sink,
    )

    assert drifts == []
    assert len(skipped) == 1
    assert skipped[0][0] == "deftai/directive"
    assert skipped[0][1] == 200
    assert "live fetch skipped" in sink.getvalue()


def test_detect_drift_treats_missing_cache_as_drift(tmp_path: Path) -> None:
    """An issue with no cache entry surfaces as drift (cache cannot vouch)."""

    active_dir = tmp_path / "vbrief" / "active"
    _write_vbrief(
        active_dir,
        "story-1",
        "https://github.com/deftai/directive/issues/300",
    )

    drifts = triage_refresh.detect_drift(
        active_dir,
        tmp_path,
        fetch_live=lambda *_a: "2026-05-05T00:00:00Z",
        cache_loader=lambda *_a: None,
        out=io.StringIO(),
    )

    assert len(drifts) == 1
    assert drifts[0].cached_fetched_at is None


# ---------------------------------------------------------------------------
# refresh_active -- end-to-end orchestration
# ---------------------------------------------------------------------------


def test_refresh_active_no_op_on_empty_active_dir(tmp_path: Path) -> None:
    summary = triage_refresh.refresh_active(tmp_path, out=io.StringIO())
    assert summary.total_active == 0
    assert summary.drifts_detected == 0


def test_refresh_active_three_way_prompt_routes_correctly(tmp_path: Path) -> None:
    """proceed-with-stale / refresh-and-update-local / defer all dispatch correctly."""

    active_dir = tmp_path / "vbrief" / "active"
    _write_vbrief(
        active_dir,
        "story-1",
        "https://github.com/deftai/directive/issues/400",
        "https://github.com/deftai/directive/issues/401",
        "https://github.com/deftai/directive/issues/402",
    )

    refreshed: list[tuple[str, int]] = []
    audit_calls: list[tuple[str, int, str]] = []
    answers = iter(["1", "2", "3"])

    summary = triage_refresh.refresh_active(
        tmp_path,
        active_dir=active_dir,
        input_fn=lambda _prompt: next(answers),
        fetch_live=lambda _repo, _n: "2026-05-05T00:00:00Z",
        cache_loader=lambda _repo, _n, _root: "2026-05-01T00:00:00Z",
        refresh_local=lambda repo, n, _root: refreshed.append((repo, n)),
        audit_writer=lambda repo, n, ann: audit_calls.append((repo, n, ann)),
        out=io.StringIO(),
    )

    assert summary.drifts_detected == 3
    # Each route was taken exactly once.
    assert len(summary.proceeded) == 1
    assert len(summary.refreshed) == 1
    assert len(summary.deferred) == 1
    assert len(audit_calls) == 1
    assert len(refreshed) == 1


def test_refresh_active_skipped_fetches_surface_in_summary(
    tmp_path: Path,
) -> None:
    active_dir = tmp_path / "vbrief" / "active"
    _write_vbrief(
        active_dir,
        "story-1",
        "https://github.com/deftai/directive/issues/500",
    )

    def _failing_fetch(_repo: str, _n: int) -> str:
        raise OSError("network unreachable")

    summary = triage_refresh.refresh_active(
        tmp_path,
        active_dir=active_dir,
        fetch_live=_failing_fetch,
        cache_loader=lambda *_a: "2026-05-05T00:00:00Z",
        refresh_local=lambda *_a: None,
        audit_writer=lambda *_a: None,
        out=io.StringIO(),
    )

    assert summary.drifts_detected == 0
    assert summary.skipped == [("deftai/directive", 500)]


# ---------------------------------------------------------------------------
# _load_cached_fetched_at -- cache:get integration
# ---------------------------------------------------------------------------


def test_load_cached_fetched_at_consumes_cache_get(tmp_path: Path) -> None:
    """The cached value comes from ``cache.cache_get(...).meta['fetched_at']``."""

    from types import SimpleNamespace

    captured: dict[str, Any] = {}

    def cache_get(source: str, key: str, **kwargs: Any) -> SimpleNamespace:
        captured["source"] = source
        captured["key"] = key
        captured["kwargs"] = kwargs
        return SimpleNamespace(
            meta={"fetched_at": "2026-05-05T12:34:56Z"},
        )

    fake = SimpleNamespace(
        cache_get=cache_get,
        CacheNotFoundError=KeyError,
        CacheValidationError=ValueError,
        CacheError=RuntimeError,
    )

    value = triage_refresh._load_cached_fetched_at(
        "deftai/directive",
        42,
        tmp_path,
        cache_module=fake,
    )
    assert value == "2026-05-05T12:34:56Z"
    assert captured["source"] == "github-issue"
    assert captured["key"] == "deftai/directive/42"
    assert captured["kwargs"]["allow_stale"] is True


def test_load_cached_fetched_at_returns_none_on_cache_miss(tmp_path: Path) -> None:
    from types import SimpleNamespace

    class _NotFoundError(KeyError):
        pass

    def cache_get(*_a: Any, **_kw: Any) -> Any:
        raise _NotFoundError("miss")

    fake = SimpleNamespace(
        cache_get=cache_get,
        CacheNotFoundError=_NotFoundError,
        CacheValidationError=ValueError,
        CacheError=RuntimeError,
    )

    value = triage_refresh._load_cached_fetched_at(
        "deftai/directive", 1, tmp_path, cache_module=fake
    )
    assert value is None
