"""tests/integration/test_triage_smoke.py -- end-to-end smoke for #883 Story 3.

Regression coverage for the rebind onto the unified `cache:*` surface:

1. ``test_bulk_defer_actions_only_cached`` -- with N issues populated
   under ``.deft-cache/github-issue/<owner>/<repo>/<N>/`` AND a fake-gh
   shim on PATH that would return 50 different live issues, the
   bulk-defer run actions ONLY the cached issues. The fake-gh shim never
   executes (the rewritten triage_bulk.py is cache-only), but its
   presence on PATH proves no live-gh fallback survived the rebind.
2. ``test_bulk_defer_idempotent`` -- a second run appends ZERO new
   audit records (the Tier-2 short-circuit honours the prior `defer`
   records).
3. ``test_empty_cache_hard_fails`` -- bulk-defer against an empty cache
   exits 2 with the canonical stderr message ``cache is empty for {repo}``.

Note: the pre-#1141 Phase 0 prose content tests that previously lived
here (three-tier inventory model, 7-option action menu, ``removed in
#883 Story 3`` note) were superseded by the N1 / #1141 cache-first Phase
0 rewrite. Equivalent coverage of the new Phase 0 structure -- the three
sub-phases (0a / 0b / 0c) in canonical order, ``task triage:summary``,
``task triage:queue --state=accept``, ``[RESUME]`` semantics, See-also
footer, empty-cache fallback prompt, ``task scope:undo`` row in the
Phase 4 verb table -- lives at ``tests/content/test_refinement_skill.py``.
"""

from __future__ import annotations

import importlib
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

triage_bulk = importlib.import_module("triage_bulk")
candidates_log = importlib.import_module("candidates_log")
cache = importlib.import_module("cache")


REPO = "deftai/directive"
SKILL = REPO_ROOT / "skills" / "deft-directive-refinement" / "SKILL.md"


# ---------------------------------------------------------------------------
# Cache-walk fixtures (unified layout)
# ---------------------------------------------------------------------------


def _cached_issue(number: int, *, label: str = "triage") -> dict[str, Any]:
    return {
        "number": number,
        "title": f"Cached issue {number}",
        "body": "",
        "state": "open",
        "labels": [{"name": label}],
        "author": {"login": "octocat"},
        "createdAt": "2026-04-25T00:00:00Z",
        "updatedAt": "2026-04-25T00:00:00Z",
        "url": f"https://github.com/{REPO}/issues/{number}",
    }


def _populate_cache_layout(
    cache_root: Path, repo: str, issue_numbers: list[int]
) -> None:
    """Write the unified-cache layout + meta.json for each issue."""

    owner, name = repo.split("/", 1)
    base = cache_root / "github-issue" / owner / name
    base.mkdir(parents=True, exist_ok=True)
    for n in issue_numbers:
        edir = base / str(n)
        edir.mkdir(parents=True, exist_ok=True)
        payload = _cached_issue(n)
        (edir / "raw.json").write_text(json.dumps(payload), encoding="utf-8")
        meta = {
            "source": "github-issue",
            "key": f"{repo}/{n}",
            "fetched_at": "2026-05-05T00:00:00Z",
            "ttl_seconds": 7 * 24 * 60 * 60,
            "expires_at": "2099-01-01T00:00:00Z",
            "scan_result": {
                "passed": True,
                "scanned_at": "2026-05-05T00:00:00Z",
                "scanner_version": "2.0.0",
                "flags": [],
            },
            "size_bytes": len(json.dumps(payload)),
            "stale": False,
        }
        (edir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")


@pytest.fixture
def isolated_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, Path]:
    """Redirect cache root + audit log into ``tmp_path``."""

    cache_root = tmp_path / ".deft-cache"
    audit_log = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"

    # Redirect the unified cache's default root to tmp.
    monkeypatch.setattr(cache, "DEFAULT_CACHE_ROOT", cache_root)
    monkeypatch.setattr(candidates_log, "DEFAULT_LOG_PATH", audit_log)

    # Wrap triage_bulk's list_cached_candidates to read from tmp_path. The
    # bulk_action() caller passes ``cache_root=None`` (from ``main``), and
    # ``setdefault`` would leave that None in place; force-set instead.
    original = triage_bulk.list_cached_candidates

    def _scoped_list(repo: str, **kwargs: Any) -> list[dict[str, Any]]:
        if kwargs.get("cache_root") is None:
            kwargs["cache_root"] = cache_root
        return original(repo, **kwargs)

    monkeypatch.setattr(triage_bulk, "list_cached_candidates", _scoped_list)

    # Fake-gh shim on PATH: presence-only canary. A regression that
    # re-introduced a live-gh fallback would invoke this and surface 50
    # extra issues into the audit log, making test failures loud.
    fake_path = tmp_path / "fake-bin"
    fake_path.mkdir()
    if sys.platform == "win32":
        py_helper = fake_path / "_fake_gh.py"
        py_helper.write_text(_FAKE_GH_PY, encoding="utf-8")
        cmd_wrapper = fake_path / "gh.cmd"
        cmd_wrapper.write_text(
            f'@echo off\r\n"{sys.executable}" "{py_helper}" %*\r\n',
            encoding="utf-8",
        )
    else:
        sh_helper = fake_path / "gh"
        sh_helper.write_text(
            f"#!{sys.executable}\n{_FAKE_GH_PY}",
            encoding="utf-8",
        )
        sh_helper.chmod(
            sh_helper.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
        )

    monkeypatch.setenv(
        "PATH", str(fake_path) + os.pathsep + os.environ.get("PATH", "")
    )
    return cache_root, audit_log


_FAKE_GH_PY = '''import json
import sys

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


def _read_audit_records(audit_log: Path) -> list[dict[str, Any]]:
    if not audit_log.exists():
        return []
    return [
        json.loads(raw)
        for raw in audit_log.read_text(encoding="utf-8").splitlines()
        if raw.strip()
    ]


# ---------------------------------------------------------------------------
# Bulk-defer cache-only invariants
# ---------------------------------------------------------------------------


def test_bulk_defer_actions_only_cached(
    isolated_runtime: tuple[Path, Path],
    capsys: pytest.CaptureFixture[str],
) -> None:
    cache_root, audit_log = isolated_runtime
    cached_numbers = [1, 2, 3, 4, 5]
    _populate_cache_layout(cache_root, REPO, cached_numbers)

    rc = triage_bulk.main(["defer", "--repo", REPO])
    assert rc == 0, capsys.readouterr().err

    records = _read_audit_records(audit_log)
    actioned = sorted(r["issue_number"] for r in records)
    assert actioned == cached_numbers, (
        f"bulk-defer must only action cached issues; got {actioned}, "
        f"expected {cached_numbers}"
    )
    # Defensive: no record references a fake-live issue number (100-149).
    assert not any(100 <= int(r["issue_number"]) < 150 for r in records), (
        "fake-gh issues leaked into audit log -- live-gh fallback regressed"
    )
    assert all(r["decision"] == "defer" for r in records)


def test_bulk_defer_idempotent(
    isolated_runtime: tuple[Path, Path],
    capsys: pytest.CaptureFixture[str],
) -> None:
    cache_root, audit_log = isolated_runtime
    _populate_cache_layout(cache_root, REPO, [1, 2, 3, 4, 5])

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
    _cache_root, audit_log = isolated_runtime

    rc = triage_bulk.main(["defer", "--repo", REPO])
    assert rc == 2

    captured = capsys.readouterr()
    assert "cache is empty for deftai/directive" in captured.err
    assert "task triage:bootstrap" in captured.err

    assert _read_audit_records(audit_log) == []


# ---------------------------------------------------------------------------
# Phase 0 prose content tests moved to tests/content/test_refinement_skill.py
# (N1 / #1141 cache-first Phase 0 rewrite supersedes the pre-#1141
# three-tier inventory model + 7-option action menu pinned here previously).
# ---------------------------------------------------------------------------
