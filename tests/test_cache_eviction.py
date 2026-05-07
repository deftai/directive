"""tests/test_cache_eviction.py -- _cache_quota unit coverage (#947).

Covers:

- :class:`TestResolveCaps` -- env-var override, default fallback, 0 = disabled,
  invalid values clamped to disabled.
- :class:`TestScanUsage` -- empty cache root, multiple entries summed,
  corrupt meta.json contributes 0 bytes but appears in entries list.
- :class:`TestLruOrder` -- deterministic (mtime, path) ordering with the
  path tie-break on 1s mtime granularity.
- :class:`TestEvictLru` -- evicts oldest first, respects protect_keys,
  audit callback fires per eviction, returns the evicted set.
- :class:`TestEnforceCaps` -- evicts until under cap; would_breach is
  True when caps still violated post-eviction; predict_eviction_set
  matches the live evict_lru ordering.
- :class:`TestCacheCapBreachedError` -- structured fields preserved
  through ``str(exc)``.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

cache = importlib.import_module("cache")
_cache_quota = importlib.import_module("_cache_quota")


# ---------------------------------------------------------------------------
# Helpers -- write a minimal-but-valid entry directory so scan_usage sees it.
# ---------------------------------------------------------------------------


def _write_entry(
    root: Path,
    *,
    source: str,
    key: str,
    size_bytes: int,
    mtime: float | None = None,
) -> Path:
    """Create ``root/<source>/<key>/{meta.json, raw.json}`` with the given size."""
    edir = root / source / Path(*key.split("/"))
    edir.mkdir(parents=True, exist_ok=True)
    meta = {
        "source": source,
        "key": key,
        "fetched_at": "2026-05-05T00:00:00Z",
        "ttl_seconds": 604800,
        "expires_at": "2026-05-12T00:00:00Z",
        "scan_result": {
            "passed": True,
            "scanned_at": "2026-05-05T00:00:00Z",
            "scanner_version": "2.1.0",
            "flags": [],
        },
        "size_bytes": size_bytes,
        "stale": False,
    }
    meta_path = edir / "meta.json"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    (edir / "raw.json").write_text("{}", encoding="utf-8")
    if mtime is not None:
        os.utime(meta_path, (mtime, mtime))
    return edir


# ---------------------------------------------------------------------------
# resolve_caps + env-var contract
# ---------------------------------------------------------------------------


class TestResolveCaps:
    """Env-var override, default fallback, sentinel handling."""

    def test_defaults_when_env_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("DEFT_CACHE_MAX_BYTES", raising=False)
        monkeypatch.delenv("DEFT_CACHE_MAX_ENTRIES", raising=False)
        caps = _cache_quota.resolve_caps()
        assert caps.max_bytes == _cache_quota.DEFAULT_MAX_BYTES
        assert caps.max_entries == _cache_quota.DEFAULT_MAX_ENTRIES
        assert caps.bytes_enforced is True
        assert caps.entries_enforced is True

    def test_env_overrides_defaults(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DEFT_CACHE_MAX_BYTES", "1024")
        monkeypatch.setenv("DEFT_CACHE_MAX_ENTRIES", "5")
        caps = _cache_quota.resolve_caps()
        assert caps.max_bytes == 1024
        assert caps.max_entries == 5

    def test_zero_disables_cap(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DEFT_CACHE_MAX_BYTES", "0")
        monkeypatch.setenv("DEFT_CACHE_MAX_ENTRIES", "0")
        caps = _cache_quota.resolve_caps()
        assert caps.bytes_enforced is False
        assert caps.entries_enforced is False
        assert caps.any_enforced is False

    def test_negative_clamped_to_disabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DEFT_CACHE_MAX_BYTES", "-100")
        caps = _cache_quota.resolve_caps()
        assert caps.max_bytes == _cache_quota.CAP_DISABLED

    def test_non_numeric_env_disables_cap(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DEFT_CACHE_MAX_BYTES", "not-a-number")
        caps = _cache_quota.resolve_caps()
        assert caps.max_bytes == _cache_quota.CAP_DISABLED

    def test_explicit_kwargs_override_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DEFT_CACHE_MAX_BYTES", "999")
        caps = _cache_quota.resolve_caps(max_bytes=42)
        assert caps.max_bytes == 42


# ---------------------------------------------------------------------------
# scan_usage
# ---------------------------------------------------------------------------


class TestScanUsage:
    """Walk the cache root, summing size_bytes and recording mtime."""

    def test_empty_root(self, tmp_path: Path) -> None:
        usage = _cache_quota.scan_usage(tmp_path, sources=cache.ALLOWED_SOURCES)
        assert usage.total_bytes == 0
        assert usage.total_entries == 0
        assert usage.entries == ()

    def test_nonexistent_root(self, tmp_path: Path) -> None:
        usage = _cache_quota.scan_usage(
            tmp_path / "missing", sources=cache.ALLOWED_SOURCES
        )
        assert usage.total_bytes == 0
        assert usage.total_entries == 0

    def test_sums_multiple_entries(self, tmp_path: Path) -> None:
        _write_entry(tmp_path, source="github-issue", key="a/b/1", size_bytes=100)
        _write_entry(tmp_path, source="github-issue", key="a/b/2", size_bytes=250)
        usage = _cache_quota.scan_usage(tmp_path, sources=cache.ALLOWED_SOURCES)
        assert usage.total_entries == 2
        assert usage.total_bytes == 350

    def test_corrupt_meta_yields_zero_size(self, tmp_path: Path) -> None:
        edir = tmp_path / "github-issue" / "a" / "b" / "1"
        edir.mkdir(parents=True)
        (edir / "meta.json").write_text("{not json", encoding="utf-8")
        usage = _cache_quota.scan_usage(tmp_path, sources=cache.ALLOWED_SOURCES)
        assert usage.total_entries == 1
        assert usage.total_bytes == 0
        assert usage.entries[0].meta_present is False


# ---------------------------------------------------------------------------
# lru_order + cap_breached
# ---------------------------------------------------------------------------


class TestLruOrder:
    """Deterministic (mtime, path) ordering."""

    def test_oldest_first_by_mtime(self, tmp_path: Path) -> None:
        _write_entry(
            tmp_path, source="github-issue", key="a/b/1", size_bytes=10, mtime=100.0
        )
        _write_entry(
            tmp_path, source="github-issue", key="a/b/2", size_bytes=10, mtime=50.0
        )
        _write_entry(
            tmp_path, source="github-issue", key="a/b/3", size_bytes=10, mtime=200.0
        )
        usage = _cache_quota.scan_usage(tmp_path, sources=cache.ALLOWED_SOURCES)
        ordered = _cache_quota.lru_order(usage)
        assert [e.key for e in ordered] == ["a/b/2", "a/b/1", "a/b/3"]

    def test_path_tiebreak_when_mtime_equal(self, tmp_path: Path) -> None:
        # Two entries with identical mtimes -- path tiebreak gives stable order.
        _write_entry(
            tmp_path, source="github-issue", key="a/b/1", size_bytes=10, mtime=42.0
        )
        _write_entry(
            tmp_path, source="github-issue", key="a/b/2", size_bytes=10, mtime=42.0
        )
        usage = _cache_quota.scan_usage(tmp_path, sources=cache.ALLOWED_SOURCES)
        ordered = _cache_quota.lru_order(usage)
        # Path-sort tie-break: "a/b/1" lexicographically precedes "a/b/2".
        assert [e.key for e in ordered] == ["a/b/1", "a/b/2"]


class TestCapBreached:
    """Bytes + entries deltas, both caps, disabled caps."""

    def test_under_cap_no_breach(self, tmp_path: Path) -> None:
        _write_entry(tmp_path, source="github-issue", key="a/b/1", size_bytes=100)
        usage = _cache_quota.scan_usage(tmp_path, sources=cache.ALLOWED_SOURCES)
        caps = _cache_quota.CacheCaps(max_bytes=1000, max_entries=10)
        assert _cache_quota.cap_breached(usage, caps) is False

    def test_byte_cap_breach(self, tmp_path: Path) -> None:
        _write_entry(tmp_path, source="github-issue", key="a/b/1", size_bytes=900)
        usage = _cache_quota.scan_usage(tmp_path, sources=cache.ALLOWED_SOURCES)
        caps = _cache_quota.CacheCaps(max_bytes=1000, max_entries=0)
        assert _cache_quota.cap_breached(usage, caps, incoming_bytes=200) is True

    def test_entry_cap_breach(self, tmp_path: Path) -> None:
        for i in range(3):
            _write_entry(
                tmp_path, source="github-issue", key=f"a/b/{i}", size_bytes=10
            )
        usage = _cache_quota.scan_usage(tmp_path, sources=cache.ALLOWED_SOURCES)
        caps = _cache_quota.CacheCaps(max_bytes=0, max_entries=3)
        assert _cache_quota.cap_breached(usage, caps, incoming_entries=1) is True

    def test_disabled_caps_never_breach(self, tmp_path: Path) -> None:
        _write_entry(
            tmp_path, source="github-issue", key="a/b/1", size_bytes=10**9
        )
        usage = _cache_quota.scan_usage(tmp_path, sources=cache.ALLOWED_SOURCES)
        caps = _cache_quota.CacheCaps(max_bytes=0, max_entries=0)
        assert _cache_quota.cap_breached(usage, caps, incoming_bytes=10**12) is False


# ---------------------------------------------------------------------------
# evict_lru + on_evict callback
# ---------------------------------------------------------------------------


class TestEvictLru:
    """LRU-ordered eviction with protect_keys and audit callback."""

    def test_evicts_oldest_until_under_cap(self, tmp_path: Path) -> None:
        for i, mt in enumerate([100.0, 50.0, 200.0]):
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"a/b/{i}",
                size_bytes=400,
                mtime=mt,
            )
        # Cap = 1000 bytes; current = 1200; need to evict the oldest (mtime=50).
        caps = _cache_quota.CacheCaps(max_bytes=1000, max_entries=0)
        evicted = _cache_quota.evict_lru(
            tmp_path, sources=cache.ALLOWED_SOURCES, caps=caps
        )
        assert len(evicted) == 1
        assert evicted[0].key == "a/b/1"  # mtime=50 was the oldest
        # Survivors persist on disk.
        for surviving_key in ("a/b/0", "a/b/2"):
            assert (
                tmp_path / "github-issue" / "a" / "b" / surviving_key.split("/")[-1]
            ).exists()

    def test_protect_keys_excluded_from_eviction(self, tmp_path: Path) -> None:
        for i, mt in enumerate([10.0, 20.0]):
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"a/b/{i}",
                size_bytes=600,
                mtime=mt,
            )
        # Cap = 1000; current = 1200; oldest is a/b/0 but it's protected,
        # so a/b/1 is evicted instead.
        caps = _cache_quota.CacheCaps(max_bytes=1000, max_entries=0)
        evicted = _cache_quota.evict_lru(
            tmp_path,
            sources=cache.ALLOWED_SOURCES,
            caps=caps,
            protect_keys=[("github-issue", "a/b/0")],
        )
        assert len(evicted) == 1
        assert evicted[0].key == "a/b/1"

    def test_on_evict_callback_fires_per_eviction(self, tmp_path: Path) -> None:
        for i, mt in enumerate([10.0, 20.0, 30.0]):
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"a/b/{i}",
                size_bytes=400,
                mtime=mt,
            )
        caps = _cache_quota.CacheCaps(max_bytes=500, max_entries=0)
        seen: list[tuple[str, str]] = []
        _cache_quota.evict_lru(
            tmp_path,
            sources=cache.ALLOWED_SOURCES,
            caps=caps,
            on_evict=lambda v, reason, _c: seen.append((v.key, reason)),
        )
        # Two oldest entries had to go to drop the total to 400 < 500.
        # Reason for each is precisely "size_cap" (only bytes cap is set),
        # not the configured-cap union.
        assert seen == [("a/b/0", "size_cap"), ("a/b/1", "size_cap")]

    def test_evict_reason_reflects_actual_breach_under_both_caps(
        self, tmp_path: Path
    ) -> None:
        # Both caps configured. Bytes cap is generous (no breach), entries cap
        # tight (breach). Reason MUST be 'entry_cap', NOT 'size_cap+entry_cap'.
        # Regression for the iter-1 P1 finding: prior behavior tagged every
        # eviction with the union of configured caps under the defaults.
        for i, mt in enumerate([10.0, 20.0, 30.0]):
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"a/b/{i}",
                size_bytes=10,
                mtime=mt,
            )
        caps = _cache_quota.CacheCaps(max_bytes=10**9, max_entries=2)
        seen: list[str] = []
        _cache_quota.evict_lru(
            tmp_path,
            sources=cache.ALLOWED_SOURCES,
            caps=caps,
            on_evict=lambda _v, reason, _c: seen.append(reason),
        )
        # One eviction needed (3 entries down to 2). Only entries cap drove it.
        assert seen == ["entry_cap"]

    def test_evict_lru_single_scan_invocation(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Regression for the iter-1 P2 finding: the original loop called
        # scan_usage() once per eviction, giving an O(n^2) drain. The
        # restructured implementation does ONE up-front scan plus running
        # totals; verify scan_usage is called exactly once even when the
        # eviction set has many entries.
        for i, mt in enumerate([10.0 + i for i in range(10)]):  # noqa: B023
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"a/b/{i}",
                size_bytes=100,
                mtime=mt,
            )
        caps = _cache_quota.CacheCaps(max_bytes=200, max_entries=0)
        call_count = {"n": 0}
        real_scan = _cache_quota.scan_usage

        def counting_scan(*args, **kwargs):
            call_count["n"] += 1
            return real_scan(*args, **kwargs)

        monkeypatch.setattr(_cache_quota, "scan_usage", counting_scan)
        evicted = _cache_quota.evict_lru(
            tmp_path, sources=cache.ALLOWED_SOURCES, caps=caps
        )
        # 10 entries x 100 bytes = 1000 total; cap = 200; need to evict 8.
        assert len(evicted) == 8
        # Single scan_usage call regardless of eviction count.
        assert call_count["n"] == 1

    def test_disabled_caps_short_circuit(self, tmp_path: Path) -> None:
        _write_entry(
            tmp_path, source="github-issue", key="a/b/1", size_bytes=10**6
        )
        caps = _cache_quota.CacheCaps(max_bytes=0, max_entries=0)
        evicted = _cache_quota.evict_lru(
            tmp_path, sources=cache.ALLOWED_SOURCES, caps=caps
        )
        assert evicted == []


# ---------------------------------------------------------------------------
# enforce_caps + predict_eviction_set
# ---------------------------------------------------------------------------


class TestEnforceCaps:
    """High-level eviction wrapper with would_breach flag."""

    def test_clean_under_cap_no_eviction(self, tmp_path: Path) -> None:
        _write_entry(tmp_path, source="github-issue", key="a/b/1", size_bytes=100)
        caps = _cache_quota.CacheCaps(max_bytes=10_000, max_entries=10)
        result = _cache_quota.enforce_caps(
            tmp_path, sources=cache.ALLOWED_SOURCES, caps=caps
        )
        assert result.evicted == ()
        assert result.would_breach is False

    def test_would_breach_when_protected_blocks_eviction(self, tmp_path: Path) -> None:
        # Single entry, byte cap smaller than the entry. Protected -> can't evict.
        _write_entry(tmp_path, source="github-issue", key="a/b/1", size_bytes=500)
        caps = _cache_quota.CacheCaps(max_bytes=100, max_entries=0)
        result = _cache_quota.enforce_caps(
            tmp_path,
            sources=cache.ALLOWED_SOURCES,
            caps=caps,
            protect_keys=[("github-issue", "a/b/1")],
        )
        assert result.would_breach is True
        assert len(result.evicted) == 0


class TestPredictEvictionSet:
    """Dry-run prediction matches what evict_lru would actually evict."""

    def test_prediction_matches_actual_ordering(self, tmp_path: Path) -> None:
        for i, mt in enumerate([10.0, 20.0, 30.0]):
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"a/b/{i}",
                size_bytes=400,
                mtime=mt,
            )
        caps = _cache_quota.CacheCaps(max_bytes=500, max_entries=0)
        predicted = _cache_quota.predict_eviction_set(
            tmp_path, sources=cache.ALLOWED_SOURCES, caps=caps
        )
        # Same expectation as the live evict_lru test above.
        assert [e.key for e in predicted] == ["a/b/0", "a/b/1"]
        # Disk untouched.
        for i in range(3):
            assert (tmp_path / "github-issue" / "a" / "b" / str(i)).exists()

    def test_prediction_empty_when_under_cap(self, tmp_path: Path) -> None:
        _write_entry(tmp_path, source="github-issue", key="a/b/1", size_bytes=10)
        caps = _cache_quota.CacheCaps(max_bytes=10_000, max_entries=10)
        predicted = _cache_quota.predict_eviction_set(
            tmp_path, sources=cache.ALLOWED_SOURCES, caps=caps
        )
        assert predicted == ()


# ---------------------------------------------------------------------------
# CacheCapBreachedError shape
# ---------------------------------------------------------------------------


class TestCacheCapBreachedError:
    """Structured fields preserved through str(exc) and on the instance."""

    def test_fields_attached_to_instance(self) -> None:
        exc = _cache_quota.CacheCapBreachedError(
            reason="size_cap",
            max_bytes=1000,
            max_entries=10,
            current_bytes=1200,
            current_entries=11,
            incoming_bytes=200,
        )
        assert exc.reason == "size_cap"
        assert exc.max_bytes == 1000
        assert exc.max_entries == 10
        assert exc.current_bytes == 1200
        assert exc.current_entries == 11
        assert exc.incoming_bytes == 200
        # str(exc) carries the structured summary.
        text = str(exc)
        assert "size_cap" in text
        assert "max_bytes=1000" in text
        assert "current_entries=11" in text


# ---------------------------------------------------------------------------
# mtime-touch behavior on cache:get (LRU signal)
# ---------------------------------------------------------------------------


class TestMtimeTouchOnGet:
    """cache.cache_get must touch meta.json mtime so LRU ordering reflects access."""

    def test_get_touches_mtime(self, tmp_path: Path) -> None:
        _write_entry(
            tmp_path,
            source="github-issue",
            key="deftai/directive/501",
            size_bytes=10,
            mtime=time.time() - 10_000,
        )
        meta_path = (
            tmp_path / "github-issue" / "deftai" / "directive" / "501" / "meta.json"
        )
        before = meta_path.stat().st_mtime
        cache.cache_get(
            "github-issue", "deftai/directive/501", cache_root=tmp_path
        )
        after = meta_path.stat().st_mtime
        # mtime moves forward (touch happened); compare with epsilon for FS resolution.
        assert after > before


# ---------------------------------------------------------------------------
# cache.cache_put pre-write enforcement (#947)
# ---------------------------------------------------------------------------


def _good_raw(number: int = 1, body: str = "") -> dict[str, Any]:
    return {
        "number": number,
        "title": f"issue {number}",
        "body": body,
        "state": "OPEN",
        "author": {"login": "tester"},
        "createdAt": "2026-05-01T00:00:00Z",
        "updatedAt": "2026-05-05T00:00:00Z",
        "labels": [],
        "comments": [],
        "url": f"https://github.com/deftai/directive/issues/{number}",
    }


class TestCachePutEnforcement:
    """cache_put pre-write quota enforcement and CacheCapBreachedError path."""

    def test_put_evicts_lru_to_make_room(self, tmp_path: Path) -> None:
        # Pre-populate two old entries, near the entry cap of 2.
        for i, mt in enumerate([10.0, 20.0]):
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"deftai/directive/{i + 100}",
                size_bytes=10,
                mtime=mt,
            )
        # New put should evict the older one (mtime=10) under entry cap of 2.
        caps = _cache_quota.CacheCaps(max_bytes=0, max_entries=2)
        cache.cache_put(
            "github-issue",
            "deftai/directive/200",
            _good_raw(number=200),
            cache_root=tmp_path,
            caps=caps,
        )
        # Oldest must be gone, newer ones present.
        assert not (
            tmp_path / "github-issue" / "deftai" / "directive" / "100"
        ).exists()
        assert (
            tmp_path / "github-issue" / "deftai" / "directive" / "101"
        ).exists()
        assert (
            tmp_path / "github-issue" / "deftai" / "directive" / "200"
        ).exists()

    def test_put_evict_audit_event(self, tmp_path: Path) -> None:
        _write_entry(
            tmp_path,
            source="github-issue",
            key="deftai/directive/300",
            size_bytes=10,
            mtime=100.0,
        )
        caps = _cache_quota.CacheCaps(max_bytes=0, max_entries=1)
        cache.cache_put(
            "github-issue",
            "deftai/directive/301",
            _good_raw(number=301),
            cache_root=tmp_path,
            caps=caps,
        )
        audit = (tmp_path / "quarantine-audit.jsonl").read_text(encoding="utf-8")
        evict_lines = [
            json.loads(line)
            for line in audit.splitlines()
            if line.strip() and json.loads(line).get("event") == "cache:evict"
        ]
        assert len(evict_lines) == 1
        record = evict_lines[0]
        assert record["source"] == "github-issue"
        assert record["key"] == "deftai/directive/300"
        assert record["trigger"] == "cache:put"
        assert record["reason"] == "entry_cap"
        assert isinstance(record["freed_bytes"], int)
        assert "last_accessed_at" in record

    def test_put_raises_when_cap_impossible(self, tmp_path: Path) -> None:
        # Cap = 50 bytes; new entry's raw.json is much larger; nothing else
        # to evict -> CacheCapBreachedError.
        caps = _cache_quota.CacheCaps(max_bytes=50, max_entries=0)
        with pytest.raises(_cache_quota.CacheCapBreachedError):
            cache.cache_put(
                "github-issue",
                "deftai/directive/400",
                _good_raw(number=400, body="x" * 1000),
                cache_root=tmp_path,
                caps=caps,
            )
        # No on-disk side effects (the put failed before writing).
        assert not (
            tmp_path / "github-issue" / "deftai" / "directive" / "400"
        ).exists()

    def test_shrinking_reput_below_cap_succeeds(self, tmp_path: Path) -> None:
        # Regression for the iter-1 P1 finding: a shrinking re-put against
        # a tight byte cap was incorrectly rejected because incoming_delta
        # was floored to 0, so cap_breached saw the existing oversized entry
        # alone exceeding the cap. The fix lets incoming_delta go negative
        # so the projected total post-write reflects the smaller payload.
        large_body = "x" * 8000  # ~8 KB raw.json
        cache.cache_put(
            "github-issue",
            "deftai/directive/410",
            _good_raw(number=410, body=large_body),
            cache_root=tmp_path,
        )
        # Re-put with a much smaller body under a cap smaller than the
        # original entry. Must NOT raise -- the smaller payload fits.
        caps = _cache_quota.CacheCaps(max_bytes=4000, max_entries=0)
        cache.cache_put(
            "github-issue",
            "deftai/directive/410",
            _good_raw(number=410, body="tiny"),
            cache_root=tmp_path,
            caps=caps,
        )
        # Entry persists with the smaller raw.json.
        edir = tmp_path / "github-issue" / "deftai" / "directive" / "410"
        assert edir.exists()
        size_after = (edir / "raw.json").stat().st_size
        assert size_after < 4000

    def test_cli_exit_3_on_cap_breach(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Tiny byte cap forces the put to fail unconditionally; CLI maps to 3.
        monkeypatch.setenv("DEFT_CACHE_MAX_BYTES", "10")
        monkeypatch.setenv("DEFT_CACHE_MAX_ENTRIES", "0")
        monkeypatch.chdir(tmp_path)
        raw = tmp_path / "raw.json"
        raw.write_text(
            json.dumps(_good_raw(number=500, body="x" * 1000)), encoding="utf-8"
        )
        rc = cache.main(
            ["put", "github-issue", "deftai/directive/500", "--raw-file", str(raw)]
        )
        assert rc == 3


# ---------------------------------------------------------------------------
# cache.cache_prune_to_cap idempotency
# ---------------------------------------------------------------------------


class TestCachePruneToCap:
    """Drain LRU until under cap; second call no-ops."""

    def test_first_call_drains_oldest(self, tmp_path: Path) -> None:
        for i, mt in enumerate([10.0, 20.0, 30.0]):
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"deftai/directive/{600 + i}",
                size_bytes=400,
                mtime=mt,
            )
        caps = _cache_quota.CacheCaps(max_bytes=500, max_entries=0)
        evicted = cache.cache_prune_to_cap(cache_root=tmp_path, caps=caps)
        # Oldest two evicted -- 1200 -> 400 < 500.
        assert {e.key for e in evicted} == {
            "deftai/directive/600",
            "deftai/directive/601",
        }

    def test_second_call_idempotent(self, tmp_path: Path) -> None:
        for i, mt in enumerate([10.0, 20.0, 30.0]):
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"deftai/directive/{700 + i}",
                size_bytes=400,
                mtime=mt,
            )
        caps = _cache_quota.CacheCaps(max_bytes=500, max_entries=0)
        cache.cache_prune_to_cap(cache_root=tmp_path, caps=caps)
        # Already under cap -- second call evicts nothing.
        second = cache.cache_prune_to_cap(cache_root=tmp_path, caps=caps)
        assert second == []

    def test_dry_run_does_not_delete(self, tmp_path: Path) -> None:
        for i, mt in enumerate([10.0, 20.0]):
            _write_entry(
                tmp_path,
                source="github-issue",
                key=f"deftai/directive/{800 + i}",
                size_bytes=400,
                mtime=mt,
            )
        caps = _cache_quota.CacheCaps(max_bytes=500, max_entries=0)
        predicted = cache.cache_prune_to_cap(
            cache_root=tmp_path, caps=caps, dry_run=True
        )
        assert len(predicted) == 1
        assert predicted[0].key == "deftai/directive/800"
        # On-disk entries still present (dry-run wrote nothing).
        for i in range(2):
            assert (
                tmp_path / "github-issue" / "deftai" / "directive" / str(800 + i)
            ).exists()

    def test_disabled_caps_no_op(self, tmp_path: Path) -> None:
        _write_entry(
            tmp_path,
            source="github-issue",
            key="deftai/directive/900",
            size_bytes=10**6,
        )
        caps = _cache_quota.CacheCaps(max_bytes=0, max_entries=0)
        evicted = cache.cache_prune_to_cap(cache_root=tmp_path, caps=caps)
        assert evicted == []
