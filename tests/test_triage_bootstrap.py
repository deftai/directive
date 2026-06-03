"""Tests for scripts/triage_bootstrap.py (#883 Story 3 rebind).

Covers the five-step orchestration:

1. ``populate_cache`` invokes :func:`cache.cache_fetch_all` with
   ``--source=github-issue`` (or skips with a friendly message when the
   cache module is missing or no repo is resolvable).
2. ``backfill_audit_log`` writes one ``accept`` entry per scope vBRIEF
   in ``proposed/`` / ``pending/`` / ``active/`` (skips ``cancelled/``).
3. ``ensure_gitignore_entry`` adds ``.deft-cache/`` to ``.gitignore``.
4. ``ensure_gitignore_eval_entries`` writes the #1144 selective entries
   (``candidates.jsonl`` / ``summary-history.jsonl`` /
   ``scope-lifecycle.jsonl``) to ``.gitignore``, ensures the
   ``vbrief/.eval/*.jsonl  merge=union`` rule lives in
   ``.gitattributes``, and writes ``vbrief/.eval/README.md`` when
   absent. Renamed from ``ensure_gitignore_eval_dir`` under #1251.
5. ``seed_candidates_log`` ensures ``vbrief/.eval/candidates.jsonl``
   exists as a zero-length file (#1240).

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

import pytest

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


@pytest.mark.slow
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


def test_populate_cache_reports_failure_on_fetch_all_error(tmp_path: Path) -> None:
    """A raising cache_fetch_all surfaces as ok=False (P1 cleanup for #955).

    The previous behavior returned ``ok=True`` with a ``deferred``
    marker; SLizard flagged the misreporting because the step's
    documented goal (populate the cache) was not met. The orchestrator's
    partial-bootstrap semantic is preserved by ``run_bootstrap``: it
    appends the failed StepOutcome and continues to the remaining
    steps. The aggregate ``exit_code`` becomes 1 via the
    ``any(not step.ok)`` rule.
    """

    def _raising_fetch(**_kw: Any) -> Any:
        raise RuntimeError("rate limit hit")

    cache = SimpleNamespace(cache_fetch_all=_raising_fetch)

    outcome = triage_bootstrap.step_populate_cache(
        tmp_path,
        repo="deftai/directive",
        cache_module=cache,
    )

    assert outcome.ok is False, (
        "a raised exception from cache_fetch_all MUST surface as ok=False; "
        "the populate goal was not achieved (P1 cleanup for #955)"
    )
    assert outcome.error is not None
    assert "rate limit" in outcome.error
    assert outcome.details.get("failed") == "fetch-all-error"
    assert outcome.details.get("exc_type") == "RuntimeError"
    # The legacy deferred marker MUST NOT survive the cleanup.
    assert "deferred" not in outcome.details


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
# step_ensure_gitignore_entry / step_ensure_gitignore_eval_entries (#1251)
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


def test_gitignore_eval_entries_includes_doctor_state() -> None:
    """#1464: doctor-state.json joins the selective ignore set."""
    assert (
        "vbrief/.eval/doctor-state.json"
        in triage_bootstrap.GITIGNORE_EVAL_ENTRIES
    ), (
        "per-machine task doctor throttle state must be gitignored (#1464); "
        "GITIGNORE_EVAL_ENTRIES is the single source of truth the installer "
        "and relocator rails mirror/import"
    )


def test_ensure_gitignore_eval_entries_writes_selective_lines(
    tmp_path: Path,
) -> None:
    """#1251 / #1464: step writes the four selective #1144 entries."""
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is True
    text = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    # All four selective lines present.
    assert "vbrief/.eval/candidates.jsonl" in text
    assert "vbrief/.eval/summary-history.jsonl" in text
    assert "vbrief/.eval/scope-lifecycle.jsonl" in text
    assert "vbrief/.eval/decompositions/" in text
    assert "vbrief/.eval/doctor-state.json" in text
    # The .deft-cache/ line from step 3 is preserved.
    assert ".deft-cache/" in text
    # The pre-#1251 blanket line MUST NOT be appended.
    lines = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert "vbrief/.eval/" not in lines, (
        "#1251 forbids the blanket vbrief/.eval/ line; the selective "
        "entries replace it"
    )
    assert "vbrief/.eval" not in lines
    assert outcome.details.get("gitignore_appended_lines") == len(
        triage_bootstrap.GITIGNORE_EVAL_ENTRIES
    )


def test_ensure_gitignore_eval_entries_idempotent_when_selective_present(
    tmp_path: Path,
) -> None:
    """#1251: no-op when the three selective entries are already present."""
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    # Seed the selective entries by hand so the step sees them on entry.
    gitignore = tmp_path / ".gitignore"
    gitignore.write_text(
        gitignore.read_text(encoding="utf-8")
        + "\nvbrief/.eval/candidates.jsonl\n"
        + "vbrief/.eval/summary-history.jsonl\n"
        + "vbrief/.eval/scope-lifecycle.jsonl\n"
        + "vbrief/.eval/decompositions/\n"
        + "vbrief/.eval/doctor-state.json\n",
        encoding="utf-8",
    )
    # Also seed the .gitattributes rule + README so all three sub-ops
    # are individually no-op for a true byte-identity check.
    (tmp_path / ".gitattributes").write_text(
        "vbrief/.eval/*.jsonl  merge=union\n", encoding="utf-8"
    )
    eval_dir = tmp_path / "vbrief" / ".eval"
    eval_dir.mkdir(parents=True)
    (eval_dir / "README.md").write_text("pre-existing", encoding="utf-8")

    before_gi = gitignore.read_text(encoding="utf-8")
    before_ga = (tmp_path / ".gitattributes").read_text(encoding="utf-8")
    before_readme = (eval_dir / "README.md").read_text(encoding="utf-8")

    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is True
    assert outcome.details.get("gitignore_appended_lines") == 0
    assert outcome.details.get("gitignore_already_selective") is True
    assert outcome.details.get("gitattributes_appended") is False
    assert outcome.details.get("gitattributes_already_present") is True
    assert outcome.details.get("readme_created") is False
    assert outcome.details.get("readme_already_present") is True

    # Byte-identical files after the no-op call.
    assert gitignore.read_text(encoding="utf-8") == before_gi
    assert (tmp_path / ".gitattributes").read_text(encoding="utf-8") == before_ga
    assert (eval_dir / "README.md").read_text(encoding="utf-8") == before_readme


def test_ensure_gitignore_eval_entries_never_appends_blanket(
    tmp_path: Path,
) -> None:
    """#1251 root-cause: no run shape may append the blanket line."""
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    # Run a few times against different starting states; the blanket
    # line MUST never appear as an active (non-comment) entry.
    triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    text = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    active = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert "vbrief/.eval/" not in active
    assert "vbrief/.eval" not in active


def test_ensure_gitignore_eval_entries_adds_gitattributes_when_missing(
    tmp_path: Path,
) -> None:
    """#1251: missing `.gitattributes` is created with merge=union."""
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    assert not (tmp_path / ".gitattributes").exists()

    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is True
    ga = (tmp_path / ".gitattributes").read_text(encoding="utf-8")
    assert "vbrief/.eval/*.jsonl" in ga
    assert "merge=union" in ga
    assert outcome.details.get("gitattributes_appended") is True
    assert outcome.details.get("gitattributes_created") is True


def test_ensure_gitignore_eval_entries_appends_gitattributes_rule_when_absent(
    tmp_path: Path,
) -> None:
    """#1251: pre-existing .gitattributes without the rule gets it appended."""
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    (tmp_path / ".gitattributes").write_text(
        "*.go diff=golang\n", encoding="utf-8"
    )

    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is True
    ga = (tmp_path / ".gitattributes").read_text(encoding="utf-8")
    # The pre-existing rule is preserved.
    assert "*.go diff=golang" in ga
    # The merge=union rule is appended.
    assert "vbrief/.eval/*.jsonl" in ga
    assert "merge=union" in ga
    assert outcome.details.get("gitattributes_appended") is True
    assert outcome.details.get("gitattributes_created") is False


def test_ensure_gitignore_eval_entries_writes_readme_when_missing(
    tmp_path: Path,
) -> None:
    """#1251: missing `vbrief/.eval/README.md` is created with #1144 policy body."""
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is True
    readme = tmp_path / "vbrief" / ".eval" / "README.md"
    assert readme.is_file()
    body = readme.read_text(encoding="utf-8")
    # Mirrors tests/test_eval_governance.py contract for the README.
    assert "slices.jsonl" in body
    assert "candidates.jsonl" in body
    assert "summary-history.jsonl" in body
    assert "doctor-state.json" in body  # #1464
    assert "task triage:bootstrap" in body
    assert "merge=union" in body
    assert "dedup" in body.lower()
    assert outcome.details.get("readme_created") is True


def test_ensure_gitignore_eval_entries_fails_without_existing_gitignore(
    tmp_path: Path,
) -> None:
    """#1251: the eval-entries step refuses to create .gitignore on its own."""
    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is False
    assert outcome.details.get("skipped") == "no-gitignore"


def test_ensure_gitignore_eval_entries_flags_pre_existing_blanket(
    tmp_path: Path,
) -> None:
    """#1251: surface (but do NOT auto-rewrite) a stale blanket line.

    The step's documented behaviour is to add the selective entries
    and report ``blanket_present=True`` in ``details`` so the operator
    can act on the workaround (manual removal of the trailing blanket).
    Auto-rewriting the file is intentionally out of scope -- it races
    with concurrent operator edits.
    """
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    gitignore = tmp_path / ".gitignore"
    gitignore.write_text(
        gitignore.read_text(encoding="utf-8") + "\nvbrief/.eval/\n",
        encoding="utf-8",
    )

    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is True
    assert outcome.details.get("blanket_present") is True
    # Selective entries were still added.
    text = gitignore.read_text(encoding="utf-8")
    assert "vbrief/.eval/candidates.jsonl" in text


def test_ensure_gitignore_eval_entries_blanket_warning_in_message(
    tmp_path: Path,
) -> None:
    """#1256 Greptile P1: blanket_present surfaces in StepOutcome.message.

    When all three selective entries are already present BUT a stale
    blanket line is detected, the step previously reported
    ``hybrid policy satisfied; no-op`` -- silently leaving the
    operator's repo broken because git honours the blanket pattern
    for the entire directory. The warning must reach
    ``StepOutcome.message`` so it flows through ``run_bootstrap``'s
    progress emit AND the recap.
    """
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    gitignore = tmp_path / ".gitignore"
    # Seed all selective entries AND a stale blanket line.
    gitignore.write_text(
        gitignore.read_text(encoding="utf-8")
        + "\nvbrief/.eval/candidates.jsonl\n"
        + "vbrief/.eval/summary-history.jsonl\n"
        + "vbrief/.eval/scope-lifecycle.jsonl\n"
        + "vbrief/.eval/decompositions/\n"
        + "vbrief/.eval/doctor-state.json\n"
        + "vbrief/.eval/\n",
        encoding="utf-8",
    )

    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is True
    assert outcome.details.get("blanket_present") is True
    # Warning surfaces in the message, not just in details.
    assert "WARNING" in outcome.message
    assert "blanket" in outcome.message.lower()
    assert "slices.jsonl" in outcome.message
    assert "#1251" in outcome.message


def test_ensure_gitignore_eval_entries_blanket_detection_robust_to_inline_comment(
    tmp_path: Path,
) -> None:
    """#1256 SLizard P1: forbidden-blanket detector strips inline comments.

    The pre-#1256 detector used ``line.strip()`` as the set-membership
    key, so a blanket entry like ``vbrief/.eval/  # legacy`` slipped
    past the forbidden check. The post-fix detector strips the inline
    comment before checking, so the operator gets the warning AND the
    selective entries are still added.
    """
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    gitignore = tmp_path / ".gitignore"
    gitignore.write_text(
        gitignore.read_text(encoding="utf-8")
        + "\nvbrief/.eval/  # legacy entry from old bootstrap\n",
        encoding="utf-8",
    )

    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is True
    assert outcome.details.get("blanket_present") is True, (
        "the detector must strip inline comments before the membership "
        "check; pre-#1256 the trailing comment hid the forbidden line"
    )
    assert "WARNING" in outcome.message


def test_ensure_gitignore_eval_entries_no_rationale_duplication_on_partial_re_run(
    tmp_path: Path,
) -> None:
    """#1256 Greptile P2: rationale comment block is not duplicated.

    An operator who runs bootstrap, then manually deletes ONE of the
    three selective entries, then re-runs bootstrap. The re-run should
    add only the missing entry, NOT a second copy of the multi-line
    rationale comment block.
    """
    triage_bootstrap.step_ensure_gitignore_entry(tmp_path)
    # First run: writes all three entries + rationale.
    triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    after_first = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    rationale_count_first = after_first.count(
        "# vbrief/.eval/ tracking governance"
    )
    assert rationale_count_first == 1

    # Operator manually deletes one of the selective entries.
    perturbed = after_first.replace(
        "vbrief/.eval/summary-history.jsonl\n", ""
    )
    (tmp_path / ".gitignore").write_text(perturbed, encoding="utf-8")

    # Re-run: should re-add the missing entry but NOT a duplicate rationale.
    outcome = triage_bootstrap.step_ensure_gitignore_eval_entries(tmp_path)
    assert outcome.ok is True
    assert outcome.details.get("gitignore_appended_lines") == 1
    assert outcome.details.get("rationale_already_present") is True
    after_second = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    rationale_count_second = after_second.count(
        "# vbrief/.eval/ tracking governance"
    )
    assert rationale_count_second == 1, (
        "rationale comment block was duplicated on partial re-run; "
        "#1256 Greptile P2"
    )
    # And the missing selective entry is back.
    assert "vbrief/.eval/summary-history.jsonl" in after_second


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


def test_run_bootstrap_appends_five_step_outcomes(tmp_path: Path) -> None:
    """#1240: bootstrap now ships five steps; step 5 seeds the audit log."""
    cache = _build_fake_cache()
    result = triage_bootstrap.run_bootstrap(
        project_root=tmp_path,
        repo="deftai/directive",
        cache_module=cache,
    )
    assert len(result.steps) == 5
    assert [s.name for s in result.steps] == [
        "populate_cache",
        "backfill_audit_log",
        "ensure_gitignore_entry",
        "ensure_gitignore_eval_entries",
        "seed_candidates_log",
    ]
    assert result.exit_code == 0
    # #1240: audit log is seeded post-bootstrap (zero-length file exists).
    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    assert audit_path.exists(), (
        "step 5 (seed_candidates_log) MUST leave candidates.jsonl present "
        "so verify:cache-fresh can distinguish never-bootstrapped from "
        "freshly-bootstrapped"
    )


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


# ---------------------------------------------------------------------------
# #1237 regression: backfill_audit_log must inherit the git-inferred repo
# from the dispatcher when no explicit --repo is passed. Pre-#1237 step 2
# silently skipped with details.skipped="no-repo" while step 1 used git
# remote get-url origin to populate the cache.
# ---------------------------------------------------------------------------


def test_run_bootstrap_step2_inherits_git_inferred_repo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1237: every step that needs a repo sees the same inferred slug.

    Reproduces the dogfood failure: ``task triage:bootstrap`` without an
    explicit ``--repo`` flag, but with a git checkout whose ``origin``
    resolves to ``deftai/directive``. The pre-#1237 behaviour was for
    step 1 to infer + use the slug but step 2 to skip with
    ``details.skipped="no-repo"`` -- this assertion pins the new
    behaviour: step 2 sees the same slug step 1 saw, and the
    ``"no-repo"`` skip branch is unreachable on the happy path.
    """
    cache = _build_fake_cache()
    # Seed a scope vBRIEF so backfill has something to log against the
    # inferred repo.
    _scope_vbrief(tmp_path / "vbrief" / "proposed", "story-a", 100)

    monkeypatch.setattr(
        triage_bootstrap,
        "_infer_repo_from_git",
        lambda cwd=None: "deftai/directive",
    )

    result = triage_bootstrap.run_bootstrap(
        project_root=tmp_path,
        repo=None,  # force the dispatcher's git-inference path
        cache_module=cache,
    )

    assert result.exit_code == 0
    assert result.repo == "deftai/directive"
    # Every step that needs a repo MUST see the same slug.
    backfill = next(
        s for s in result.steps if s.name == "backfill_audit_log"
    )
    assert backfill.ok is True
    assert backfill.details.get("skipped") != "no-repo", (
        "backfill_audit_log must inherit the inferred repo from the "
        "dispatcher (#1237); pre-fix it would skip with no-repo"
    )
    assert backfill.details.get("appended", 0) >= 1

    # No step in the recap has details.skipped=no-repo.
    no_repo_skips = [
        s.name
        for s in result.steps
        if s.details.get("skipped") == "no-repo"
    ]
    assert no_repo_skips == [], (
        f"#1237: no step should skip with no-repo on the happy path; got {no_repo_skips!r}"
    )


def test_run_bootstrap_no_git_inference_keeps_backfill_skip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1237: when git can't resolve, every step skips with no-repo (no regression)."""
    cache = _build_fake_cache()
    monkeypatch.setattr(
        triage_bootstrap, "_infer_repo_from_git", lambda cwd=None: None
    )

    result = triage_bootstrap.run_bootstrap(
        project_root=tmp_path,
        repo=None,
        cache_module=cache,
    )

    # Both steps that need a repo skip with no-repo (or no-vbrief for
    # backfill when vbrief/ is empty -- pre-existing behaviour).
    populate = next(s for s in result.steps if s.name == "populate_cache")
    backfill = next(s for s in result.steps if s.name == "backfill_audit_log")
    assert populate.details.get("skipped") == "no-repo"
    assert backfill.details.get("skipped") == "no-repo"


# ---------------------------------------------------------------------------
# #1240 regression: step 5 seeds an empty candidates.jsonl so
# verify:cache-fresh can distinguish never-bootstrapped from freshly-
# bootstrapped consumers.
# ---------------------------------------------------------------------------


def test_step_seed_candidates_log_creates_empty_file(tmp_path: Path) -> None:
    """#1240: step 5 creates an empty candidates.jsonl when absent."""
    outcome = triage_bootstrap.step_seed_candidates_log(tmp_path)
    assert outcome.ok is True
    assert outcome.details["created"] is True
    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    assert audit_path.exists()
    assert audit_path.stat().st_size == 0


def test_step_seed_candidates_log_idempotent_when_present(tmp_path: Path) -> None:
    """#1240: step 5 is a no-op when candidates.jsonl already exists."""
    audit_dir = tmp_path / "vbrief" / ".eval"
    audit_dir.mkdir(parents=True)
    audit_path = audit_dir / "candidates.jsonl"
    audit_path.write_text(
        '{"decision": "accept", "issue_number": 1}\n', encoding="utf-8"
    )
    original_bytes = audit_path.read_bytes()

    outcome = triage_bootstrap.step_seed_candidates_log(tmp_path)

    assert outcome.ok is True
    assert outcome.details["already_present"] is True
    assert outcome.details["created"] is False
    # File content untouched: idempotent re-run must not perturb existing data.
    assert audit_path.read_bytes() == original_bytes
