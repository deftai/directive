"""tests/integration/test_cache_e2e.py -- end-to-end cache layer (#883 Story 4).

Wave-4 (FINAL) integration coverage for the v0.26.0 deft-cache unified
surface. Parallel in shape to v0.25.2's
``tests/integration/test_triage_smoke.py`` (Tier-1-cache contract guard)
and Story 2's ``tests/integration/test_cache_quarantine.py`` (scanner
hard-fail + 429 recovery), but covers the full happy-path E2E:

1. ``test_fetch_all_populates_unified_layout`` -- ``cache:fetch-all``
   against a 5-issue fake-gh fixture writes
   ``.deft-cache/<source>/<key>/{raw.json, content.md, meta.json}`` for
   every issue (the v0.26.0 unified layout).
2. ``test_cache_get_returns_meta_envelope`` -- ``cache:get`` returns a
   schema-valid meta envelope with ``scanner_version``, ``stale``, and
   ``fetched_at`` populated.
3. ``test_audit_log_records_one_put_per_issue`` -- the global
   ``quarantine-audit.jsonl`` audit log carries exactly one ``cache:put``
   record per fetched issue.
4. ``test_cache_invalidate_removes_entry_dir`` -- ``cache:invalidate``
   removes the entry directory cleanly and appends a
   ``cache:invalidate`` audit record (idempotent on re-run).
5. ``test_fetch_all_idempotent_skips_fresh`` -- a second
   ``cache:fetch-all`` run skips every still-fresh entry (TTL-based
   meta.json freshness check); zero new ``cache:put`` audit records are
   written.

All tests are hermetic via the ``_cache_fetch._run_subprocess`` test seam
established under #883 Story 2 -- no real ``gh`` / ``ghx`` / network.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

cache = importlib.import_module("cache")
_cache_fetch = importlib.import_module("_cache_fetch")


# ---------------------------------------------------------------------------
# Fake-gh fixture (5 issues, no credentials, no injection headings)
# ---------------------------------------------------------------------------


REPO = "deftai/directive"
FAKE_NUMBERS: tuple[int, ...] = (101, 102, 103, 104, 105)


def _fake_issue(number: int) -> dict[str, Any]:
    """Return a clean fake-gh issue payload that passes the scanner."""

    return {
        "number": number,
        "title": f"Fake issue {number}",
        "body": (
            "## Summary\n\n"
            f"End-to-end integration fixture for issue {number}.\n"
            "No credentials, no injection-heading tokens, no invisible Unicode.\n"
        ),
        "state": "OPEN",
        "author": {"login": "tester"},
        "createdAt": "2026-05-01T00:00:00Z",
        "updatedAt": "2026-05-05T00:00:00Z",
        "labels": [{"name": "triage"}],
        "comments": [],
        "url": f"https://github.com/{REPO}/issues/{number}",
    }


def _proc(stdout: str, stderr: str = "", returncode: int = 0) -> mock.Mock:
    m = mock.Mock()
    m.stdout = stdout
    m.stderr = stderr
    m.returncode = returncode
    return m


def _make_fake_run() -> Any:
    """Build a fake _run_subprocess driver covering scm:issue:list + view."""

    listing = json.dumps(
        [
            {
                "number": n,
                "title": f"Fake issue {n}",
                "state": "OPEN",
                "updatedAt": "2026-05-05T00:00:00Z",
            }
            for n in FAKE_NUMBERS
        ]
    )

    def fake_run(cmd: list[str], **_: object) -> mock.Mock:
        if "scm:issue:list" in cmd:
            return _proc(listing)
        if "scm:issue:view" in cmd:
            # The first positional argv after '--' is the issue number.
            try:
                idx = cmd.index("--")
                number = int(cmd[idx + 1])
            except (ValueError, IndexError):
                return _proc("", stderr="malformed scm:issue:view cmd", returncode=1)
            return _proc(json.dumps(_fake_issue(number)))
        return _proc("", stderr=f"unexpected cmd: {cmd!r}", returncode=1)

    return fake_run


@pytest.fixture
def fake_cache_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Wire the fake-gh shim into _cache_fetch and yield a tmp cache root."""

    monkeypatch.setattr(_cache_fetch, "_run_subprocess", _make_fake_run())
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)
    return tmp_path


def _read_audit(cache_root: Path) -> list[dict[str, Any]]:
    audit = cache.audit_path(cache_root=cache_root)
    if not audit.exists():
        return []
    return [
        json.loads(line)
        for line in audit.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_fetch_all_populates_unified_layout(fake_cache_root: Path) -> None:
    """cache:fetch-all writes the per-entry directory layout for every issue."""

    report = cache.cache_fetch_all(
        source="github-issue",
        repo=REPO,
        batch_size=10,
        delay_ms=0,
        cache_root=fake_cache_root,
    )
    assert report.succeeded == len(FAKE_NUMBERS)
    assert report.failed == 0
    assert report.skipped == 0

    # Every fetched issue lands under
    # .deft-cache/<source>/<owner>/<repo>/<N>/{raw.json,content.md,meta.json}.
    base = fake_cache_root / "github-issue" / "deftai" / "directive"
    assert base.is_dir()
    for n in FAKE_NUMBERS:
        edir = base / str(n)
        assert (edir / "raw.json").exists(), f"raw.json missing for issue {n}"
        assert (edir / "content.md").exists(), f"content.md missing for issue {n}"
        assert (edir / "meta.json").exists(), f"meta.json missing for issue {n}"
        # raw.json round-trips the fake-gh payload.
        raw = json.loads((edir / "raw.json").read_text(encoding="utf-8"))
        assert raw["number"] == n
        assert raw["url"].endswith(f"/{REPO}/issues/{n}")


def test_cache_get_returns_meta_envelope(fake_cache_root: Path) -> None:
    """cache:get exposes scanner_version, stale, fetched_at on the meta envelope."""

    cache.cache_fetch_all(
        source="github-issue",
        repo=REPO,
        batch_size=10,
        delay_ms=0,
        cache_root=fake_cache_root,
    )

    result = cache.cache_get(
        "github-issue", f"{REPO}/{FAKE_NUMBERS[0]}", cache_root=fake_cache_root
    )
    meta = result.meta
    # Schema validation already ran inside cache_get; re-run defensively.
    cache.validate_meta(meta)

    assert meta["source"] == "github-issue"
    assert meta["key"] == f"{REPO}/{FAKE_NUMBERS[0]}"
    assert "fetched_at" in meta and meta["fetched_at"].endswith("Z")
    assert "expires_at" in meta and meta["expires_at"].endswith("Z")
    assert meta["stale"] is False
    assert result.stale is False  # current time < expires_at
    assert meta["scan_result"]["passed"] is True
    assert meta["scan_result"]["scanner_version"] == cache.SCANNER_VERSION
    assert result.content_path is not None
    assert result.content_path.exists()


def test_audit_log_records_one_put_per_issue(fake_cache_root: Path) -> None:
    """quarantine-audit.jsonl carries exactly one cache:put record per issue."""

    cache.cache_fetch_all(
        source="github-issue",
        repo=REPO,
        batch_size=10,
        delay_ms=0,
        cache_root=fake_cache_root,
    )

    records = _read_audit(fake_cache_root)
    put_records = [r for r in records if r.get("event") == "cache:put"]
    assert len(put_records) == len(FAKE_NUMBERS), (
        f"expected one cache:put per issue ({len(FAKE_NUMBERS)}); got {len(put_records)}"
    )
    keys = sorted(r["key"] for r in put_records)
    assert keys == sorted(f"{REPO}/{n}" for n in FAKE_NUMBERS)
    # Every put record is scan_passed=True (clean fixture, no scanner flags).
    assert all(r["scan_passed"] is True for r in put_records)
    assert all(r["content_written"] is True for r in put_records)


def test_cache_invalidate_removes_entry_dir(fake_cache_root: Path) -> None:
    """cache:invalidate deletes the entry directory and appends an audit record."""

    cache.cache_fetch_all(
        source="github-issue",
        repo=REPO,
        batch_size=10,
        delay_ms=0,
        cache_root=fake_cache_root,
    )

    target_key = f"{REPO}/{FAKE_NUMBERS[2]}"
    edir = cache.entry_dir("github-issue", target_key, cache_root=fake_cache_root)
    assert edir.is_dir()

    existed = cache.cache_invalidate(
        "github-issue", target_key, reason="story-4 e2e", cache_root=fake_cache_root
    )
    assert existed is True
    assert not edir.exists(), "entry directory must be removed"

    # Subsequent invalidate is idempotent: returns False, never raises.
    again = cache.cache_invalidate(
        "github-issue", target_key, cache_root=fake_cache_root
    )
    assert again is False

    # Audit log carries an invalidate record AND a follow-up idempotent
    # invalidate record (existed=False).
    records = _read_audit(fake_cache_root)
    invalidate_records = [r for r in records if r.get("event") == "cache:invalidate"]
    assert len(invalidate_records) == 2
    assert invalidate_records[0]["key"] == target_key
    assert invalidate_records[0]["existed"] is True
    assert invalidate_records[0]["reason"] == "story-4 e2e"
    assert invalidate_records[1]["existed"] is False

    # cache:get on the invalidated entry now misses.
    with pytest.raises(cache.CacheNotFoundError):
        cache.cache_get("github-issue", target_key, cache_root=fake_cache_root)


def test_fetch_all_idempotent_skips_fresh(fake_cache_root: Path) -> None:
    """A second cache:fetch-all run skips every still-fresh entry."""

    first = cache.cache_fetch_all(
        source="github-issue",
        repo=REPO,
        batch_size=10,
        delay_ms=0,
        cache_root=fake_cache_root,
    )
    assert first.succeeded == len(FAKE_NUMBERS)
    assert first.skipped == 0

    audit_after_first = _read_audit(fake_cache_root)
    put_count_first = sum(
        1 for r in audit_after_first if r.get("event") == "cache:put"
    )
    assert put_count_first == len(FAKE_NUMBERS)

    second = cache.cache_fetch_all(
        source="github-issue",
        repo=REPO,
        batch_size=10,
        delay_ms=0,
        cache_root=fake_cache_root,
    )
    assert second.succeeded == 0
    assert second.failed == 0
    assert second.skipped == len(FAKE_NUMBERS), (
        "TTL skip-fresh idempotency must short-circuit every issue on re-run"
    )

    audit_after_second = _read_audit(fake_cache_root)
    put_count_second = sum(
        1 for r in audit_after_second if r.get("event") == "cache:put"
    )
    assert put_count_second == put_count_first, (
        f"idempotent re-run must NOT append cache:put records; "
        f"first pass={put_count_first}, second pass added "
        f"{put_count_second - put_count_first}"
    )
