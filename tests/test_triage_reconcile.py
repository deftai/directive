"""Tests for scripts/triage_reconcile.py (#1468).

Covers the acceptance criteria in the issue body:

- A consumer whose ``candidates.jsonl`` is reset/lost can recover full
  triage state from the on-disk vBRIEF inventory via the single
  discoverable repair verb (no manual JSONL editing, no cache re-fetch).
- ``task triage:summary`` no longer reports an issue as ``untriaged``
  once the reconcile path has run (the regression lane wires
  triage_summary + triage_reconcile together).
- Regression coverage: reset the audit log to a single backfill entry
  while N proposed/ vBRIEFs exist; assert reconcile restores N accept
  decisions and the summary ``untriaged`` count returns to 0.

The tests are hermetic: the modules are imported directly via
``importlib`` (mirrors test_triage_bootstrap.py / test_triage_summary.py)
so failures surface as Python exceptions and we never shell out to
``uv run``.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_reconcile = importlib.import_module("triage_reconcile")
triage_summary = importlib.import_module("triage_summary")
candidates_log = importlib.import_module("candidates_log")


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def _scope_vbrief(
    folder: Path,
    slug: str,
    issue_number: int,
    *,
    repo: str = "deftai/directive",
    with_ref: bool = True,
) -> Path:
    """Write a minimal scope vBRIEF carrying an x-vbrief/github-issue ref."""
    folder.mkdir(parents=True, exist_ok=True)
    references = []
    if with_ref:
        references = [
            {
                "type": "x-vbrief/github-issue",
                "uri": f"https://github.com/{repo}/issues/{issue_number}",
            }
        ]
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "id": slug,
            "title": slug,
            "status": "proposed",
            "references": references,
        },
    }
    path = folder / f"{slug}.vbrief.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _audit_entry(
    repo: str,
    issue_number: int,
    decision: str,
    *,
    actor: str = "agent:bootstrap",
    decision_id: str = "00000000-0000-0000-0000-000000000001",
    timestamp: str = "2026-06-03T12:00:00Z",
) -> dict:
    return {
        "decision_id": decision_id,
        "timestamp": timestamp,
        "repo": repo,
        "issue_number": issue_number,
        "decision": decision,
        "actor": actor,
        "reason": "seed",
    }


def _write_audit_log(project_root: Path, entries: list[dict]) -> Path:
    log_path = project_root / triage_reconcile.AUDIT_LOG_RELPATH
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", encoding="utf-8", newline="") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, sort_keys=True, ensure_ascii=False) + "\n")
    return log_path


def _read_audit_entries(project_root: Path) -> list[dict]:
    log_path = project_root / triage_reconcile.AUDIT_LOG_RELPATH
    if not log_path.exists():
        return []
    return [
        json.loads(raw)
        for raw in log_path.read_text(encoding="utf-8").splitlines()
        if raw.strip()
    ]


def _make_cached_issue(cache_root: Path, repo: str, number: int) -> None:
    owner, name = repo.split("/", 1)
    entry = cache_root / "github-issue" / owner / name / str(number)
    entry.mkdir(parents=True, exist_ok=True)
    (entry / "meta.json").write_text("{}", encoding="utf-8")


# ---------------------------------------------------------------------------
# Core reconcile behaviour
# ---------------------------------------------------------------------------


def test_reconcile_restores_missing_accepts_for_proposed_vbriefs(tmp_path: Path) -> None:
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-a", 2, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-b", 3, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "pending", "story-c", 4, repo=repo)
    # Audit log starts with only a single bootstrap backfill entry (#5).
    _write_audit_log(tmp_path, [_audit_entry(repo, 5, "accept")])

    result = triage_reconcile.reconcile(tmp_path, repo=repo)

    assert result.exit_code == 0
    assert result.restored == 3
    assert result.skipped_existing == 0
    restored_issues = sorted(item.issue_number for item in result.items)
    assert restored_issues == [2, 3, 4]

    entries = _read_audit_entries(tmp_path)
    # Original #5 entry + 3 reconciled accepts.
    by_issue = {e["issue_number"]: e for e in entries}
    assert set(by_issue) == {2, 3, 4, 5}
    for n in (2, 3, 4):
        assert by_issue[n]["decision"] == "accept"
        assert by_issue[n]["actor"] == triage_reconcile.RECONCILE_ACTOR


def test_reconcile_is_idempotent(tmp_path: Path) -> None:
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-a", 2, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-b", 3, repo=repo)

    first = triage_reconcile.reconcile(tmp_path, repo=repo)
    assert first.restored == 2

    second = triage_reconcile.reconcile(tmp_path, repo=repo)
    assert second.exit_code == 0
    assert second.restored == 0
    assert second.skipped_existing == 2

    # No duplicate entries created on the second run.
    entries = _read_audit_entries(tmp_path)
    assert len(entries) == 2


def test_reconcile_does_not_override_existing_decision(tmp_path: Path) -> None:
    """An issue with a real decision (reject) + surviving vBRIEF is NOT reanimated."""
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-rejected", 7, repo=repo)
    _write_audit_log(tmp_path, [_audit_entry(repo, 7, "reject", actor="operator")])

    result = triage_reconcile.reconcile(tmp_path, repo=repo)

    assert result.restored == 0
    assert result.skipped_existing == 1
    entries = _read_audit_entries(tmp_path)
    assert len(entries) == 1
    assert entries[0]["decision"] == "reject"


def test_reconcile_dry_run_writes_nothing(tmp_path: Path) -> None:
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-a", 2, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "active", "story-b", 3, repo=repo)

    result = triage_reconcile.reconcile(tmp_path, repo=repo, dry_run=True)

    assert result.dry_run is True
    assert result.restored == 2
    # No audit log was created.
    assert not (tmp_path / triage_reconcile.AUDIT_LOG_RELPATH).exists()


def test_reconcile_parses_repo_from_reference_uri(tmp_path: Path) -> None:
    """Reconcile works with no --repo: the repo is read from the vBRIEF URI."""
    _scope_vbrief(
        tmp_path / "vbrief" / "proposed", "story-a", 2, repo="deftai/statusreport"
    )

    result = triage_reconcile.reconcile(tmp_path, repo=None)

    assert result.restored == 1
    entries = _read_audit_entries(tmp_path)
    assert entries[0]["repo"] == "deftai/statusreport"
    assert entries[0]["issue_number"] == 2


def test_reconcile_skips_cancelled_and_completed(tmp_path: Path) -> None:
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-live", 2, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "cancelled", "story-cancelled", 8, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "completed", "story-done", 9, repo=repo)

    result = triage_reconcile.reconcile(tmp_path, repo=repo)

    assert result.restored == 1
    assert result.items[0].issue_number == 2
    logged = {e["issue_number"] for e in _read_audit_entries(tmp_path)}
    assert logged == {2}


def test_reconcile_ignores_vbriefs_without_github_ref(tmp_path: Path) -> None:
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "no-ref", 0, with_ref=False)

    result = triage_reconcile.reconcile(tmp_path, repo=repo)

    assert result.restored == 0
    assert not (tmp_path / triage_reconcile.AUDIT_LOG_RELPATH).exists()


def test_reconciled_entries_are_schema_valid(tmp_path: Path) -> None:
    """Entries written by reconcile round-trip through candidates_log.read_all."""
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-a", 2, repo=repo)
    triage_reconcile.reconcile(tmp_path, repo=repo)

    log_path = tmp_path / triage_reconcile.AUDIT_LOG_RELPATH
    rows = candidates_log.read_all(path=log_path)
    assert len(rows) == 1
    latest = candidates_log.latest_decision(2, repo, path=log_path)
    assert latest is not None
    assert latest["decision"] == "accept"


# ---------------------------------------------------------------------------
# find_reconcilable / count_reconcilable helpers
# ---------------------------------------------------------------------------


def test_find_reconcilable_excludes_already_logged(tmp_path: Path) -> None:
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-a", 2, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-b", 3, repo=repo)
    _write_audit_log(tmp_path, [_audit_entry(repo, 2, "accept")])

    items = triage_reconcile.find_reconcilable(tmp_path, default_repo=repo)
    nums = sorted(i.issue_number for i in items)
    assert nums == [3]


def test_count_reconcilable_restrict_to_intersects(tmp_path: Path) -> None:
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-a", 2, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-b", 3, repo=repo)

    # Only (repo, 2) is in the restrict set, so the count is 1 even though
    # two vBRIEFs are reconcilable.
    total = triage_reconcile.count_reconcilable(
        tmp_path, restrict_to={(repo, 2)}
    )
    assert total == 1


def _bare_uri_vbrief(folder: Path, slug: str, issue_number: int) -> Path:
    """Write a vBRIEF whose github-issue ref URI omits the owner/repo segment."""
    folder.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "status": "proposed",
            "references": [
                {"type": "x-vbrief/github-issue", "uri": str(issue_number)}
            ],
        },
    }
    path = folder / f"{slug}.vbrief.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_count_reconcilable_default_repo_covers_bare_uri(tmp_path: Path) -> None:
    """A bare-URI vBRIEF is counted only with default_repo -- the parity fix
    that keeps the summary hint in sync with what the reconcile verb restores.
    """
    repo = "deftai/directive"
    _bare_uri_vbrief(tmp_path / "vbrief" / "proposed", "bare", 42)

    # Without a fallback repo the bare-URI vBRIEF is skipped...
    assert triage_reconcile.count_reconcilable(tmp_path) == 0
    # ...but with default_repo it resolves and is counted (matches reconcile).
    assert triage_reconcile.count_reconcilable(tmp_path, default_repo=repo) == 1
    assert (
        triage_reconcile.count_reconcilable(
            tmp_path, default_repo=repo, restrict_to={(repo, 42)}
        )
        == 1
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_main_returns_two_on_missing_project_root(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    rc = triage_reconcile.main(["--project-root", str(missing)])
    assert rc == 2


def test_main_json_output(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    repo = "deftai/directive"
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-a", 2, repo=repo)
    rc = triage_reconcile.main(
        ["--project-root", str(tmp_path), "--repo", repo, "--json"]
    )
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["restored"] == 1
    assert payload["items"][0]["issue_number"] == 2


def test_main_help_is_intercepted(capsys: pytest.CaptureFixture[str]) -> None:
    rc = triage_reconcile.main(["--help"])
    assert rc == 0
    assert "task triage:reconcile" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# AC regression: reconcile clears the summary untriaged miscount (#1468)
# ---------------------------------------------------------------------------


def test_summary_untriaged_clears_after_reconcile(tmp_path: Path) -> None:
    """End-to-end #1468 acceptance lane.

    Reset the audit log to a single bootstrap-backfill entry while N
    proposed/ vBRIEFs (with valid github-issue refs) exist and their
    issues are cached. The summary first reports them as ``untriaged``
    and emits the ``[triage:reconcile] N`` hint; after the reconcile
    path runs, the untriaged count returns to 0 and the hint clears.
    """
    repo = "deftai/directive"
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    # Cache #2-#5; vBRIEFs exist for #2,#3 (proposed) and #4 (pending);
    # #5 is the lone bootstrap-backfill survivor in the audit log.
    for n in (2, 3, 4, 5):
        _make_cached_issue(cache_root, repo, n)
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-2", 2, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-3", 3, repo=repo)
    _scope_vbrief(tmp_path / "vbrief" / "pending", "story-4", 4, repo=repo)
    _write_audit_log(tmp_path, [_audit_entry(repo, 5, "accept")])

    before = triage_summary.compute_summary(tmp_path)
    # #2,#3,#4 are untriaged (no audit decision); #5 is accepted.
    assert before.untriaged == 3
    assert before.reconcilable == 3
    rendered_before = triage_summary.format_summary(before)
    assert "[triage:reconcile] 3" in rendered_before

    # Run the repair path.
    result = triage_reconcile.reconcile(tmp_path, repo=repo)
    assert result.restored == 3

    after = triage_summary.compute_summary(tmp_path)
    assert after.untriaged == 0
    assert after.reconcilable == 0
    rendered_after = triage_summary.format_summary(after)
    assert "[triage:reconcile]" not in rendered_after


def test_summary_reconcile_hint_absent_when_no_divergence(tmp_path: Path) -> None:
    """No vBRIEF on disk for an untriaged cached issue -> no reconcile hint."""
    repo = "deftai/directive"
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, repo, 2)
    # No vBRIEF and no audit entry -> genuinely untriaged, not reconcilable.

    result = triage_summary.compute_summary(tmp_path)
    assert result.untriaged == 1
    assert result.reconcilable == 0
    assert triage_summary.format_reconcile_hint_line(result) is None


def test_summary_hint_counts_bare_uri_vbrief_via_cache_repo(tmp_path: Path) -> None:
    """Summary derives the fallback repo from the cached keys, so a bare-URI
    vBRIEF for a cached issue still surfaces in the [triage:reconcile] hint --
    keeping the hint in sync with what `task triage:reconcile` would restore.
    """
    repo = "deftai/directive"
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, repo, 42)
    _bare_uri_vbrief(tmp_path / "vbrief" / "proposed", "bare", 42)

    result = triage_summary.compute_summary(tmp_path)
    assert result.untriaged == 1
    assert result.reconcilable == 1
    assert "[triage:reconcile] 1" in triage_summary.format_summary(result)
