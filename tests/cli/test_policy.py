"""Tests for scripts/policy.py (#746).

Covers:
- :func:`resolve_policy` resolution order (env-var bypass, typed flag,
  legacy narrative fallback, default fail-closed).
- :func:`set_policy` writing the typed flag and migrating the legacy
  narrative key in the same pass.
- :func:`append_audit_log` creating ``meta/policy-changes.log``.
- :func:`disclosure_line` phrasing for each resolved state.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "policy.py"


def _load_policy():
    """Load scripts/policy.py in-process so tests don't shell out."""
    spec = importlib.util.spec_from_file_location("policy", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["policy"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def policy_module():
    return _load_policy()


@pytest.fixture()
def project_root(tmp_path: Path) -> Path:
    (tmp_path / "vbrief").mkdir()
    return tmp_path


def _write_project_def(project_root: Path, plan: dict) -> Path:
    path = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {"title": "T", "status": "running", "items": [], **plan},
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_resolve_policy_typed_true(policy_module, project_root, monkeypatch):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": True}})
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is True
    assert result.source == "typed"
    assert result.deprecation_warning is None
    assert result.error is None


def test_resolve_policy_typed_false(policy_module, project_root, monkeypatch):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": False}})
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is False
    assert result.source == "typed"


def test_resolve_policy_typed_invalid_type_fails_closed(policy_module, project_root, monkeypatch):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": "yes"}})
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is False
    assert result.source == "default-fail-closed"
    assert result.error and "must be a boolean" in result.error


def test_resolve_policy_legacy_narrative_true(policy_module, project_root, monkeypatch):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(
        project_root, {"narratives": {"Allow direct commits to master": "true"}}
    )
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is True
    assert result.source == "legacy-narrative"
    assert result.deprecation_warning is not None
    assert "DEPRECATED" in result.deprecation_warning


def test_resolve_policy_legacy_narrative_false_for_other_strings(
    policy_module, project_root, monkeypatch
):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(
        project_root,
        {"narratives": {"Allow direct commits to master": "no, prefer feature branches"}},
    )
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is False
    assert result.source == "legacy-narrative"


def test_resolve_policy_legacy_narrative_inline_colon_form(
    policy_module, project_root, monkeypatch
):
    """The narrative often re-states the key inline (#746 background)."""
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(
        project_root,
        {
            "narratives": {
                "Allow direct commits to master": "Allow direct commits to master: true"
            }
        },
    )
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is True
    assert result.source == "legacy-narrative"


def test_resolve_policy_default_fail_closed_when_missing_project_def(
    policy_module, tmp_path, monkeypatch
):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    result = policy_module.resolve_policy(tmp_path)
    assert result.allow_direct_commits is False
    assert result.source == "default-fail-closed"
    assert result.error and "not found" in result.error


def test_resolve_policy_default_fail_closed_no_policy_no_legacy(
    policy_module, project_root, monkeypatch
):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(project_root, {})
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is False
    assert result.source == "default-fail-closed"
    assert result.error is None


def test_resolve_policy_env_bypass_wins_over_typed(
    policy_module, project_root, monkeypatch
):
    """Env-var bypass is the highest-priority surface."""
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": False}})
    monkeypatch.setenv(policy_module.ENV_BYPASS, "1")
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is True
    assert result.source == "env-bypass"


def test_resolve_policy_env_bypass_truthy_variants(policy_module, project_root, monkeypatch):
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": False}})
    for val in ("1", "true", "TRUE", "yes", "On"):
        monkeypatch.setenv(policy_module.ENV_BYPASS, val)
        result = policy_module.resolve_policy(project_root)
        assert result.allow_direct_commits is True, f"bypass {val!r} should be truthy"
        assert result.source == "env-bypass"


def test_resolve_policy_env_bypass_falsy_does_not_override(
    policy_module, project_root, monkeypatch
):
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": False}})
    monkeypatch.setenv(policy_module.ENV_BYPASS, "0")
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is False
    assert result.source == "typed"


def test_set_policy_writes_typed_flag_and_audit(policy_module, project_root, monkeypatch):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(project_root, {})
    changed, entry = policy_module.set_policy(
        project_root, allow_direct_commits=True, actor="test", note="unit"
    )
    assert changed is True
    assert "actor=test" in entry
    assert "allowDirectCommitsToMaster=true" in entry
    assert "note=unit" in entry

    # Read back via resolve_policy.
    result = policy_module.resolve_policy(project_root)
    assert result.allow_direct_commits is True
    assert result.source == "typed"

    # Audit log appended.
    log = (project_root / "meta" / "policy-changes.log").read_text(encoding="utf-8")
    assert "actor=test" in log
    assert "allowDirectCommitsToMaster=true" in log


def test_set_policy_migrates_legacy_narrative(policy_module, project_root, monkeypatch):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    path = _write_project_def(
        project_root, {"narratives": {"Allow direct commits to master": "true"}}
    )
    policy_module.set_policy(project_root, allow_direct_commits=True, actor="t")
    data = json.loads(path.read_text(encoding="utf-8"))
    assert "Allow direct commits to master" not in data["plan"].get("narratives", {})
    assert data["plan"]["policy"]["allowDirectCommitsToMaster"] is True


def test_set_policy_no_op_does_not_change_value(policy_module, project_root, monkeypatch):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": False}})
    changed, _ = policy_module.set_policy(
        project_root, allow_direct_commits=False, actor="t"
    )
    assert changed is False


def test_set_policy_raises_when_project_def_missing(policy_module, tmp_path):
    with pytest.raises(FileNotFoundError):
        policy_module.set_policy(tmp_path, allow_direct_commits=True, actor="t")


def test_disclosure_line_typed_on(policy_module):
    result = policy_module.PolicyResult(
        allow_direct_commits=False, source="typed", deprecation_warning=None, error=None
    )
    line = policy_module.disclosure_line(result)
    assert "Branch-protection policy is ON" in line
    assert "blocked" in line.lower()


def test_disclosure_line_typed_off(policy_module):
    result = policy_module.PolicyResult(
        allow_direct_commits=True, source="typed", deprecation_warning=None, error=None
    )
    line = policy_module.disclosure_line(result)
    assert "ENABLED" in line
    assert "OFF" in line


def test_disclosure_line_env_bypass(policy_module):
    result = policy_module.PolicyResult(
        allow_direct_commits=True,
        source="env-bypass",
        deprecation_warning=None,
        error=None,
    )
    line = policy_module.disclosure_line(result)
    assert policy_module.ENV_BYPASS in line


def test_main_show_subcommand_smoke(policy_module, project_root, capsys, monkeypatch):
    monkeypatch.delenv(policy_module.ENV_BYPASS, raising=False)
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": False}})
    rc = policy_module.main(["show", "--project-root", str(project_root)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "allowDirectCommitsToMaster=false" in out
    assert "source=typed" in out


def test_main_unknown_subcommand_returns_2(policy_module, capsys):
    rc = policy_module.main(["bogus"])
    assert rc == 2


def test_main_help_returns_0(policy_module, capsys):
    rc = policy_module.main(["--help"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "Usage" in out


def test_audit_log_creates_meta_dir(policy_module, tmp_path):
    """append_audit_log creates meta/ dir on first write (#746 G2)."""
    log_path = policy_module.append_audit_log(tmp_path, "actor=x value=y")
    assert log_path.exists()
    assert log_path.parent.name == "meta"
    content = log_path.read_text(encoding="utf-8")
    assert "actor=x value=y" in content
    # Header on first write.
    assert "audit trail" in content


def test_audit_log_uses_append_mode(policy_module, tmp_path):
    """Multiple append_audit_log calls in sequence preserve every entry.

    Greptile P2 review on PR #777 -- the previous read-modify-write
    pattern raced under parallel writers. Append-mode `open(..., "a")` is
    atomic on standard filesystems and exhibits the same "every entry
    persists" property in a single-threaded test.
    """
    for i in range(5):
        policy_module.append_audit_log(tmp_path, f"entry-{i}")
    log = (tmp_path / "meta" / "policy-changes.log").read_text(encoding="utf-8")
    for i in range(5):
        assert f"entry-{i}" in log
    # Header appears exactly once on the first write.
    assert log.count("audit trail") == 1


# ---------------------------------------------------------------------------
# capacityAllocation typed schema (#1419 Delivery Slice 4)
# ---------------------------------------------------------------------------


def _valid_capacity() -> dict:
    return {
        "unit": "vbrief-count",
        "window": 30,
        "enforcement": "advise",
        "minSampleSize": 20,
        "defaultBucket": "feature",
        "buckets": [
            {"id": "debt", "target": 0.4},
            {"id": "feature", "target": 0.6},
        ],
    }


def test_resolve_capacity_default_when_absent(policy_module, project_root):
    _write_project_def(project_root, {})
    result = policy_module.resolve_capacity_allocation(project_root)
    assert result.source == "default"
    assert result.configured is False
    assert result.unit == "vbrief-count"
    assert result.enforcement == "advise"
    assert result.min_sample_size == 20
    assert result.default_epic_estimate == 3


def test_resolve_capacity_typed_valid(policy_module, project_root):
    _write_project_def(project_root, {"policy": {"capacityAllocation": _valid_capacity()}})
    result = policy_module.resolve_capacity_allocation(project_root)
    assert result.source == "typed"
    assert result.configured is True
    assert result.window_days == 30
    assert result.default_bucket == "feature"
    assert [b.bucket_id for b in result.buckets] == ["debt", "feature"]
    assert result.buckets[0].target == 0.4


def test_resolve_capacity_cost_unit_returned_verbatim(policy_module, project_root):
    cap = _valid_capacity()
    cap["unit"] = "cost"
    _write_project_def(project_root, {"policy": {"capacityAllocation": cap}})
    result = policy_module.resolve_capacity_allocation(project_root)
    # The resolver returns cost verbatim -- the guarded fallback is downstream.
    assert result.unit == "cost"
    assert result.source == "typed"


def test_resolve_capacity_malformed_falls_back_on_error(policy_module, project_root):
    cap = _valid_capacity()
    cap["buckets"] = [{"id": "debt", "target": 0.4}, {"id": "feature", "target": 0.3}]
    _write_project_def(project_root, {"policy": {"capacityAllocation": cap}})
    result = policy_module.resolve_capacity_allocation(project_root)
    assert result.source == "default-on-error"
    assert result.configured is False
    assert result.error and "sum to 1.0" in result.error


def test_validate_capacity_valid_returns_empty(policy_module):
    assert policy_module.validate_capacity_allocation(_valid_capacity()) == []


def test_validate_capacity_none_is_valid(policy_module):
    assert policy_module.validate_capacity_allocation(None) == []


def test_validate_capacity_requires_window(policy_module):
    cap = _valid_capacity()
    del cap["window"]
    errors = policy_module.validate_capacity_allocation(cap)
    assert any("window is required" in e for e in errors)


def test_validate_capacity_targets_must_sum_to_one(policy_module):
    cap = _valid_capacity()
    cap["buckets"] = [{"id": "a", "target": 0.2}, {"id": "b", "target": 0.2}]
    errors = policy_module.validate_capacity_allocation(cap)
    assert any("sum to 1.0" in e for e in errors)


def test_validate_capacity_unique_bucket_ids(policy_module):
    cap = _valid_capacity()
    cap["buckets"] = [{"id": "dup", "target": 0.5}, {"id": "dup", "target": 0.5}]
    cap["defaultBucket"] = "dup"
    errors = policy_module.validate_capacity_allocation(cap)
    assert any("unique" in e for e in errors)


def test_validate_capacity_unit_enum(policy_module):
    cap = _valid_capacity()
    cap["unit"] = "story-points"
    errors = policy_module.validate_capacity_allocation(cap)
    assert any("unit must be one of" in e for e in errors)


def test_validate_capacity_default_bucket_must_match(policy_module):
    cap = _valid_capacity()
    cap["defaultBucket"] = "ghost"
    errors = policy_module.validate_capacity_allocation(cap)
    assert any("defaultBucket" in e for e in errors)


def test_validate_capacity_empty_buckets_rejected(policy_module):
    cap = _valid_capacity()
    cap["buckets"] = []
    errors = policy_module.validate_capacity_allocation(cap)
    assert any("non-empty array" in e for e in errors)


def test_validate_capacity_on_plan_prefixes_filepath(policy_module):
    cap = _valid_capacity()
    del cap["window"]
    plan = {"policy": {"capacityAllocation": cap}}
    errors = policy_module.validate_capacity_allocation_on_plan(plan, "foo.json")
    assert errors
    assert all(e.startswith("foo.json:") for e in errors)
    assert all("#1419" in e for e in errors)


def test_validate_capacity_on_plan_unset_is_empty(policy_module):
    assert policy_module.validate_capacity_allocation_on_plan({"policy": {}}, "f") == []


# ---------------------------------------------------------------------------
# judgmentGates typed schema (#1419 Delivery Slice 3)
# ---------------------------------------------------------------------------


def _valid_gate() -> dict:
    return {
        "id": "api-contract",
        "class": "declared",
        "tier": "block",
        "reason": "API contract change needs human sign-off",
        "requiredHumanReviewers": 1,
        "match": {"paths": {"any-of": ["api/**"]}},
    }


def test_validate_judgment_gates_valid_returns_empty(policy_module):
    assert policy_module.validate_judgment_gates([_valid_gate()]) == []


def test_validate_judgment_gates_none_is_valid(policy_module):
    assert policy_module.validate_judgment_gates(None) == []


def test_validate_judgment_gates_not_a_list(policy_module):
    errors = policy_module.validate_judgment_gates({"id": "x"})
    assert any("must be a list" in e for e in errors)


def test_validate_judgment_gates_requires_id(policy_module):
    gate = _valid_gate()
    del gate["id"]
    errors = policy_module.validate_judgment_gates([gate])
    assert any(".id must be a non-empty string" in e for e in errors)


def test_validate_judgment_gates_class_enum(policy_module):
    gate = _valid_gate()
    gate["class"] = "automatic"
    errors = policy_module.validate_judgment_gates([gate])
    assert any(".class must be one of" in e for e in errors)


def test_validate_judgment_gates_tier_enum(policy_module):
    gate = _valid_gate()
    gate["tier"] = "escalate"
    errors = policy_module.validate_judgment_gates([gate])
    assert any(".tier must be one of" in e for e in errors)


def test_validate_judgment_gates_requires_reason(policy_module):
    gate = _valid_gate()
    gate["reason"] = ""
    errors = policy_module.validate_judgment_gates([gate])
    assert any(".reason must be a non-empty string" in e for e in errors)


def test_validate_judgment_gates_required_reviewers_non_negative(policy_module):
    gate = _valid_gate()
    gate["requiredHumanReviewers"] = -1
    errors = policy_module.validate_judgment_gates([gate])
    assert any("requiredHumanReviewers" in e for e in errors)


def test_validate_judgment_gates_match_requires_a_predicate(policy_module):
    gate = _valid_gate()
    gate["match"] = {}
    errors = policy_module.validate_judgment_gates([gate])
    assert any("requires at least one of" in e for e in errors)


def test_validate_judgment_gates_paths_predicate_shape(policy_module):
    gate = _valid_gate()
    gate["match"] = {"paths": {"any-of": []}}
    errors = policy_module.validate_judgment_gates([gate])
    assert any("paths.any-of must be a non-empty list" in e for e in errors)


def test_validate_judgment_gates_rejects_unknown_predicate(policy_module):
    # A misspelled `path` (should be `paths`) alongside a valid predicate must
    # fail loudly, not be silently dropped at match time.
    gate = _valid_gate()
    gate["match"] = {"paths": {"any-of": ["api/**"]}, "path": {"any-of": ["x"]}}
    errors = policy_module.validate_judgment_gates([gate])
    assert any("unrecognised predicate" in e for e in errors)


def test_validate_judgment_gates_labels_mutually_exclusive(policy_module):
    gate = _valid_gate()
    gate["match"] = {"labels": {"any-of": ["a"], "all-of": ["b"]}}
    errors = policy_module.validate_judgment_gates([gate])
    assert any("mutually exclusive" in e for e in errors)


def test_validate_judgment_gates_age_days_predicate(policy_module):
    gate = _valid_gate()
    gate["match"] = {"age-days": {"gt": -3}}
    errors = policy_module.validate_judgment_gates([gate])
    assert any("age-days.gt must be a non-negative integer" in e for e in errors)


def test_validate_judgment_gates_unique_ids(policy_module):
    errors = policy_module.validate_judgment_gates([_valid_gate(), _valid_gate()])
    assert any("ids must be unique" in e for e in errors)


def test_validate_judgment_gates_disabled_valid(policy_module):
    assert policy_module.validate_judgment_gates_disabled(["secrets-and-credentials"]) == []


def test_validate_judgment_gates_disabled_not_a_list(policy_module):
    errors = policy_module.validate_judgment_gates_disabled("secrets-and-credentials")
    assert any("must be a list" in e for e in errors)


def test_validate_judgment_gates_disabled_non_string_entry(policy_module):
    errors = policy_module.validate_judgment_gates_disabled(["", 3])
    assert len(errors) == 2


def test_validate_judgment_gates_on_plan_prefixes_filepath(policy_module):
    gate = _valid_gate()
    gate["tier"] = "nope"
    plan = {"policy": {"judgmentGates": [gate]}}
    errors = policy_module.validate_judgment_gates_on_plan(plan, "foo.json")
    assert errors
    assert all(e.startswith("foo.json:") for e in errors)
    assert all("#1419" in e for e in errors)


def test_validate_judgment_gates_on_plan_unset_is_empty(policy_module):
    assert policy_module.validate_judgment_gates_on_plan({"policy": {}}, "f") == []


def test_resolve_judgment_gates_default_when_absent(policy_module, project_root):
    _write_project_def(project_root, {})
    result = policy_module.resolve_judgment_gates(project_root)
    assert result.source == "default"
    assert result.configured is False
    assert result.gates == ()
    assert result.disabled == ()


def test_resolve_judgment_gates_typed_valid(policy_module, project_root):
    _write_project_def(
        project_root,
        {
            "policy": {
                "judgmentGates": [_valid_gate()],
                "judgmentGatesDisabled": ["installer-and-bootstrap"],
            }
        },
    )
    result = policy_module.resolve_judgment_gates(project_root)
    assert result.source == "typed"
    assert result.configured is True
    assert result.gates[0].gate_id == "api-contract"
    assert result.gates[0].gate_class == "declared"
    assert result.gates[0].tier == "block"
    assert result.gates[0].required_human_reviewers == 1
    assert result.disabled == ("installer-and-bootstrap",)


def test_resolve_judgment_gates_disabled_only_is_typed(policy_module, project_root):
    _write_project_def(
        project_root, {"policy": {"judgmentGatesDisabled": ["secrets-and-credentials"]}}
    )
    result = policy_module.resolve_judgment_gates(project_root)
    assert result.source == "typed"
    assert result.gates == ()
    assert result.disabled == ("secrets-and-credentials",)
    # No consumer gates -> not "configured" (the render predicate), but typed.
    assert result.configured is False


def test_resolve_judgment_gates_malformed_falls_back_on_error(policy_module, project_root):
    bad = _valid_gate()
    del bad["class"]
    _write_project_def(project_root, {"policy": {"judgmentGates": [bad]}})
    result = policy_module.resolve_judgment_gates(project_root)
    assert result.source == "default-on-error"
    assert result.gates == ()
    assert result.error is not None


# ---------------------------------------------------------------------------
# autonomy dial typed schema + resolver (#1419 Delivery Slice 5)
# ---------------------------------------------------------------------------


def _valid_autonomy() -> dict:
    return {
        "enabled": True,
        "defaultLevel": "escalate",
        "minSampleSize": 20,
        "advanceOverrideRateMax": 0.05,
        "retreatOverrideRate": 0.20,
        "reworkBaseline": 0.15,
        "gates": {"api-contract": "observe"},
    }


def test_validate_autonomy_valid_returns_empty(policy_module):
    assert policy_module.validate_autonomy(_valid_autonomy()) == []


def test_validate_autonomy_none_is_valid(policy_module):
    assert policy_module.validate_autonomy(None) == []


def test_validate_autonomy_not_a_dict(policy_module):
    errors = policy_module.validate_autonomy([1, 2])
    assert any("must be an object" in e for e in errors)


def test_validate_autonomy_default_level_enum(policy_module):
    cfg = _valid_autonomy()
    cfg["defaultLevel"] = "yolo"
    errors = policy_module.validate_autonomy(cfg)
    assert any("defaultLevel must be one of" in e for e in errors)


def test_validate_autonomy_min_sample_size_non_negative(policy_module):
    cfg = _valid_autonomy()
    cfg["minSampleSize"] = -1
    errors = policy_module.validate_autonomy(cfg)
    assert any("minSampleSize" in e for e in errors)


def test_validate_autonomy_rates_bounded(policy_module):
    cfg = _valid_autonomy()
    cfg["advanceOverrideRateMax"] = 1.5
    errors = policy_module.validate_autonomy(cfg)
    assert any("advanceOverrideRateMax" in e for e in errors)


def test_validate_autonomy_gate_level_enum(policy_module):
    cfg = _valid_autonomy()
    cfg["gates"] = {"g1": "turbo"}
    errors = policy_module.validate_autonomy(cfg)
    assert any("gates['g1'] must be one of" in e for e in errors)


def test_validate_autonomy_on_plan_prefixes_filepath(policy_module):
    cfg = _valid_autonomy()
    cfg["defaultLevel"] = "nope"
    plan = {"policy": {"autonomy": cfg}}
    errors = policy_module.validate_autonomy_on_plan(plan, "foo.json")
    assert errors
    assert all(e.startswith("foo.json:") for e in errors)
    assert all("#1419" in e for e in errors)


def test_validate_autonomy_on_plan_unset_is_empty(policy_module):
    assert policy_module.validate_autonomy_on_plan({"policy": {}}, "f") == []


def test_resolve_autonomy_default_when_absent(policy_module, project_root):
    _write_project_def(project_root, {})
    result = policy_module.resolve_autonomy(project_root)
    assert result.source == "default"
    assert result.configured is False
    assert result.default_level == "escalate"
    assert result.min_sample_size == 20


def test_resolve_autonomy_typed_valid(policy_module, project_root):
    _write_project_def(project_root, {"policy": {"autonomy": _valid_autonomy()}})
    result = policy_module.resolve_autonomy(project_root)
    assert result.source == "typed"
    assert result.configured is True
    assert result.default_level == "escalate"
    assert result.gate_levels == {"api-contract": "observe"}
    assert result.level_for("api-contract") == "observe"
    assert result.level_for("other") == "escalate"


def test_resolve_autonomy_malformed_falls_back_on_error(policy_module, project_root):
    cfg = _valid_autonomy()
    cfg["defaultLevel"] = "bad"
    _write_project_def(project_root, {"policy": {"autonomy": cfg}})
    result = policy_module.resolve_autonomy(project_root)
    assert result.source == "default-on-error"
    assert result.error is not None
    # Self-heals to the framework default level.
    assert result.default_level == "escalate"


# ---------------------------------------------------------------------------
# autonomy dial recommendation -- asymmetric advance / retreat (advisory-only)
# ---------------------------------------------------------------------------


def test_recommend_autonomy_advances_on_low_override(policy_module):
    rec = policy_module.recommend_autonomy_level(
        "escalate",
        override_rate=0.0,
        rework_rate=0.0,
        sample_size=20,
        p0_reversal=False,
    )
    assert rec.action == "advance"
    assert rec.recommended_level == "execute"
    assert rec.advisory is True
    assert rec.reduces_required_clearances is True


def test_recommend_autonomy_retreats_on_high_override(policy_module):
    rec = policy_module.recommend_autonomy_level(
        "escalate",
        override_rate=0.5,
        rework_rate=0.0,
        sample_size=20,
        p0_reversal=False,
    )
    assert rec.action == "retreat"
    assert rec.recommended_level == "observe"
    assert rec.advisory is True
    assert rec.restores_required_clearances is True


def test_recommend_autonomy_retreats_immediately_on_p0_reversal(policy_module):
    # A P0 reversal retreats even when the override rate is low and the sample
    # is small (no sample-size gate on the retreat path -- safety first).
    rec = policy_module.recommend_autonomy_level(
        "execute",
        override_rate=0.0,
        rework_rate=0.0,
        sample_size=1,
        p0_reversal=True,
    )
    assert rec.action == "retreat"
    assert rec.recommended_level == "escalate"


def test_recommend_autonomy_holds_below_min_sample(policy_module):
    rec = policy_module.recommend_autonomy_level(
        "escalate",
        override_rate=0.0,
        rework_rate=0.0,
        sample_size=5,  # below default minSampleSize=20
        p0_reversal=False,
    )
    assert rec.action == "hold"
    assert rec.recommended_level == "escalate"


def test_recommend_autonomy_holds_when_rework_spikes(policy_module):
    # Override is low and sample is large, but rework exceeds the baseline
    # guardrail -- the advance is withheld (hold, not advance).
    rec = policy_module.recommend_autonomy_level(
        "escalate",
        override_rate=0.0,
        rework_rate=0.5,
        sample_size=20,
        p0_reversal=False,
    )
    assert rec.action == "hold"


def test_recommend_autonomy_holds_at_observe_floor(policy_module):
    rec = policy_module.recommend_autonomy_level(
        "observe",
        override_rate=0.9,
        rework_rate=0.0,
        sample_size=20,
        p0_reversal=True,
    )
    assert rec.action == "hold"
    assert rec.recommended_level == "observe"


def test_recommend_autonomy_holds_at_execute_ceiling(policy_module):
    rec = policy_module.recommend_autonomy_level(
        "execute",
        override_rate=0.0,
        rework_rate=0.0,
        sample_size=20,
        p0_reversal=False,
    )
    assert rec.action == "hold"
    assert rec.recommended_level == "execute"


def test_recommend_autonomy_honours_configured_thresholds(policy_module, project_root):
    cfg = _valid_autonomy()
    cfg["minSampleSize"] = 2
    _write_project_def(project_root, {"policy": {"autonomy": cfg}})
    pol = policy_module.resolve_autonomy(project_root)
    rec = policy_module.recommend_autonomy_level(
        pol.default_level,
        override_rate=0.0,
        rework_rate=0.0,
        sample_size=2,  # meets the lowered minSampleSize
        policy=pol,
    )
    assert rec.action == "advance"


# ---------------------------------------------------------------------------
# pending-human-decisions backlog audit log (#1419 Delivery Slice 5)
# ---------------------------------------------------------------------------


def test_record_pending_decision_increments_count(policy_module, project_root):
    assert policy_module.count_pending_decisions(project_root) == 0
    policy_module.record_pending_decision(
        project_root, decision_id="d1", kind="judgment-gate"
    )
    policy_module.record_pending_decision(
        project_root, decision_id="d2", kind="judgment-gate"
    )
    assert policy_module.count_pending_decisions(project_root) == 2


def test_resolve_pending_decision_decrements_count(policy_module, project_root):
    policy_module.record_pending_decision(
        project_root, decision_id="d1", kind="judgment-gate"
    )
    assert policy_module.count_pending_decisions(project_root) == 1
    policy_module.resolve_pending_decision(project_root, decision_id="d1")
    # The latest event for d1 is now 'resolved' -> not counted as pending.
    assert policy_module.count_pending_decisions(project_root) == 0


def test_record_pending_decision_rejects_blank_id(policy_module, project_root):
    with pytest.raises(ValueError):
        policy_module.record_pending_decision(
            project_root, decision_id="  ", kind="x"
        )


def test_summarize_decision_backlog_by_kind_and_override(policy_module, project_root):
    now = datetime(2026, 6, 4, 12, 0, 0, tzinfo=UTC)
    # Two pending of distinct kinds.
    policy_module.record_pending_decision(
        project_root, decision_id="p1", kind="judgment-gate", now=now
    )
    policy_module.record_pending_decision(
        project_root, decision_id="p2", kind="reviewer-disagreement", now=now
    )
    # Three resolved-in-window: one override + one P0 reversal.
    for i in range(3):
        did = f"r{i}"
        policy_module.record_pending_decision(
            project_root, decision_id=did, kind="judgment-gate", now=now
        )
        policy_module.resolve_pending_decision(
            project_root,
            decision_id=did,
            override=(i == 0),
            p0_reversal=(i == 1),
            now=now,
        )
    backlog = policy_module.summarize_decision_backlog(
        project_root, now=now, window_days=30
    )
    assert backlog.pending_count == 2
    assert backlog.by_kind == {"judgment-gate": 1, "reviewer-disagreement": 1}
    assert backlog.resolved_in_window == 3
    assert backlog.override_count == 1
    assert backlog.p0_reversal_in_window is True
    assert abs(backlog.override_rate - (1 / 3)) < 1e-9


def test_summarize_decision_backlog_window_excludes_stale_resolved(
    policy_module, project_root
):
    now = datetime(2026, 6, 4, 12, 0, 0, tzinfo=UTC)
    stale = now - timedelta(days=120)
    did = "old"
    policy_module.record_pending_decision(
        project_root, decision_id=did, kind="judgment-gate", now=stale
    )
    policy_module.resolve_pending_decision(
        project_root, decision_id=did, override=True, now=stale
    )
    backlog = policy_module.summarize_decision_backlog(
        project_root, now=now, window_days=30
    )
    # Resolved 120d ago -> outside the 30d window -> not counted.
    assert backlog.resolved_in_window == 0
    assert backlog.override_rate == 0.0


def test_read_decision_events_tolerates_malformed_lines(policy_module, project_root):
    log = policy_module.pending_decisions_log_path(project_root)
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(
        'not json\n{"decision_id": "good", "status": "pending"}\n',
        encoding="utf-8",
    )
    events = policy_module.read_decision_events(project_root)
    assert len(events) == 1
    assert events[0]["decision_id"] == "good"


# ---------------------------------------------------------------------------
# OQ4 reviewer-disagreement routing + escalation (#1419 Delivery Slice 5)
# ---------------------------------------------------------------------------


def test_route_block_tier_fails_closed(policy_module):
    routing = policy_module.route_reviewer_disagreement(severity="p2", tier="block")
    assert routing.escalates is True
    assert routing.effective_tier == "block"
    assert routing.required_human_reviewers == 1


def test_route_review_tier_escalates_on_p1(policy_module):
    routing = policy_module.route_reviewer_disagreement(severity="p1", tier="review")
    assert routing.escalates is True
    assert routing.required_human_reviewers == 1


def test_route_review_tier_no_escalation_on_p2(policy_module):
    routing = policy_module.route_reviewer_disagreement(severity="p2", tier="review")
    assert routing.escalates is False
    assert routing.required_human_reviewers == 0


def test_route_review_tier_errored_reason_distinguishes_from_severity(policy_module):
    # errored-on-HEAD with a low (non-escalating) severity must not be labelled
    # as a severity-driven split in the review-tier audit reason.
    routing = policy_module.route_reviewer_disagreement(
        severity="p2", tier="review", errored_on_head=True
    )
    assert routing.escalates is True
    assert "errored-on-HEAD" in routing.reason
    assert "p2" not in routing.reason


def test_route_auto_tier_contested_p0_upgrades_to_review(policy_module):
    routing = policy_module.route_reviewer_disagreement(severity="p0", tier="auto")
    assert routing.escalates is True
    assert routing.upgraded is True
    assert routing.effective_tier == "review"


def test_route_auto_tier_no_escalation_below_p0(policy_module):
    routing = policy_module.route_reviewer_disagreement(severity="p2", tier="auto")
    assert routing.escalates is False
    assert routing.upgraded is False


def test_route_auto_tier_errored_on_head_upgrades(policy_module):
    routing = policy_module.route_reviewer_disagreement(
        severity="p2", tier="auto", errored_on_head=True
    )
    assert routing.escalates is True
    assert routing.upgraded is True
    assert routing.effective_tier == "review"


def test_route_auto_tier_errored_reason_distinguishes_from_p0(policy_module):
    # errored-on-HEAD with a non-P0 severity must NOT be labelled "contested P0".
    routing = policy_module.route_reviewer_disagreement(
        severity="p2", tier="auto", errored_on_head=True
    )
    assert "errored-on-HEAD" in routing.reason
    assert "contested P0" not in routing.reason


def test_route_auto_tier_p0_reason_is_contested_p0(policy_module):
    routing = policy_module.route_reviewer_disagreement(severity="p0", tier="auto")
    assert "contested P0" in routing.reason


def test_escalate_reviewer_disagreement_increments_backlog(policy_module, project_root):
    routing = policy_module.escalate_reviewer_disagreement(
        project_root, decision_id="split-1", severity="p0", tier="review"
    )
    assert routing.escalates is True
    assert policy_module.count_pending_decisions(project_root) == 1
    events = policy_module.read_decision_events(project_root)
    assert events[0]["kind"] == policy_module.REVIEWER_DISAGREEMENT_KIND


def test_escalate_reviewer_disagreement_no_record_when_not_escalating(
    policy_module, project_root
):
    routing = policy_module.escalate_reviewer_disagreement(
        project_root, decision_id="split-2", severity="p2", tier="review"
    )
    assert routing.escalates is False
    assert policy_module.count_pending_decisions(project_root) == 0
