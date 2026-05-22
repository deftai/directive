"""Tests for ``scripts/triage_welcome.py`` (N3 / #1143).

Covers the 6-phase ritual end-to-end with stubbed IO and the
``run_subprocess=False`` test-mode flag so no real ``task <verb>``
hops fire. Suites:

* Phase 1 detection (cache + scope + wipCap + WIP probes).
* Phase 2 subscription write (typed-flag pattern + audit-log entry).
* Phase 4 wipCap write (typed flag + custom + bad value rejection).
* Phase 5 WIP-relief preview + opt-in confirmation.
* End-to-end clean install (all 6 phases run).
* End-to-end partial install (Phase 2 / 4 / 5 skipped via detection).
* Discuss / Back early-exit handling.
* CLI exit code on missing project root.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

# Make ``scripts/`` importable when running ``pytest tests/``.
_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

import triage_welcome  # noqa: E402,I001  -- after sys.path tweak above


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_project_definition(
    root: Path,
    *,
    triage_scope: list[dict[str, Any]] | None = None,
    wip_cap: int | None = None,
) -> Path:
    """Write a minimal PROJECT-DEFINITION.vbrief.json to ``root``."""
    path = root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    policy: dict[str, Any] = {}
    if triage_scope is not None:
        policy["triageScope"] = triage_scope
    if wip_cap is not None:
        policy["wipCap"] = wip_cap
    payload: dict[str, Any] = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {"narratives": {}, "policy": policy} if policy else {"narratives": {}},
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def _seed_cache_entry(root: Path, owner: str, repo: str, issue: int) -> Path:
    """Create a synthetic ``.deft-cache/<source>/<owner>/<repo>/<N>/`` entry."""
    path = (
        root
        / triage_welcome.CACHE_DIR_NAME
        / triage_welcome.CACHE_SOURCE
        / owner
        / repo
        / str(issue)
    )
    path.mkdir(parents=True, exist_ok=True)
    (path / "raw.json").write_text("{}", encoding="utf-8")
    return path


def _seed_candidates_log(root: Path) -> Path:
    """Create a zero-length ``vbrief/.eval/candidates.jsonl`` audit log (#1244).

    Mirrors :func:`scripts.triage_bootstrap.step_seed_candidates_log`: the
    file's presence (not its contents) is the canonical "bootstrap
    finished" signal welcome's Phase 3 keys off.
    """
    path = root.joinpath(*triage_welcome.CANDIDATES_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    return path


def _seed_vbrief(root: Path, folder: str, slug: str, *, age_days: int = 0) -> Path:
    """Create a synthetic vBRIEF file in ``vbrief/<folder>/``."""
    d = root / "vbrief" / folder
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{slug}.vbrief.json"
    stamp = (datetime.now(UTC) - timedelta(days=age_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {"narratives": {}, "updated": stamp},
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class _ScriptedInput:
    """Replays a queue of responses for the script's ``input_fn``."""

    def __init__(self, responses: list[str]) -> None:
        self._iter: Iterator[str] = iter(responses)

    def __call__(self, _prompt: str) -> str:
        try:
            return next(self._iter)
        except StopIteration:  # pragma: no cover -- test bug guard
            raise EOFError from None


class _CapturedOutput:
    """Captures ``output_fn`` calls so tests can assert on emitted lines."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def __call__(self, line: str = "") -> None:
        self.lines.append(line)

    def joined(self) -> str:
        return "\n".join(self.lines)


# ---------------------------------------------------------------------------
# Phase 1 -- detection
# ---------------------------------------------------------------------------


def test_detect_prior_state_empty_project(tmp_path: Path) -> None:
    state = triage_welcome.detect_prior_state(tmp_path)
    assert state.triage_scope_set is False
    assert state.cache_empty is True
    assert state.cache_entry_count == 0
    assert state.wip_cap_set is False
    assert state.wip_cap == triage_welcome.DEFAULT_WIP_CAP
    assert state.wip_count == 0
    assert state.audit_log_present is False


def test_detect_prior_state_audit_log_present(tmp_path: Path) -> None:
    """#1244: PriorState surfaces candidates.jsonl independent of cache state."""
    _seed_candidates_log(tmp_path)
    state = triage_welcome.detect_prior_state(tmp_path)
    assert state.audit_log_present is True
    # Cache stays empty -- audit log is a separate, canonical signal.
    assert state.cache_empty is True


def test_detect_prior_state_populated(tmp_path: Path) -> None:
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["mid"],
        wip_cap=15,
    )
    _seed_cache_entry(tmp_path, "deftai", "directive", 1119)
    _seed_cache_entry(tmp_path, "deftai", "directive", 1143)
    _seed_vbrief(tmp_path, "pending", "2026-05-18-foo")
    _seed_vbrief(tmp_path, "active", "2026-05-18-bar")

    state = triage_welcome.detect_prior_state(tmp_path)
    assert state.triage_scope_set is True
    assert state.triage_scope_summary.startswith("Mid")
    assert state.cache_empty is False
    assert state.cache_entry_count == 2
    assert state.wip_cap_set is True
    assert state.wip_cap == 15
    assert state.wip_count == 2


def test_detect_prior_state_default_wip_cap_is_10(tmp_path: Path) -> None:
    # Default per umbrella #1119 Current Shape v3.
    state = triage_welcome.detect_prior_state(tmp_path)
    assert state.wip_cap == 10


# ---------------------------------------------------------------------------
# Phase 2 -- subscription write
# ---------------------------------------------------------------------------


def test_write_triage_scope_persists_typed_array(tmp_path: Path) -> None:
    _seed_project_definition(tmp_path)
    rules = triage_welcome.SUBSCRIPTION_PRESETS["small"]
    changed, audit = triage_welcome.write_triage_scope(
        tmp_path, rules, preset_label="small"
    )
    assert changed is True
    data = json.loads(
        (tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )
    assert data["plan"]["policy"]["triageScope"] == rules
    log = (tmp_path / triage_welcome.AUDIT_LOG_REL_PATH).read_text(encoding="utf-8")
    assert "actor=triage-welcome" in audit
    assert "preset=small" in log
    assert "field=plan.policy.triageScope" in log


def test_write_triage_scope_rejects_invalid_schema(tmp_path: Path) -> None:
    _seed_project_definition(tmp_path)
    bad_rules = [{"rule": "milestone"}]  # rejected with pointer to #1181
    with pytest.raises(ValueError) as exc:
        triage_welcome.write_triage_scope(tmp_path, bad_rules, preset_label="bad")
    assert "schema errors" in str(exc.value)


def test_write_triage_scope_missing_project_definition_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        triage_welcome.write_triage_scope(
            tmp_path, [{"rule": "all-open"}], preset_label="small"
        )


# ---------------------------------------------------------------------------
# Phase 4 -- wipCap write
# ---------------------------------------------------------------------------


def test_write_wip_cap_persists_value(tmp_path: Path) -> None:
    _seed_project_definition(tmp_path)
    changed, audit = triage_welcome.write_wip_cap(tmp_path, 8)
    assert changed is True
    data = json.loads(
        (tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )
    assert data["plan"]["policy"]["wipCap"] == 8
    assert "value=8" in audit


def test_write_wip_cap_rejects_zero_or_negative(tmp_path: Path) -> None:
    _seed_project_definition(tmp_path)
    with pytest.raises(ValueError):
        triage_welcome.write_wip_cap(tmp_path, 0)
    with pytest.raises(ValueError):
        triage_welcome.write_wip_cap(tmp_path, -5)


def test_write_wip_cap_rejects_bool(tmp_path: Path) -> None:
    _seed_project_definition(tmp_path)
    with pytest.raises(ValueError):
        triage_welcome.write_wip_cap(tmp_path, True)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Phase 5 -- relief preview
# ---------------------------------------------------------------------------


def test_preview_wip_relief_classifies_by_age(tmp_path: Path) -> None:
    _seed_vbrief(tmp_path, "pending", "2026-05-18-young", age_days=5)
    _seed_vbrief(tmp_path, "pending", "2026-03-01-old", age_days=60)
    _seed_vbrief(tmp_path, "pending", "2026-04-15-medium", age_days=29)
    preview = triage_welcome.preview_wip_relief(tmp_path, older_than_days=30)
    assert preview.older_than_days == 30
    assert preview.eligible_count == 1
    assert "2026-03-01-old.vbrief.json" in preview.eligible_files
    assert preview.skipped_count == 2


def test_preview_wip_relief_missing_pending_returns_empty(tmp_path: Path) -> None:
    preview = triage_welcome.preview_wip_relief(tmp_path)
    assert preview.eligible_count == 0
    assert preview.eligible_files == ()
    assert preview.skipped_count == 0


# ---------------------------------------------------------------------------
# End-to-end run_welcome
# ---------------------------------------------------------------------------


def test_clean_install_runs_all_phases(tmp_path: Path) -> None:
    """Fresh consumer: defaults accepted, no WIP, all writes succeed."""
    _seed_project_definition(tmp_path)
    inputs = _ScriptedInput(
        [
            "",  # Phase 2 menu: accept default (Mid)
            "",  # Phase 4 menu: accept default (10)
            # Phase 5 is skipped (WIP <= cap), Phase 6 has no prompt.
        ]
    )
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=inputs,
        output_fn=output,
        run_subprocess=False,
    )
    assert outcome.exit_code == 0
    assert outcome.subscription_choice == "mid"
    assert outcome.wip_cap_choice == 10
    assert outcome.discussed_at_phase is None
    assert 1 in outcome.phases_run
    assert 2 in outcome.phases_run
    # #1244: Phase 3 skipped in dry-mode (candidates.jsonl absent).
    assert 3 in outcome.phases_skipped
    assert (
        outcome.bootstrap_action
        == triage_welcome.BOOTSTRAP_ACTION_SKIPPED_DRY_MODE
    )
    assert 4 in outcome.phases_run
    assert 5 in outcome.phases_skipped  # WIP 0 <= cap 10
    assert 6 in outcome.phases_run
    # Subscription landed; #1250: wipCap MUST remain unset when the
    # operator accepts the framework default on a fresh consumer
    # (per #1186 Deliverable 1 -- the field is omitted, consumers
    # inherit the default).
    data = json.loads(
        (tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )
    assert data["plan"]["policy"]["triageScope"] == triage_welcome.SUBSCRIPTION_PRESETS[
        "mid"
    ]
    assert "wipCap" not in data["plan"]["policy"], (
        "plan.policy.wipCap must remain unset when the operator accepts "
        "the framework default 10 on a fresh consumer (#1250 / #1186 "
        "Deliverable 1)."
    )
    # And the no-op MUST NOT append a row to meta/policy-changes.log
    # for the wipCap default-confirm -- only the triageScope write does.
    audit_log = (tmp_path / triage_welcome.AUDIT_LOG_REL_PATH).read_text(
        encoding="utf-8"
    )
    assert "field=plan.policy.wipCap" not in audit_log, (
        "#1250: default-confirm wipCap must not write a policy-changes.log row"
    )
    joined = output.joined()
    assert "Wrote plan.policy.wipCap = 10" not in joined, (
        "#1250: default-confirm wipCap must not claim a write happened"
    )
    assert (
        "plan.policy.wipCap = 10 "
        "(framework default; field not materialized)"
    ) in joined


def test_partial_install_skips_completed_phases(tmp_path: Path) -> None:
    """Pre-set scope + cap + cache + audit log => phases 2/3/4 all skipped."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    _seed_cache_entry(tmp_path, "deftai", "directive", 1)
    # #1244: audit log presence is the canonical "bootstrap finished" signal.
    _seed_candidates_log(tmp_path)
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=_ScriptedInput([]),  # No prompts -- all skipped
        output_fn=output,
        run_subprocess=False,
    )
    assert outcome.exit_code == 0
    assert outcome.phases_run == [1, 6]
    assert outcome.phases_skipped == [2, 3, 4, 5]
    assert outcome.subscription_choice is None
    assert outcome.wip_cap_choice is None
    assert (
        outcome.bootstrap_action
        == triage_welcome.BOOTSTRAP_ACTION_SKIPPED_ALREADY_BOOTSTRAPPED
    )


def test_wip_exceeds_cap_offers_relief_dry_run_first(tmp_path: Path) -> None:
    """When pending+active > cap, Phase 5 previews relief and asks to confirm."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=2,
    )
    _seed_cache_entry(tmp_path, "deftai", "directive", 42)
    _seed_candidates_log(tmp_path)  # #1244: skip Phase 3 cleanly
    # WIP=3 (1 pending old + 2 active) > cap=2
    _seed_vbrief(tmp_path, "pending", "2026-03-01-old", age_days=60)
    _seed_vbrief(tmp_path, "active", "2026-05-18-foo")
    _seed_vbrief(tmp_path, "active", "2026-05-18-bar")
    inputs = _ScriptedInput(["n"])  # decline the relief confirmation
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=inputs,
        output_fn=output,
        run_subprocess=False,
    )
    assert outcome.exit_code == 0
    assert outcome.relief_offered is True
    assert outcome.relief_confirmed is False
    # Preview must have been emitted with the dry-run command text.
    joined = output.joined()
    assert "task scope:demote -- --batch --older-than-days 30" in joined
    assert "2026-03-01-old.vbrief.json" in joined
    assert "Relief declined" in joined


def test_wip_exceeds_cap_relief_confirmed(tmp_path: Path) -> None:
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=1,
    )
    _seed_cache_entry(tmp_path, "deftai", "directive", 99)
    _seed_candidates_log(tmp_path)  # #1244: skip Phase 3 cleanly
    _seed_vbrief(tmp_path, "pending", "2026-03-01-old", age_days=60)
    _seed_vbrief(tmp_path, "active", "2026-05-18-a")
    _seed_vbrief(tmp_path, "active", "2026-05-18-b")
    inputs = _ScriptedInput(["y"])
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=inputs,
        output_fn=output,
        run_subprocess=False,  # suppress real scope:demote
    )
    assert outcome.exit_code == 0
    assert outcome.relief_offered is True
    assert outcome.relief_confirmed is True
    assert "scope:demote subprocess suppressed" in output.joined()


def test_discuss_at_phase_2_exits_cleanly(tmp_path: Path) -> None:
    _seed_project_definition(tmp_path)
    # 5 options total in Phase 2 menu (3 presets + Discuss + Back); Discuss = 4
    inputs = _ScriptedInput(["4"])
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=inputs,
        output_fn=output,
        run_subprocess=False,
    )
    assert outcome.exit_code == 0
    assert outcome.discussed_at_phase == 2
    assert "[discuss] Pausing the ritual" in output.joined()


def test_custom_wip_cap_path(tmp_path: Path) -> None:
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
    )
    # Phase 4 menu options: 8/10/15/custom + Discuss + Back.
    # 4 = custom; follow-up prompt accepts an int.
    inputs = _ScriptedInput(["4", "20"])
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=inputs,
        output_fn=output,
        run_subprocess=False,
    )
    assert outcome.exit_code == 0
    assert outcome.wip_cap_choice == 20
    data = json.loads(
        (tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )
    assert data["plan"]["policy"]["wipCap"] == 20


def test_subscription_menu_invalid_then_valid(tmp_path: Path) -> None:
    """Invalid input re-renders the menu without aborting the ritual."""
    _seed_project_definition(tmp_path)
    # First input is an unrecognized token; second is the explicit Small (1).
    inputs = _ScriptedInput(["foo", "1", ""])  # third for wipCap default
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=inputs,
        output_fn=output,
        run_subprocess=False,
    )
    assert outcome.exit_code == 0
    assert outcome.subscription_choice == "small"
    assert "Invalid selection" in output.joined()


# ---------------------------------------------------------------------------
# P1 fix regressions (post-review)
# ---------------------------------------------------------------------------


def test_back_at_phase_4_rewinds_to_phase_2_and_completes(tmp_path: Path) -> None:
    """P1 #2: Back at the wipCap menu MUST re-render Phase 2, NOT silently exit.

    Reproduction: subscription set on disk (Phase 2 would skip), wipCap unset.
    Inputs: Phase 4 menu -> Back (option 5) -> rewinds to Phase 2 -> pick
    Small (1) -> Phase 4 menu -> default (Mid skipped semantics overridden);
    accept default 10 wipCap. The pre-fix code returned early at the Back
    handler with `exit_code=0` and `wip_cap_choice=None` -- a silent exit
    the dispatcher couldn't distinguish from a clean run.
    """
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["mid"],
    )
    inputs = _ScriptedInput(
        [
            "6",  # Phase 4 menu (8/10/15/custom/Discuss/Back) -> Back (=6)
            "1",  # Phase 2 forced re-prompt -> Small
            "",   # Phase 4 menu -> accept default (10)
        ]
    )
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=inputs,
        output_fn=output,
        run_subprocess=False,
    )
    joined = output.joined()
    assert outcome.exit_code == 0
    # Phase 4 visited and the operator picked the default (P1 #2 regression guard).
    assert outcome.wip_cap_choice == 10
    # Phase 2 was visited (Back forced the re-prompt), Phase 4 ran, Phase 6 ran.
    assert 2 in outcome.phases_run
    assert 4 in outcome.phases_run
    assert 6 in outcome.phases_run
    # Operator-visible Back-rewind line was emitted.
    assert "[back] Rewinding to Phase 2" in joined
    # Persisted state: subscription changed mid (orig) -> small (post-Back).
    # #1250: wipCap MUST remain unset because the operator picked the
    # framework default on a previously-unset consumer.
    data = json.loads(
        (tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )
    assert (
        data["plan"]["policy"]["triageScope"]
        == triage_welcome.SUBSCRIPTION_PRESETS["small"]
    )
    assert "wipCap" not in data["plan"]["policy"], (
        "#1250: default-confirm at Phase 4 must not materialize wipCap"
    )


def test_back_at_phase_2_rewinds_to_phase_1_without_recursion(
    tmp_path: Path,
) -> None:
    """P1 #2 / P2: Back at Phase 2 must iterate the loop, not recurse.

    Pre-fix the Back handler at Phase 2 called ``run_welcome()`` recursively
    (unbounded recursion footgun). Post-fix it sets ``phase = 1`` and the
    while-True loop iterates; the second Phase 2 entry sees the same
    subscription menu (no recursion + no double-entry into phases_run lists).
    """
    _seed_project_definition(tmp_path)
    # 5 = Back (3 presets + Discuss + Back), then 1 = Small (next iteration).
    inputs = _ScriptedInput(["5", "1", ""])  # third for wipCap default
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=inputs,
        output_fn=output,
        run_subprocess=False,
    )
    assert outcome.exit_code == 0
    assert outcome.subscription_choice == "small"
    # No duplicate phase entries -- phases_run / phases_skipped are deduped
    # by the loop's tracking sets, so a Back-and-resubmit does not
    # double-count.
    assert outcome.phases_run.count(1) == 1
    assert outcome.phases_run.count(2) == 1
    assert (
        "[back] Nothing earlier to return to; re-rendering Phase 1"
        in output.joined()
    )


def test_phase_3_bootstrap_failure_propagates_exit_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SLizard P1: a non-zero ``task triage:bootstrap`` MUST set exit_code.

    Pre-fix the bootstrap failure only warned to stderr and the ritual
    continued with `outcome.exit_code = 0`, making the dispatcher unable
    to distinguish a clean run from a downstream failure.
    """
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    # Cache empty + audit log absent so Phase 3 actually runs (#1244).
    monkeypatch.setattr(triage_welcome, "_run_task", lambda *a, **kw: 17)
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=_ScriptedInput([]),
        output_fn=output,
        run_subprocess=True,  # exercise the subprocess path
    )
    assert outcome.exit_code == 2
    assert "`task triage:bootstrap` exited 17" in output.joined()
    assert outcome.bootstrap_action == triage_welcome.BOOTSTRAP_ACTION_RAN


def test_phase_5_scope_demote_failure_propagates_exit_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SLizard P1: a non-zero ``task scope:demote`` MUST set exit_code.

    Configure WIP over the cap, confirm relief, and stub `_run_task` to
    return a non-zero code; assert outcome.exit_code == 2.
    """
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=1,
    )
    _seed_cache_entry(tmp_path, "deftai", "directive", 42)
    # #1244: seed audit log so Phase 3 cleanly skips; we want to isolate
    # the Phase 5 scope:demote failure surface.
    _seed_candidates_log(tmp_path)
    _seed_vbrief(tmp_path, "pending", "2026-03-01-old", age_days=60)
    _seed_vbrief(tmp_path, "active", "2026-05-18-a")
    _seed_vbrief(tmp_path, "active", "2026-05-18-b")
    monkeypatch.setattr(triage_welcome, "_run_task", lambda *a, **kw: 7)
    inputs = _ScriptedInput(["y"])
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=inputs,
        output_fn=output,
        run_subprocess=True,
    )
    assert outcome.exit_code == 2
    assert outcome.relief_confirmed is True
    assert "`task scope:demote` exited 7" in output.joined()


def test_write_triage_scope_propagates_non_import_errors_from_validator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """P1 #1: only ImportError is suppressed; real bugs propagate.

    Pre-fix the lazy import was wrapped in ``except Exception``, which
    silently swallowed any RuntimeError / NameError raised by a broken
    ``triage_scope`` module and dropped the schema check. Post-fix only
    ImportError is suppressed -- a RuntimeError raised on attribute
    access via the from-import path MUST propagate to the caller.
    Note: AttributeError specifically gets wrapped to ImportError by
    CPython's IMPORT_FROM opcode, so this test uses RuntimeError (which
    bypasses the wrapping) to exercise the non-ImportError path.
    """
    _seed_project_definition(tmp_path)

    # Inject a poisoned ``triage_scope`` module whose attribute access
    # raises a NON-AttributeError exception. CPython does NOT wrap
    # RuntimeError as ImportError, so the bug surfaces verbatim.
    class _Poisoned:
        def __getattribute__(self, name: str) -> Any:
            raise RuntimeError(
                f"intentional test poison on attribute {name!r}"
            )

    monkeypatch.setitem(sys.modules, "triage_scope", _Poisoned())
    # The narrowed `except ImportError` must NOT swallow this RuntimeError.
    with pytest.raises(RuntimeError, match="intentional test poison"):
        triage_welcome.write_triage_scope(
            tmp_path,
            triage_welcome.SUBSCRIPTION_PRESETS["small"],
            preset_label="small",
        )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def test_main_returns_2_when_project_root_missing(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    rc = triage_welcome.main(["--project-root", str(missing)])
    assert rc == 2


def test_main_runs_no_subprocess_mode(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """End-to-end argparse path through ``main`` with --no-subprocess."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    _seed_cache_entry(tmp_path, "deftai", "directive", 1)
    # #1244: seed audit log so Phase 3 skips cleanly without needing the
    # subprocess hop; otherwise dry-mode would still surface the cache gap.
    _seed_candidates_log(tmp_path)
    # All phases are skipped via state detection -> no input needed.
    monkeypatch.setattr("builtins.input", lambda _prompt="": "")
    rc = triage_welcome.main(
        ["--project-root", str(tmp_path), "--no-subprocess"]
    )
    assert rc == 0


# ---------------------------------------------------------------------------
# #1244 -- Phase 3 candidates.jsonl-aware bootstrap-skip semantics
# ---------------------------------------------------------------------------


def test_bootstrap_runs_when_audit_log_absent_even_with_cache_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1244 (a): the non-interactive bootstrap path MUST run even when
    ``.deft-cache/`` has raw entries -- so long as ``candidates.jsonl``
    is absent. This is the exact failure mode in the bug report
    reproduction: a partially-populated cache from a prior run made
    Phase 3 skip bootstrap while ``candidates.jsonl`` (the downstream
    contract) remained absent.
    """
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    # Raw cache present (1 issue) but audit log ABSENT -- the bug-report
    # repro state. Pre-#1244 the welcome ritual skipped Phase 3 here.
    _seed_cache_entry(tmp_path, "deftai", "directive", 7)
    invocations: list[list[str]] = []

    def _stub_run_task(args: list[str], *, cwd: Path) -> int:
        invocations.append(list(args))
        # Simulate a real bootstrap by seeding the audit log so Phase 6's
        # summary call (also routed through _run_task) sees fresh state.
        if args == ["triage:bootstrap"]:
            _seed_candidates_log(tmp_path)
        return 0

    monkeypatch.setattr(triage_welcome, "_run_task", _stub_run_task)
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=_ScriptedInput([]),
        output_fn=output,
        run_subprocess=True,
    )
    assert outcome.exit_code == 0
    assert outcome.bootstrap_action == triage_welcome.BOOTSTRAP_ACTION_RAN
    assert ["triage:bootstrap"] in invocations
    assert 3 in outcome.phases_run
    # Post-condition the bug report demands: the canonical audit log is
    # populated (the test stub seeds it as the subprocess would).
    assert (tmp_path / "vbrief" / ".eval" / "candidates.jsonl").is_file()


def test_skip_bootstrap_emits_visible_audit_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1244 (b): the explicit-decline path skips bootstrap with a clearly
    visible audit message AND records the decline in
    ``meta/policy-changes.log``.
    """
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    # Audit log absent; operator passes --skip-bootstrap (skip_bootstrap=True).
    calls: list[list[str]] = []

    def _record_run_task(args: list[str], *, cwd: Path) -> int:
        calls.append(list(args))
        return 0

    monkeypatch.setattr(triage_welcome, "_run_task", _record_run_task)
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=_ScriptedInput([]),
        output_fn=output,
        run_subprocess=True,
        skip_bootstrap=True,
    )
    assert outcome.exit_code == 0
    assert (
        outcome.bootstrap_action
        == triage_welcome.BOOTSTRAP_ACTION_SKIPPED_DECLINED
    )
    assert 3 in outcome.phases_skipped
    # _run_task was NOT called for bootstrap (only Phase 6's summary).
    assert ["triage:bootstrap"] not in calls
    joined = output.joined()
    # Operator-facing visible audit message surfaces the decline AND
    # explains the cache-impact for downstream verbs.
    assert "explicitly declined" in joined
    assert "--skip-bootstrap" in joined
    assert "vbrief/.eval/candidates.jsonl" in joined
    assert "task triage:queue" in joined
    # Persistent audit entry written to meta/policy-changes.log.
    audit_log = (tmp_path / triage_welcome.AUDIT_LOG_REL_PATH).read_text(
        encoding="utf-8"
    )
    assert "action=bootstrap-declined" in audit_log
    assert "reason=explicit-skip-flag" in audit_log
    assert "actor=triage-welcome" in audit_log


def test_no_subprocess_surfaces_cache_gap_loudly(tmp_path: Path) -> None:
    """#1244: ``--no-subprocess`` MUST loudly surface that
    ``candidates.jsonl`` will remain absent -- the bug report's exact
    failure mode was that dry-mode emitted a soft "suppressed" line that
    let dispatchers mistake the run for a populated cache.
    """
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=_ScriptedInput([]),
        output_fn=output,
        run_subprocess=False,
    )
    assert outcome.exit_code == 0
    assert (
        outcome.bootstrap_action
        == triage_welcome.BOOTSTRAP_ACTION_SKIPPED_DRY_MODE
    )
    assert 3 in outcome.phases_skipped
    joined = output.joined()
    assert "--no-subprocess" in joined
    assert "vbrief/.eval/candidates.jsonl" in joined
    assert "refuse to run" in joined  # downstream-verb warning surfaces


def test_phase_1_readout_surfaces_audit_log_state(tmp_path: Path) -> None:
    """#1244: Phase 1's detection readout MUST include the
    ``candidates.jsonl`` presence so operators see the canonical
    "bootstrap finished" signal alongside the raw cache count.
    """
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    _seed_candidates_log(tmp_path)
    output = _CapturedOutput()
    triage_welcome.run_welcome(
        tmp_path,
        input_fn=_ScriptedInput([]),
        output_fn=output,
        run_subprocess=False,
    )
    joined = output.joined()
    assert "candidates.jsonl: present" in joined
    assert "vbrief/.eval/candidates.jsonl" in joined


def test_cli_skip_bootstrap_flag_threads_through(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1244: the CLI ``--skip-bootstrap`` flag reaches
    :func:`run_welcome` and is honoured.
    """
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    captured: dict[str, object] = {}
    real_run = triage_welcome.run_welcome

    def _spy(*args: object, **kwargs: object) -> object:
        captured.update(kwargs)
        return real_run(*args, **kwargs)

    monkeypatch.setattr(triage_welcome, "run_welcome", _spy)
    monkeypatch.setattr("builtins.input", lambda _prompt="": "")
    rc = triage_welcome.main(
        [
            "--project-root",
            str(tmp_path),
            "--no-subprocess",
            "--onboard",
            "--skip-bootstrap",
        ]
    )
    assert rc == 0
    assert captured.get("skip_bootstrap") is True


# ---------------------------------------------------------------------------
# #1309 -- default-mode summary + nudge surface
# ---------------------------------------------------------------------------


def _seed_oneliner_environment(tmp_path: Path) -> None:
    """Minimum scaffolding so ``triage_summary.compute_summary`` returns cleanly.

    The default-mode emit invokes ``triage_summary.compute_summary``; on a
    completely empty workspace that path still resolves (cache-empty
    headline). Adding a PROJECT-DEFINITION lets us exercise the
    triage_scope_set / wip_cap_set branches independently.
    """
    _seed_project_definition(tmp_path)


def test_classify_onboarding_first_time(tmp_path: Path) -> None:
    """All three signals absent -> ``first-time`` label."""
    state = triage_welcome.detect_prior_state(tmp_path)
    label, missing = triage_welcome._classify_onboarding(state)
    assert label == "first-time"
    assert set(missing) == {"candidates.jsonl", "triageScope", "wipCap"}


def test_classify_onboarding_incomplete(tmp_path: Path) -> None:
    """Audit log present but scope / cap absent -> ``incomplete``."""
    _seed_project_definition(tmp_path)
    _seed_candidates_log(tmp_path)
    state = triage_welcome.detect_prior_state(tmp_path)
    label, missing = triage_welcome._classify_onboarding(state)
    assert label == "incomplete"
    assert "triageScope" in missing
    assert "wipCap" in missing
    assert "candidates.jsonl" not in missing


def test_classify_onboarding_fully_set_up(tmp_path: Path) -> None:
    """All three signals present -> ``fully-set-up`` + empty missing list."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    _seed_candidates_log(tmp_path)
    state = triage_welcome.detect_prior_state(tmp_path)
    label, missing = triage_welcome._classify_onboarding(state)
    assert label == "fully-set-up"
    assert missing == []


def test_run_default_mode_first_time_emits_nudge(tmp_path: Path) -> None:
    """#1309: first-time consumer sees the summary line + first-time nudge."""
    _seed_oneliner_environment(tmp_path)
    output = _CapturedOutput()
    outcome = triage_welcome.run_default_mode(
        tmp_path, output_fn=output, write_history=False
    )
    assert outcome.exit_code == 0
    assert outcome.phases_run == [0]
    joined = output.joined()
    # Summary line always present (cache-empty path is fine for the contract).
    assert "[triage]" in joined
    # First-time nudge follows the summary.
    assert triage_welcome.FIRST_TIME_NUDGE in joined


def test_run_default_mode_incomplete_emits_missing_pieces(tmp_path: Path) -> None:
    """#1309: partial-onboarding consumer sees the templated missing-piece nudge."""
    _seed_project_definition(tmp_path)
    _seed_candidates_log(tmp_path)
    output = _CapturedOutput()
    outcome = triage_welcome.run_default_mode(
        tmp_path, output_fn=output, write_history=False
    )
    assert outcome.exit_code == 0
    joined = output.joined()
    assert "[welcome] Onboarding incomplete:" in joined
    # Stable ordering: missing pieces joined by " + ".
    assert "triageScope + wipCap" in joined
    # First-time wording MUST NOT fire in the incomplete branch.
    assert triage_welcome.FIRST_TIME_NUDGE not in joined


def test_run_default_mode_fully_set_up_is_silent_after_summary(tmp_path: Path) -> None:
    """#1309: a fully-set-up consumer sees only the summary line."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    _seed_candidates_log(tmp_path)
    output = _CapturedOutput()
    outcome = triage_welcome.run_default_mode(
        tmp_path, output_fn=output, write_history=False
    )
    assert outcome.exit_code == 0
    joined = output.joined()
    assert "[triage]" in joined
    assert "[welcome]" not in joined


def test_emit_oneliner_writes_history_when_enabled(tmp_path: Path) -> None:
    """#1309: ``write_history=True`` appends the JSONL sidecar."""
    _seed_oneliner_environment(tmp_path)
    output = _CapturedOutput()
    triage_welcome.emit_oneliner(
        tmp_path, output_fn=output, write_history=True
    )
    history = tmp_path / "vbrief" / ".eval" / "summary-history.jsonl"
    assert history.is_file()
    contents = history.read_text(encoding="utf-8").strip().splitlines()
    assert len(contents) == 1
    assert "\"line\":" in contents[0]


def test_emit_oneliner_skips_history_when_disabled(tmp_path: Path) -> None:
    """#1309: ``write_history=False`` keeps the JSONL sidecar absent."""
    _seed_oneliner_environment(tmp_path)
    output = _CapturedOutput()
    triage_welcome.emit_oneliner(
        tmp_path, output_fn=output, write_history=False
    )
    history = tmp_path / "vbrief" / ".eval" / "summary-history.jsonl"
    assert not history.exists()


def test_main_default_mode_no_flag_routes_to_run_default_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1309: invoking ``triage_welcome.main`` without ``--onboard`` runs the
    non-interactive default-mode surface (not the 6-phase ritual).
    """
    _seed_oneliner_environment(tmp_path)
    invocations: dict[str, int] = {"default": 0, "ritual": 0}
    real_default = triage_welcome.run_default_mode
    real_run_welcome = triage_welcome.run_welcome

    def _spy_default(*args: object, **kwargs: object) -> object:
        invocations["default"] += 1
        return real_default(*args, **kwargs)

    def _spy_ritual(*args: object, **kwargs: object) -> object:
        invocations["ritual"] += 1
        return real_run_welcome(*args, **kwargs)

    monkeypatch.setattr(triage_welcome, "run_default_mode", _spy_default)
    monkeypatch.setattr(triage_welcome, "run_welcome", _spy_ritual)
    monkeypatch.setattr("builtins.input", lambda _prompt="": "")
    rc = triage_welcome.main(
        ["--project-root", str(tmp_path), "--no-history"]
    )
    assert rc == 0
    assert invocations["default"] == 1
    assert invocations["ritual"] == 0


def test_main_onboard_flag_routes_to_run_welcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1309: ``--onboard`` dispatches to the original 6-phase ritual."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    _seed_candidates_log(tmp_path)
    invocations: dict[str, int] = {"default": 0, "ritual": 0}
    real_default = triage_welcome.run_default_mode
    real_run_welcome = triage_welcome.run_welcome

    def _spy_default(*args: object, **kwargs: object) -> object:
        invocations["default"] += 1
        return real_default(*args, **kwargs)

    def _spy_ritual(*args: object, **kwargs: object) -> object:
        invocations["ritual"] += 1
        return real_run_welcome(*args, **kwargs)

    monkeypatch.setattr(triage_welcome, "run_default_mode", _spy_default)
    monkeypatch.setattr(triage_welcome, "run_welcome", _spy_ritual)
    monkeypatch.setattr("builtins.input", lambda _prompt="": "")
    rc = triage_welcome.main(
        ["--project-root", str(tmp_path), "--no-subprocess", "--onboard"]
    )
    assert rc == 0
    assert invocations["default"] == 0
    assert invocations["ritual"] == 1

