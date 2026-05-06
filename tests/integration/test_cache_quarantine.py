"""tests/integration/test_cache_quarantine.py -- end-to-end cache + scanner (#883 Story 2).

Three integration scenarios per the vBRIEF Test narrative:

1. fetch-all rate-limit -- a fake-gh shim simulates a 429 with
   Retry-After on the first scm:issue:view, then returns the real
   payload. Asserts the orchestrator slept the documented interval AND
   the entry landed on disk with valid meta.json.

2. fetch-all partial-failure recovery -- a fake-gh shim succeeds on
   issue 1, hard-fails on issue 2, succeeds on issue 3. Asserts (a)
   the loop never aborted (issue 3 was processed), (b) the structured
   {succeeded, failed, skipped} JSON exit shape, (c) issues 1 + 3
   landed on disk, (d) issue 2 did NOT land.

3. cache:put scan-failure semantics -- end-to-end through the cache
   surface with a real credentials-bearing payload. Asserts raw.json +
   meta.json land but content.md does NOT, the audit log carries one
   record with scan_passed=false, and the meta.json validates against
   the schema with the credentials flag recorded.

These tests are hermetic (no network, no real gh) -- the fake-gh shim
is injected via :data:`_cache_fetch._run_subprocess`. Skips when
``DEFT_NO_NETWORK=1`` are NOT applied here because the tests do not
touch the network even by mistake.
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


def _proc(stdout: str, stderr: str = "", returncode: int = 0) -> mock.Mock:
    m = mock.Mock()
    m.stdout = stdout
    m.stderr = stderr
    m.returncode = returncode
    return m


def _issue(number: int, body: str = "Plain body.") -> dict[str, Any]:
    return {
        "number": number,
        "title": f"Issue {number}",
        "body": body,
        "state": "OPEN",
        "author": {"login": "tester"},
        "createdAt": "2026-05-01T00:00:00Z",
        "updatedAt": "2026-05-05T00:00:00Z",
        "labels": [],
        "comments": [],
        "url": f"https://github.com/deftai/directive/issues/{number}",
    }


def test_fetch_all_rate_limit_recovers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Integration: 429 on first view, success on retry, entry persisted."""
    issues_listing = json.dumps(
        [
            {
                "number": 10,
                "title": "rate-limited",
                "state": "OPEN",
                "updatedAt": "2026-05-05T00:00:00Z",
            }
        ]
    )
    view_attempts = {"count": 0}

    def fake_run(cmd: list[str], **_: object) -> mock.Mock:
        if "scm:issue:list" in cmd:
            return _proc(issues_listing)
        if "scm:issue:view" in cmd:
            view_attempts["count"] += 1
            if view_attempts["count"] == 1:
                return _proc(
                    "",
                    stderr="HTTP 429 too many requests\nRetry-After: 3\n",
                    returncode=1,
                )
            return _proc(json.dumps(_issue(10)))
        return _proc("", returncode=1)

    sleeps: list[float] = []
    monkeypatch.setattr(_cache_fetch, "_run_subprocess", fake_run)
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda s: sleeps.append(s))

    report = cache.cache_fetch_all(
        source="github-issue",
        repo="deftai/directive",
        batch_size=10,
        delay_ms=0,
        cache_root=tmp_path,
    )

    assert report.succeeded == 1
    assert report.failed == 0
    assert report.skipped == 0
    # Retry-After: 3 was honored.
    assert 3 in sleeps
    # Entry persisted on disk with all three files (clean body -> content.md present).
    edir = cache.entry_dir(
        "github-issue", "deftai/directive/10", cache_root=tmp_path
    )
    assert (edir / "raw.json").exists()
    assert (edir / "content.md").exists()
    assert (edir / "meta.json").exists()
    meta = json.loads((edir / "meta.json").read_text(encoding="utf-8"))
    cache.validate_meta(meta)


def test_fetch_all_partial_failure_recovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Integration: mid-batch error never aborts; surviving entries persist."""
    issues_listing = json.dumps(
        [
            {
                "number": 21,
                "title": "ok-1",
                "state": "OPEN",
                "updatedAt": "2026-05-05T00:00:00Z",
            },
            {
                "number": 22,
                "title": "fail",
                "state": "OPEN",
                "updatedAt": "2026-05-05T00:00:00Z",
            },
            {
                "number": 23,
                "title": "ok-2",
                "state": "OPEN",
                "updatedAt": "2026-05-05T00:00:00Z",
            },
        ]
    )

    def fake_run(cmd: list[str], **_: object) -> mock.Mock:
        if "scm:issue:list" in cmd:
            return _proc(issues_listing)
        if "scm:issue:view" in cmd:
            num = int(cmd[cmd.index("--") + 1])
            if num == 22:
                # Hard 500 -- not rate-limited, no retry.
                return _proc("", stderr="HTTP 500 internal error", returncode=1)
            return _proc(json.dumps(_issue(num)))
        return _proc("", returncode=1)

    monkeypatch.setattr(_cache_fetch, "_run_subprocess", fake_run)
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)

    report = cache.cache_fetch_all(
        source="github-issue",
        repo="deftai/directive",
        batch_size=10,
        delay_ms=0,
        cache_root=tmp_path,
    )

    assert report.succeeded == 2
    assert report.failed == 1
    assert report.skipped == 0
    payload = json.loads(report.to_json())
    assert payload["succeeded"] == 2
    assert payload["failed"] == 1
    assert any("deftai/directive/22" in f["key"] for f in payload["failures"])

    # Issues 21 and 23 must be persisted; issue 22 must NOT have a meta.json.
    for ok_num in (21, 23):
        edir = cache.entry_dir(
            "github-issue", f"deftai/directive/{ok_num}", cache_root=tmp_path
        )
        assert (edir / "meta.json").exists()
    fail_dir = cache.entry_dir(
        "github-issue", "deftai/directive/22", cache_root=tmp_path
    )
    assert not (fail_dir / "meta.json").exists()


def test_cache_put_scan_failure_semantics(tmp_path: Path) -> None:
    """Integration: credentials match -> raw.json + meta.json land; content.md skipped."""
    body = (
        "## Issue summary\n"
        "Some context here.\n\n"
        f"Accidentally posted token: AKIA{'A' * 16}\n"
        "End of body.\n"
    )
    result = cache.cache_put(
        "github-issue",
        "deftai/directive/30",
        _issue(30, body=body),
        cache_root=tmp_path,
    )
    edir = result.entry_dir
    assert (edir / "raw.json").exists()
    assert (edir / "meta.json").exists()
    assert not (edir / "content.md").exists(), (
        "credentials hard-fail must skip content.md"
    )

    # meta.json validates and carries the credentials flag.
    meta = json.loads((edir / "meta.json").read_text(encoding="utf-8"))
    cache.validate_meta(meta)
    cats = [f["category"] for f in meta["scan_result"]["flags"]]
    assert "credentials" in cats
    assert meta["scan_result"]["passed"] is False
    # The credential bytes themselves MUST NOT appear in any flag detail
    # (the audit log must not persist what it caught).
    for flag in meta["scan_result"]["flags"]:
        assert "AKIA" + "A" * 16 not in flag["detail"]

    # Audit log carries one cache:put record with scan_passed=false.
    audit = (tmp_path / "quarantine-audit.jsonl").read_text(encoding="utf-8")
    record = json.loads(audit.splitlines()[0])
    assert record["event"] == "cache:put"
    assert record["scan_passed"] is False
    assert record["content_written"] is False
