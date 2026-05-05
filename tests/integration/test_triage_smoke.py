"""tests/integration/test_triage_smoke.py -- end-to-end smoke for #915.

Regression coverage for the v1 cache contract bugfix shipped with #915.

Covers three scenarios end-to-end through ``triage_bulk.main``:

1. ``test_bulk_defer_actions_only_cached`` -- with 5 cached issues AND a
   fake-gh shim on PATH that would return 50 different live issues, the
   bulk-defer run actions ONLY the 5 cached issues. The fake-gh shim
   never executes (the rewritten triage_bulk.py is cache-only), but its
   presence on PATH proves no live-gh fallback survived the rewrite.
2. ``test_bulk_defer_idempotent`` -- a second run of bulk-defer over the
   same cache appends ZERO new audit records (the Tier-2 short-circuit
   honours the prior `defer` records).
3. ``test_empty_cache_hard_fails`` -- bulk-defer against an empty cache
   exits 2 with the canonical stderr message ``cache is empty for {repo}``
   and never appends audit records.

The audit log is redirected to the test's tmp directory by monkeypatching
``candidates_log.DEFAULT_LOG_PATH`` and the cache root is redirected via
``triage_cache.DEFAULT_CACHE_ROOT``. No live network calls; deterministic.
"""

from __future__ import annotations

import importlib
import json
import os
import stat
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

triage_bulk = importlib.import_module("triage_bulk")
triage_cache = importlib.import_module("triage_cache")
candidates_log = importlib.import_module("candidates_log")


REPO = "deftai/directive"
REPO_DIR_NAME = "deftai-directive"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _cached_issue(number: int, *, label: str = "triage") -> dict[str, Any]:
    """Build a sidecar payload mirroring ``triage_cache._GH_FIELDS``."""
    created = (datetime.now(UTC) - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "number": number,
        "title": f"Cached issue {number}",
        "body": "",
        "state": "open",
        "labels": [{"name": label}],
        "author": {"login": "octocat"},
        "createdAt": created,
        "updatedAt": created,
        "url": f"https://github.com/{REPO}/issues/{number}",
    }


@pytest.fixture
def isolated_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, Path]:
    """Redirect cache root + audit log into ``tmp_path`` for the duration.

    Returns ``(cache_root, audit_log_path)`` so the test can assert against
    the redirected locations. Also installs a fake ``gh`` shim on PATH that
    would crash with a clear marker if any live-gh call survived the
    rewrite.
    """
    cache_root = tmp_path / ".deft-cache" / "issues"
    audit_log = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"

    monkeypatch.setattr(triage_cache, "DEFAULT_CACHE_ROOT", cache_root)
    monkeypatch.setattr(candidates_log, "DEFAULT_LOG_PATH", audit_log)

    # Fake-gh shim on PATH: any subprocess call to `gh` from triage_bulk.py
    # would invoke this and SHOULD never happen post-#915. The shim writes
    # 50 distinct issue payloads to stdout to mimic a populated remote and
    # exits 0 -- so a regression that re-introduced the live-gh fallback
    # would silently action 50 issues and the assertion in the calling
    # test would fail loudly.
    fake_path = tmp_path / "fake-bin"
    fake_path.mkdir()
    if sys.platform == "win32":
        # Windows resolves PATH lookups via PATHEXT; ship both a .cmd
        # wrapper (covers the bare ``gh`` invocation) and a python script
        # the .cmd dispatches to, so the canary works regardless of the
        # subprocess shell argv expansion.
        py_helper = fake_path / "_fake_gh.py"
        py_helper.write_text(_FAKE_GH_PY, encoding="utf-8")
        cmd_wrapper = fake_path / "gh.cmd"
        cmd_wrapper.write_text(
            f'@echo off\r\n"{sys.executable}" "{py_helper}" %*\r\n',
            encoding="utf-8",
        )
    else:
        # Use the full absolute interpreter path in the shebang -- a versioned
        # `python3.12` form via env(1) can be unresolvable on UV-managed Python
        # installations or stripped CI images, which would mask the canary's
        # regression-detection role with a silent exec error (Greptile #920).
        sh_helper = fake_path / "gh"
        sh_helper.write_text(
            f"#!{sys.executable}\n{_FAKE_GH_PY}",
            encoding="utf-8",
        )
        sh_helper.chmod(sh_helper.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    monkeypatch.setenv("PATH", str(fake_path) + os.pathsep + os.environ.get("PATH", ""))
    return cache_root, audit_log


_FAKE_GH_PY = '''import json
import sys

# Emit 50 distinct "live" issues if anyone actually calls us. The numbers
# are intentionally disjoint from the test cache (1..5) so any contamination
# would be obvious in test failures.
payload = [
    {
        "number": n,
        "title": f"FAKE-LIVE issue {n}",
        "body": "",
        "state": "open",
        "labels": [],
        "author": {"login": "ghost"},
        "createdAt": "2026-05-01T00:00:00Z",
        "updatedAt": "2026-05-01T00:00:00Z",
        "url": f"https://example.invalid/issues/{n}",
    }
    for n in range(100, 150)
]
sys.stdout.write(json.dumps(payload))
sys.exit(0)
'''


def _populate_cache(cache_root: Path, count: int = 5) -> list[int]:
    """Create ``count`` issue sidecars under ``cache_root/<owner-repo>/``."""
    repo_dir = cache_root / REPO_DIR_NAME
    repo_dir.mkdir(parents=True, exist_ok=True)
    numbers = list(range(1, count + 1))
    for n in numbers:
        (repo_dir / f"{n}.json").write_text(
            json.dumps(_cached_issue(n)), encoding="utf-8"
        )
    return numbers


def _read_audit_records(audit_log: Path) -> list[dict[str, Any]]:
    """Return the list of audit records currently on disk (or [])."""
    if not audit_log.exists():
        return []
    records: list[dict[str, Any]] = []
    for raw in audit_log.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            continue
        records.append(json.loads(line))
    return records


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_bulk_defer_actions_only_cached(
    isolated_runtime: tuple[Path, Path],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """5 cached + 50 fake-live -> exactly 5 actioned, fake-gh never consulted."""
    cache_root, audit_log = isolated_runtime
    cached_numbers = _populate_cache(cache_root, count=5)

    rc = triage_bulk.main(["defer", "--repo", REPO])
    assert rc == 0, capsys.readouterr().err

    records = _read_audit_records(audit_log)
    actioned = sorted(r["issue_number"] for r in records)
    assert actioned == cached_numbers, (
        f"bulk-defer must only action cached issues; got {actioned}, "
        f"expected {cached_numbers}"
    )
    # Defensive: no record should reference a fake-live issue number (100-149).
    assert not any(100 <= int(r["issue_number"]) < 150 for r in records), (
        "fake-gh issues leaked into the audit log -- live-gh fallback regressed"
    )
    assert all(r["decision"] == "defer" for r in records)


def test_bulk_defer_idempotent(
    isolated_runtime: tuple[Path, Path],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Second bulk-defer run produces ZERO new audit records."""
    cache_root, audit_log = isolated_runtime
    _populate_cache(cache_root, count=5)

    rc1 = triage_bulk.main(["defer", "--repo", REPO])
    assert rc1 == 0, capsys.readouterr().err
    first_count = len(_read_audit_records(audit_log))
    assert first_count == 5

    rc2 = triage_bulk.main(["defer", "--repo", REPO])
    assert rc2 == 0, capsys.readouterr().err
    second_count = len(_read_audit_records(audit_log))
    assert second_count == first_count, (
        f"idempotent invariant violated: pass-1 wrote {first_count} records, "
        f"pass-2 wrote {second_count - first_count} new ones"
    )


def test_empty_cache_hard_fails(
    isolated_runtime: tuple[Path, Path],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Empty cache -> exit 2 + canonical stderr; no audit records appended."""
    _cache_root, audit_log = isolated_runtime
    # Deliberately do NOT populate the cache.

    rc = triage_bulk.main(["defer", "--repo", REPO])
    assert rc == 2

    captured = capsys.readouterr()
    assert "cache is empty for deftai/directive" in captured.err
    assert "task triage:bootstrap" in captured.err

    assert _read_audit_records(audit_log) == []
