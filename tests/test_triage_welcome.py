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
    assert 3 in outcome.phases_run
    assert 4 in outcome.phases_run
    assert 5 in outcome.phases_skipped  # WIP 0 <= cap 10
    assert 6 in outcome.phases_run
    # Subscription + cap landed on PROJECT-DEFINITION.
    data = json.loads(
        (tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )
    assert data["plan"]["policy"]["triageScope"] == triage_welcome.SUBSCRIPTION_PRESETS[
        "mid"
    ]
    assert data["plan"]["policy"]["wipCap"] == 10


def test_partial_install_skips_completed_phases(tmp_path: Path) -> None:
    """Pre-set scope + cap + cache => phases 2/3/4 all skipped on re-run."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=10,
    )
    _seed_cache_entry(tmp_path, "deftai", "directive", 1)
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


def test_wip_exceeds_cap_offers_relief_dry_run_first(tmp_path: Path) -> None:
    """When pending+active > cap, Phase 5 previews relief and asks to confirm."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
        wip_cap=2,
    )
    _seed_cache_entry(tmp_path, "deftai", "directive", 42)
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
    # Phase 4 actually wrote wipCap this time (P1 #2 regression guard).
    assert outcome.wip_cap_choice == 10
    # Phase 2 was visited (Back forced the re-prompt), Phase 4 ran, Phase 6 ran.
    assert 2 in outcome.phases_run
    assert 4 in outcome.phases_run
    assert 6 in outcome.phases_run
    # Operator-visible Back-rewind line was emitted.
    assert "[back] Rewinding to Phase 2" in joined
    # Persisted state: subscription changed mid (orig) -> small (post-Back),
    # wipCap=10 set.
    data = json.loads(
        (tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )
    assert (
        data["plan"]["policy"]["triageScope"]
        == triage_welcome.SUBSCRIPTION_PRESETS["small"]
    )
    assert data["plan"]["policy"]["wipCap"] == 10


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
    # Cache empty so Phase 3 actually runs.
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
    # All phases are skipped via state detection -> no input needed.
    monkeypatch.setattr("builtins.input", lambda _prompt="": "")
    rc = triage_welcome.main(
        ["--project-root", str(tmp_path), "--no-subprocess"]
    )
    assert rc == 0
