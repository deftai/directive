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
4. ``test_skill_phase0_references_cache_star`` -- Phase 0 prose
   references ``cache:*`` (the rebind), references no longer mention the
   removed ``triage:cache`` task, and the three-tier inventory model is
   intact.
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
# Content tests for the rewritten Phase 0 prose
# ---------------------------------------------------------------------------


def _skill_text() -> str:
    return SKILL.read_text(encoding="utf-8")


def test_skill_phase0_references_cache_star() -> None:
    """Phase 0 prose now references the unified `cache:*` surface."""

    text = _skill_text()
    assert "task cache:fetch-all" in text, (
        "Phase 0 must point at the unified cache:fetch-all surface"
    )
    assert "task cache:get" in text, (
        "Phase 0 must point at the unified cache:get surface"
    )
    assert ".deft-cache/github-issue/" in text, (
        "Phase 0 must describe the unified cache layout"
    )


def test_skill_phase0_does_not_advertise_removed_tasks() -> None:
    """Removed task aliases must not appear as live recommendations.

    The migration paragraph noting that ``task triage:cache`` and
    ``task triage:show`` were removed under #883 Story 3 is permitted
    (and tested for explicitly below). What this guard rejects is any
    invocation form that prescribes the removed command as the next
    step the operator should run -- e.g. ``task triage:cache populate``
    with arguments or ``-- --repo`` flag forms.
    """

    text = _skill_text()
    # Concrete invocations of the removed surface MUST NOT appear.
    assert "`task triage:cache populate`" not in text
    assert "`task triage:cache --" not in text
    assert "`task triage:show --" not in text
    # The skill MUST NOT recommend ``task triage:refresh`` -- it has been
    # superseded by ``task cache:fetch-all`` for re-population.
    assert "`task triage:refresh`" not in text
    # The skill MUST explicitly cite the removal so operators know not to
    # reach for the legacy commands in v0.26.0+.
    assert "removed in #883 Story 3" in text


def test_skill_phase0_three_tier_inventory_model_preserved() -> None:
    """The three-tier inventory model (Tier 1 / Tier 2 / Tier 3) survives."""

    text = _skill_text()
    assert "Tier 1 --" in text and "Tier 2 --" in text and "Tier 3 --" in text
    assert "vbrief/.eval/candidates.jsonl" in text
    assert "vbrief/proposed/" in text


def test_skill_phase0_action_menu_intact() -> None:
    """The canonical numbered action menu and its 7 options survive verbatim."""

    text = _skill_text()
    for opt in (
        "1. Accept",
        "2. Reject",
        "3. Defer",
        "4. Needs-AC",
        "5. Mark duplicate",
        "6. Discuss",
        "7. Back",
    ):
        assert opt in text, f"action-menu option missing: {opt}"
