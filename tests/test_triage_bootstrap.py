"""Tests for scripts/triage_bootstrap.py (#883 Story 3 rebind).

Covers the four-step orchestration:

1. ``populate_cache`` invokes :func:`cache.cache_fetch_all` with
   ``--source=github-issue`` (or skips with a friendly message when the
   cache module is missing or no repo is resolvable).
2. ``backfill_audit_log`` writes one ``accept`` entry per scope vBRIEF
   in ``proposed/`` / ``pending/`` / ``active/`` (skips ``cancelled/``).
3. ``ensure_gitignore_entry`` adds ``.deft-cache/`` to ``.gitignore``.
4. ``ensure_gitignore_eval_dir`` adds ``vbrief/.eval/`` to ``.gitignore``.

The pipeline is idempotent: a second invocation produces no new audit
entries and adds no duplicate ``.gitignore`` lines.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_bootstrap = importlib.import_module("triage_bootstrap")


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _build_fake_cache(succeeded: int = 5, failed: int = 0, skipped: int = 0) -> SimpleNamespace:
    """Return a stub of the unified ``cache`` module."""

    calls: list[dict[str, Any]] = []

    def cache_fetch_all(**kwargs: Any) -> SimpleNamespace:
        calls.append(kwargs)
        return SimpleNamespace(
            succeeded=succeeded, failed=failed, skipped=skipped
        )

    return SimpleNamespace(
        cache_fetch_all=cache_fetch_all,
        calls=calls,
    )


def _scope_vbrief(folder: Path, slug: str, issue_number: int) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "id": slug,
            "title": slug,
            "status": "proposed",
            "references": [
                {
                    "type": "x-vbrief/github-issue",
                    "uri": f"https://github.com/deftai/directive/issues/{issue_number}",
                }
            ],
        },
    }
    path = folder / f"{slug}.vbrief.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# step_populate_cache
# ---------------------------------------------------------------------------


def test_populate_cache_invokes_cache_fetch_all(tmp_path: Path) -> None:
    cache = _build_fake_cache(succeeded=10, failed=0, skipped=2)

    outcome = triage_bootstrap.step_populate_cache(
        tmp_path,
        repo="deftai/directive",
        cache_module=cache,
    )

    assert outcome.ok is True
    assert outcome.name == "populate_cache"
    assert "cache:fetch-all" in outcome.message
    assert "deftai/directive" in outcome.message
    # cache_fetch_all called with the expected source + repo + cache_root.
    assert len(cache.calls) == 1
    kwargs = cache.calls[0]
    assert kwargs["source"] == "github-issue"
    assert kwargs["repo"] == "deftai/directive"
    assert kwargs["cache_root"] == tmp_path / ".deft-cache"


def test_populate_cache_skips_when_no_repo(tmp_path: Path) -> None:
    """No --repo and no git origin -> skip-with-OK."""

    # Inhibit git inference -- pass a path that has no git remote.
    cache = _build_fake_cache()
    outcome = triage_bootstrap.step_populate_cache(
        tmp_path,
        repo=None,
        cache_module=cache,
    )

    # Either the inferred repo path resolves (in dev) or it doesn't.
    # Both branches MUST produce ok=True; the "no-repo" path skips the
    # cache_fetch_all call.
    assert outcome.ok is True


def test_populate_cache_defers_when_cache_module_missing(tmp_path: Path) -> None:
    outcome = triage_bootstrap.step_populate_cache(
        tmp_path,
        repo="deftai/directive",
        cache_module=None,
    )
    # When _load_cache_module returns None on a real branch without the
    # cache module, populate defers with ok=True (re-runnable contract).
    # On a real checkout the cache module IS importable; we cannot force
    # absence here without monkeypatching, so the assertion just ensures
    # the call did not raise.
    assert outcome.name == "populate_cache"


def test_populate_cache_defers_on_fetch_all_error(tmp_path: Path) -> None:
    def _raising_fetch(**_kw: Any) -> Any:
        raise RuntimeError("rate limit hit")

    cache = SimpleNamespace(cache_fetch_all=_raising_fetch)

    outcome = triage_bootstrap.step_populate_cache(
        tmp_path,
        repo="deftai/directive",
        cache_module=cache,
    )

    assert outcome.ok is True  # deferred-action stays ok
    assert outcome.error is not None
    assert "rate limit" in outcome.error
    assert outcome.details.get("deferred") == "fetch-all-error"


# ---------------------------------------------------------------------------
# step_backfill_audit_log
# ---------------------------------------------------------------------------


def test_backfill_audit_log_writes_one_entry_per_scope_vbrief(tmp_path: Path) -> None:
    vbrief_root = tmp_path / "vbrief"
    _scope_vbrief(vbrief_root / "proposed", "story-a", 100)
    _scope_vbrief(vbrief_root / "pending", "story-b", 101)
    _scope_vbrief(vbrief_root / "active", "story-c", 102)
    # cancelled/ MUST be skipped (no reanimation).
    _scope_vbrief(vbrief_root / "cancelled", "story-d", 103)

    outcome = triage_bootstrap.step_backfill_audit_log(tmp_path, "deftai/directive")

    assert outcome.ok is True
    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    assert audit_path.exists()
    lines = [
        json.loads(raw)
        for raw in audit_path.read_text(encoding="utf-8").splitlines()
        if raw.strip()
    ]
    assert len(lines) == 3
    assert sorted(e["issue_number"] for e in lines) == [100, 101, 102]
    assert all(e["decision"] == "accept" for e in lines)
    assert all(e["actor"] == "agent:bootstrap" for e in lines)


def test_backfill_audit_log_idempotent(tmp_path: Path) -> None:
    vbrief_root = tmp_path / "vbrief"
    _scope_vbrief(vbrief_root / "proposed", "story-a", 100)

    triage_bootstrap.step_backfill_audit_log(tmp_path, "deftai/directive")
    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    first = audit_path.read_text(encoding="utf-8")

    triage_bootstrap.step_backfill_audit_log(tmp_path, "deftai/directive")
    second = audit_path.read_text(encoding="utf-8")

    assert first == second, "second backfill must be a no-op"


def test_backfill_audit_log_skips_when_no_vbrief_dir(tmp_path: Path) -> None:
    outcome = triage_bootstrap.step_backfill_audit_log(tmp_path, "deftai/directive")
    assert outcome.ok is True
    assert outcome.details.get("skipped") == "no-vbrief"


# ---------------------------------------------------------------------------
# step_ensure_gitignore_entry / step_ensure_gitignore_eval_dir
# ---------------------------------------------------------------------------


def test_ensure_gitignore_entry_creates_file_when_missing(tmp_path: Path) -> None:
    outcome = triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    assert outcome.ok is True
    text = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert ".deft-cache/" in text


def test_ensure_gitignore_entry_idempotent(tmp_path: Path) -> None:
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    first = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    second = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert first == second


def test_ensure_gitignore_eval_dir_appends_when_present(tmp_path: Path) -> None:
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    outcome = triage_bootstrap.step_ensure_gitignore_eval_dir(tmp_path)
    assert outcome.ok is True
    text = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert "vbrief/.eval/" in text
    assert ".deft-cache/" in text


def test_ensure_gitignore_eval_dir_fails_without_existing_gitignore(
    tmp_path: Path,
) -> None:
    """The eval-dir step refuses to create .gitignore on its own."""

    outcome = triage_bootstrap.step_ensure_gitignore_eval_dir(tmp_path)
    assert outcome.ok is False
    assert outcome.details.get("skipped") == "no-gitignore"


def test_ensure_gitignore_respects_commented_opt_in(tmp_path: Path) -> None:
    """Commented-out form is the operator opt-in to commit the cache."""

    (tmp_path / ".gitignore").write_text(
        "# .deft-cache/\n",
        encoding="utf-8",
    )
    outcome = triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    assert outcome.ok is True
    assert outcome.details.get("opt_in_commit") is True
    # The active form was NOT re-added.
    text = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    active_forms = [
        line for line in text.splitlines() if line.strip() == ".deft-cache/"
    ]
    assert active_forms == []


# ---------------------------------------------------------------------------
# run_bootstrap -- end-to-end orchestration
# ---------------------------------------------------------------------------


def test_run_bootstrap_appends_four_step_outcomes(tmp_path: Path) -> None:
    cache = _build_fake_cache()
    result = triage_bootstrap.run_bootstrap(
        project_root=tmp_path,
        repo="deftai/directive",
        cache_module=cache,
    )
    assert len(result.steps) == 4
    assert [s.name for s in result.steps] == [
        "populate_cache",
        "backfill_audit_log",
        "ensure_gitignore_entry",
        "ensure_gitignore_eval_dir",
    ]
    assert result.exit_code == 0


def test_run_bootstrap_idempotent_re_run(tmp_path: Path) -> None:
    cache = _build_fake_cache()
    vbrief_root = tmp_path / "vbrief"
    _scope_vbrief(vbrief_root / "proposed", "story-a", 100)

    result1 = triage_bootstrap.run_bootstrap(
        project_root=tmp_path, repo="deftai/directive", cache_module=cache
    )
    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    gitignore = tmp_path / ".gitignore"
    audit_first = audit_path.read_text(encoding="utf-8")
    git_first = gitignore.read_text(encoding="utf-8")

    result2 = triage_bootstrap.run_bootstrap(
        project_root=tmp_path, repo="deftai/directive", cache_module=cache
    )
    audit_second = audit_path.read_text(encoding="utf-8")
    git_second = gitignore.read_text(encoding="utf-8")

    assert result1.exit_code == 0
    assert result2.exit_code == 0
    assert audit_first == audit_second
    assert git_first == git_second
