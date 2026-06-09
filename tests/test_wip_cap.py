"""Tests for the D4 (#1124) WIP cap surface.

Covers every acceptance criterion from issue #1124 (as overridden by
umbrella #1119 Current Shape v3, comment 4471269010 -- default cap 10):

- ``resolve_wip_cap`` unit (default / typed / non-int / zero / missing
  PROJECT-DEFINITION / malformed JSON).
- ``count_vbrief_wip`` unit.
- ``validate_wip_cap`` + ``validate_wip_cap_on_plan`` schema-hook.
- ``set_wip_cap`` writes typed flag + audit-log entry.
- ``policy_set.py wip-cap`` subcommand (refuses without --confirm,
  writes with --confirm, surfaces resolved cap).
- ``scope_lifecycle.py`` promote: under cap success, at-cap refused,
  over-cap refused, ``--force`` succeeds with warning + audit entry,
  cap=0 refuses every promotion, custom cap (8) honoured.
- ``triage_summary.resolve_wip_cap`` shim returns the integer cap and
  delegates to ``scripts.policy.resolve_wip_cap`` (D2 default-drift
  regression).
- ``scripts/preflight_wip_cap.py`` three-state exit (within cap,
  over-cap refused, ``--allow-over-cap`` tolerance for framework
  self-check).
- ``vbrief_validate`` hook surfaces wipCap errors with the
  ``(#1124)`` pointer.
- Acceptance text on the refusal message names cap, count, and the
  three relief verbs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import policy  # noqa: E402, I001
import policy_set  # noqa: E402, I001
import preflight_wip_cap  # noqa: E402, I001
import scope_lifecycle  # noqa: E402, I001
import triage_summary  # noqa: E402, I001
import vbrief_validate  # noqa: E402, I001


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _write_project_definition(project_root: Path, *, cap: object = ...) -> Path:
    """Build a minimal PROJECT-DEFINITION with optional ``plan.policy.wipCap``."""
    project_root.mkdir(parents=True, exist_ok=True)
    vbrief_root = project_root / "vbrief"
    vbrief_root.mkdir(parents=True, exist_ok=True)
    payload: dict = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "Test project",
            "status": "running",
            "items": [],
            "narratives": {"Overview": "test", "TechStack": "test"},
        },
    }
    if cap is not ...:
        payload["plan"]["policy"] = {"wipCap": cap}
    path = vbrief_root / "PROJECT-DEFINITION.vbrief.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def _seed_lifecycle(project_root: Path, *, pending: int = 0, active: int = 0) -> None:
    """Drop synthetic ``.vbrief.json`` files into pending/ and active/."""
    for folder, count in (("pending", pending), ("active", active)):
        target = project_root / "vbrief" / folder
        target.mkdir(parents=True, exist_ok=True)
        for i in range(count):
            (target / f"2026-05-18-test-{folder}-{i:03d}.vbrief.json").write_text(
                json.dumps(
                    {
                        "vBRIEFInfo": {"version": "0.6"},
                        "plan": {
                            "title": f"Test {folder} {i}",
                            "status": "pending" if folder == "pending" else "running",
                            "items": [],
                        },
                    }
                ),
                encoding="utf-8",
            )


def _seed_proposed(project_root: Path, slug: str = "candidate") -> Path:
    """Drop one synthetic ``proposed/`` vBRIEF and return its path."""
    target = project_root / "vbrief" / "proposed"
    target.mkdir(parents=True, exist_ok=True)
    path = target / f"2026-05-18-{slug}.vbrief.json"
    path.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": f"Test {slug}",
                    "status": "proposed",
                    "items": [],
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return path


# ---------------------------------------------------------------------------
# DEFAULT_WIP_CAP + resolve_wip_cap (D4 unit)
# ---------------------------------------------------------------------------


def test_default_wip_cap_is_10_per_umbrella_v3() -> None:
    """Umbrella #1119 Current Shape v3 overrides D4 issue body's 12 -> 10."""
    assert policy.DEFAULT_WIP_CAP == 10


def test_resolve_wip_cap_returns_default_when_field_absent(tmp_path: Path) -> None:
    _write_project_definition(tmp_path)
    result = policy.resolve_wip_cap(tmp_path)
    assert result.cap == policy.DEFAULT_WIP_CAP
    assert result.source == "default"
    assert result.error is None


def test_resolve_wip_cap_returns_default_when_project_definition_missing(tmp_path: Path) -> None:
    result = policy.resolve_wip_cap(tmp_path)
    assert result.cap == policy.DEFAULT_WIP_CAP
    assert result.source == "default"
    assert result.error is not None  # observability for the caller


def test_resolve_wip_cap_honours_typed_field(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap=8)
    result = policy.resolve_wip_cap(tmp_path)
    assert result.cap == 8
    assert result.source == "typed"
    assert result.error is None


def test_resolve_wip_cap_zero_honoured(tmp_path: Path) -> None:
    """cap=0 freezes promotion entirely -- legitimate operator state."""
    _write_project_definition(tmp_path, cap=0)
    result = policy.resolve_wip_cap(tmp_path)
    assert result.cap == 0
    assert result.source == "typed"


def test_resolve_wip_cap_rejects_non_int(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap="ten")
    result = policy.resolve_wip_cap(tmp_path)
    assert result.cap == policy.DEFAULT_WIP_CAP
    assert result.source == "default-on-error"
    assert result.error is not None


def test_resolve_wip_cap_rejects_bool(tmp_path: Path) -> None:
    """``bool`` is a subclass of ``int`` in Python; explicit guard required."""
    _write_project_definition(tmp_path, cap=True)
    result = policy.resolve_wip_cap(tmp_path)
    assert result.cap == policy.DEFAULT_WIP_CAP
    assert result.source == "default-on-error"


def test_resolve_wip_cap_rejects_negative(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap=-1)
    result = policy.resolve_wip_cap(tmp_path)
    assert result.cap == policy.DEFAULT_WIP_CAP
    assert result.source == "default-on-error"


# ---------------------------------------------------------------------------
# count_vbrief_wip
# ---------------------------------------------------------------------------


def test_count_vbrief_wip_sums_pending_plus_active(tmp_path: Path) -> None:
    _seed_lifecycle(tmp_path, pending=3, active=4)
    assert policy.count_vbrief_wip(tmp_path) == 7


def test_count_vbrief_wip_filters_to_vbrief_json(tmp_path: Path) -> None:
    _seed_lifecycle(tmp_path, pending=2, active=1)
    # Scratch artefacts that should NOT be counted.
    (tmp_path / "vbrief" / "pending" / "README.md").write_text("notes", encoding="utf-8")
    (tmp_path / "vbrief" / "active" / "scratch.txt").write_text("notes", encoding="utf-8")
    assert policy.count_vbrief_wip(tmp_path) == 3


def test_count_vbrief_wip_zero_on_missing_folders(tmp_path: Path) -> None:
    assert policy.count_vbrief_wip(tmp_path) == 0


# ---------------------------------------------------------------------------
# validate_wip_cap + validate_wip_cap_on_plan hook
# ---------------------------------------------------------------------------


def test_validate_wip_cap_accepts_none() -> None:
    assert policy.validate_wip_cap(None) == []


def test_validate_wip_cap_accepts_non_negative_int() -> None:
    for value in (0, 1, 10, 100):
        assert policy.validate_wip_cap(value) == []


def test_validate_wip_cap_rejects_bool() -> None:
    errors = policy.validate_wip_cap(True)
    assert errors and "integer" in errors[0]


def test_validate_wip_cap_rejects_str() -> None:
    errors = policy.validate_wip_cap("ten")
    assert errors and "integer" in errors[0]


def test_validate_wip_cap_rejects_negative() -> None:
    errors = policy.validate_wip_cap(-3)
    assert errors and ">= 0" in errors[0]


def test_validate_wip_cap_on_plan_emits_pointer() -> None:
    out = policy.validate_wip_cap_on_plan(
        {"policy": {"wipCap": -1}},
        "vbrief/PROJECT-DEFINITION.vbrief.json",
    )
    assert out and "#1124" in out[0]
    assert "vbrief/PROJECT-DEFINITION.vbrief.json" in out[0]


def test_validate_wip_cap_on_plan_silent_when_absent() -> None:
    assert policy.validate_wip_cap_on_plan({"policy": {}}, "fake") == []
    assert policy.validate_wip_cap_on_plan({}, "fake") == []


def test_vbrief_validate_hook_surfaces_wip_cap_error(tmp_path: Path) -> None:
    """vbrief_validate.validate_project_definition wires the lazy hook."""
    pd_path = _write_project_definition(tmp_path, cap="ten")
    data = json.loads(pd_path.read_text(encoding="utf-8"))
    errors = vbrief_validate.validate_project_definition(
        pd_path, data, tmp_path / "vbrief"
    )
    assert any("wipCap" in e and "#1124" in e for e in errors)


# ---------------------------------------------------------------------------
# set_wip_cap writer + audit-log
# ---------------------------------------------------------------------------


def test_set_wip_cap_writes_typed_field_and_audits(tmp_path: Path) -> None:
    pd = _write_project_definition(tmp_path)
    changed, audit_entry = policy.set_wip_cap(tmp_path, cap=8, actor="test")
    assert changed is True
    assert "wipCap=8" in audit_entry
    data = json.loads(pd.read_text(encoding="utf-8"))
    assert data["plan"]["policy"]["wipCap"] == 8
    log = (tmp_path / policy.AUDIT_LOG_REL_PATH).read_text(encoding="utf-8")
    assert "wipCap=8" in log
    assert "actor=test" in log


def test_set_wip_cap_noop_when_value_matches(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap=8)
    changed, _ = policy.set_wip_cap(tmp_path, cap=8)
    assert changed is False


def test_set_wip_cap_rejects_negative(tmp_path: Path) -> None:
    _write_project_definition(tmp_path)
    with pytest.raises(ValueError):
        policy.set_wip_cap(tmp_path, cap=-1)


def test_set_wip_cap_raises_filenotfound_when_missing(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        policy.set_wip_cap(tmp_path, cap=10)


# ---------------------------------------------------------------------------
# policy_set.py wip-cap subcommand (CLI)
# ---------------------------------------------------------------------------


def test_policy_set_wip_cap_refuses_without_confirm(tmp_path: Path, capsys) -> None:
    _write_project_definition(tmp_path)
    rc = policy_set.main(
        ["wip-cap", "--set", "8", "--project-root", str(tmp_path)]
    )
    out = capsys.readouterr().out
    assert rc == 1
    assert "Capability-cost" in out or "capability-cost" in out
    assert "--confirm" in out


def test_policy_set_wip_cap_writes_with_confirm(tmp_path: Path, capsys) -> None:
    pd = _write_project_definition(tmp_path)
    rc = policy_set.main(
        [
            "wip-cap",
            "--set",
            "6",
            "--confirm",
            "--project-root",
            str(tmp_path),
            "--actor",
            "test",
        ]
    )
    out = capsys.readouterr().out
    assert rc == 0
    assert "wipCap=6" in out
    data = json.loads(pd.read_text(encoding="utf-8"))
    assert data["plan"]["policy"]["wipCap"] == 6


def test_policy_set_wip_cap_missing_project_definition_returns_config_error(
    tmp_path: Path, capsys
) -> None:
    rc = policy_set.main(
        [
            "wip-cap",
            "--set",
            "8",
            "--confirm",
            "--project-root",
            str(tmp_path),
        ]
    )
    err = capsys.readouterr().err
    assert rc == 2
    assert "not found" in err


# ---------------------------------------------------------------------------
# scope_lifecycle.py promote: cap enforcement matrix
# ---------------------------------------------------------------------------


def test_check_wip_cap_under_cap_allows(tmp_path: Path) -> None:
    _write_project_definition(tmp_path)  # default 10
    _seed_lifecycle(tmp_path, pending=3, active=4)  # count=7 < 10
    check = scope_lifecycle.check_wip_cap(tmp_path)
    assert check.allowed is True
    assert check.cap == 10
    assert check.count == 7
    assert check.force_override is False


def test_check_wip_cap_at_cap_refuses(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap=5)
    _seed_lifecycle(tmp_path, pending=5)
    check = scope_lifecycle.check_wip_cap(tmp_path)
    assert check.allowed is False
    assert check.cap == 5
    assert check.count == 5
    assert check.force_override is False


def test_check_wip_cap_over_cap_refuses(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap=5)
    _seed_lifecycle(tmp_path, pending=4, active=4)
    check = scope_lifecycle.check_wip_cap(tmp_path)
    assert check.allowed is False
    assert check.count == 8


def test_check_wip_cap_force_overrides(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap=5)
    _seed_lifecycle(tmp_path, pending=10)
    check = scope_lifecycle.check_wip_cap(tmp_path, force=True)
    assert check.allowed is True
    assert check.force_override is True


def test_check_wip_cap_zero_refuses_all(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap=0)
    # Empty WIP set; cap=0 still refuses (0 >= 0).
    check = scope_lifecycle.check_wip_cap(tmp_path)
    assert check.allowed is False
    assert check.cap == 0
    assert check.count == 0


def test_check_wip_cap_custom_value_honoured(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap=8)
    _seed_lifecycle(tmp_path, pending=7)
    assert scope_lifecycle.check_wip_cap(tmp_path).allowed is True
    _seed_lifecycle(tmp_path, pending=8)
    assert scope_lifecycle.check_wip_cap(tmp_path).allowed is False


def test_format_wip_cap_refusal_names_cap_count_and_relief_verbs() -> None:
    check = scope_lifecycle.WipCapCheck(
        allowed=False, cap=10, count=12, source="typed", force_override=False
    )
    msg = scope_lifecycle.format_wip_cap_refusal(check)
    # Cap + current count surfaced.
    assert "12/10" in msg
    assert "WIP cap reached" in msg
    # All three relief verbs named verbatim.
    assert "task scope:demote <existing>" in msg
    assert "task scope:demote --batch --older-than-days 30" in msg
    assert "task scope:promote <file> --force" in msg


def test_scope_lifecycle_main_promote_refused_over_cap(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    _write_project_definition(tmp_path, cap=2)
    _seed_lifecycle(tmp_path, pending=2)
    candidate = _seed_proposed(tmp_path, slug="d4-blocked")
    monkeypatch.chdir(tmp_path)
    rc = scope_lifecycle.main(
        ["promote", str(candidate), "--project-root", str(tmp_path)]
    )
    err = capsys.readouterr().err
    assert rc == 1
    assert "WIP cap reached (2/2" in err
    # File MUST NOT have moved.
    assert candidate.exists()
    assert not (tmp_path / "vbrief" / "pending" / candidate.name).exists()


def test_scope_lifecycle_main_promote_under_cap_succeeds(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    _write_project_definition(tmp_path, cap=10)
    _seed_lifecycle(tmp_path, pending=1)
    candidate = _seed_proposed(tmp_path, slug="d4-ok")
    monkeypatch.chdir(tmp_path)
    rc = scope_lifecycle.main(
        ["promote", str(candidate), "--project-root", str(tmp_path)]
    )
    assert rc == 0
    # File moved to pending/.
    assert not candidate.exists()
    assert (tmp_path / "vbrief" / "pending" / candidate.name).exists()


def test_scope_lifecycle_main_promote_force_over_cap_succeeds_with_warning_and_audit(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    _write_project_definition(tmp_path, cap=2)
    _seed_lifecycle(tmp_path, pending=2)
    candidate = _seed_proposed(tmp_path, slug="d4-force")
    monkeypatch.chdir(tmp_path)
    rc = scope_lifecycle.main(
        ["promote", str(candidate), "--force", "--project-root", str(tmp_path)]
    )
    captured = capsys.readouterr()
    assert rc == 0
    # Warning emitted to stderr; file moved; audit entry written.
    assert "WIP cap exceeded" in captured.err
    assert "--force" in captured.err
    assert (tmp_path / "vbrief" / "pending" / candidate.name).exists()
    audit_log = tmp_path / "vbrief" / ".eval" / "scope-lifecycle.jsonl"
    assert audit_log.is_file()
    entries = [
        json.loads(line)
        for line in audit_log.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    promote_entries = [e for e in entries if e.get("action") == "promote"]
    assert promote_entries
    block = promote_entries[-1].get("wip_cap_override")
    assert isinstance(block, dict)
    assert block["cap"] == 2
    assert block["count_at_promote"] == 2
    assert block["reason"] == "--force"


def test_scope_lifecycle_main_promote_cap_zero_refuses_every_promotion(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    _write_project_definition(tmp_path, cap=0)
    candidate = _seed_proposed(tmp_path, slug="d4-zero")
    monkeypatch.chdir(tmp_path)
    rc = scope_lifecycle.main(
        ["promote", str(candidate), "--project-root", str(tmp_path)]
    )
    err = capsys.readouterr().err
    assert rc == 1
    assert "WIP cap reached (0/0" in err


# ---------------------------------------------------------------------------
# D2 (#1122) default-drift regression -- triage_summary.resolve_wip_cap
# ---------------------------------------------------------------------------


def test_d2_default_drift_fixed_imports_shared_constant() -> None:
    # The single source of truth lives in scripts.policy; D2 re-exports.
    assert triage_summary.DEFAULT_WIP_CAP is policy.DEFAULT_WIP_CAP
    assert triage_summary.DEFAULT_WIP_CAP == 10


def test_d2_resolve_wip_cap_shim_delegates_to_policy(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, cap=7)
    # D2's shim returns the integer cap (preserves its original signature).
    assert triage_summary.resolve_wip_cap(tmp_path) == 7
    # Matches the D4 canonical resolver.
    assert triage_summary.resolve_wip_cap(tmp_path) == policy.resolve_wip_cap(tmp_path).cap


def test_d2_resolve_wip_cap_shim_default_matches_framework(tmp_path: Path) -> None:
    _write_project_definition(tmp_path)
    assert triage_summary.resolve_wip_cap(tmp_path) == policy.DEFAULT_WIP_CAP


# ---------------------------------------------------------------------------
# preflight_wip_cap.py -- task verify:wip-cap CI re-validation
# ---------------------------------------------------------------------------


def test_preflight_within_cap_exits_zero(tmp_path: Path, capsys) -> None:
    _write_project_definition(tmp_path, cap=10)
    _seed_lifecycle(tmp_path, pending=2, active=3)
    rc = preflight_wip_cap.main(["--project-root", str(tmp_path)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "within cap" in out


def test_preflight_over_cap_exits_one_and_names_relief_verbs(
    tmp_path: Path, capsys
) -> None:
    _write_project_definition(tmp_path, cap=2)
    _seed_lifecycle(tmp_path, pending=2, active=1)
    rc = preflight_wip_cap.main(["--project-root", str(tmp_path)])
    err = capsys.readouterr().err
    assert rc == 1
    assert "3/2" in err
    assert "scope:demote" in err
    assert "older-than-days 30" in err


def test_preflight_allow_over_cap_tolerates_overage(tmp_path: Path, capsys) -> None:
    _write_project_definition(tmp_path, cap=2)
    _seed_lifecycle(tmp_path, pending=5)
    rc = preflight_wip_cap.main(
        ["--project-root", str(tmp_path), "--allow-over-cap"]
    )
    err = capsys.readouterr().err
    assert rc == 0
    assert "OVER cap" in err
    assert "consumers MUST NOT" in err


def test_preflight_malformed_typed_field_exits_two(tmp_path: Path, capsys) -> None:
    _write_project_definition(tmp_path, cap="ten")
    rc = preflight_wip_cap.main(["--project-root", str(tmp_path)])
    err = capsys.readouterr().err
    assert rc == 2
    assert "malformed" in err


def test_preflight_quiet_silences_success_banner(tmp_path: Path, capsys) -> None:
    _write_project_definition(tmp_path)
    rc = preflight_wip_cap.main(
        ["--project-root", str(tmp_path), "--quiet"]
    )
    captured = capsys.readouterr()
    assert rc == 0
    assert captured.out == ""


# ---------------------------------------------------------------------------
# task check aggregate wiring (deterministic content gate)
# ---------------------------------------------------------------------------


def test_taskfile_check_aggregate_wires_verify_wip_cap() -> None:
    """The framework's `task check` MUST depend on verify:wip-cap.

    The Taskfile entry is allowed to be either the direct `verify:wip-cap`
    target or the `verify-wip-cap-framework-self-check` shim that passes
    ``--allow-over-cap`` for landing-day grace. Either form fulfils the
    HANDOFF acceptance criterion ("`verify:wip-cap` (or similar pre-merge
    CI re-validation) into the `task check` aggregate").
    """
    taskfile = (_REPO_ROOT / "Taskfile.yml").read_text(encoding="utf-8")
    import re as _re

    # `task check` dispatches to `check:framework-source` in this repo; inspect
    # that aggregate so the acceptance test follows the context-aware split.
    after = taskfile.split("\n  check:framework-source:\n", 1)[1]
    next_sibling = _re.search(r"\n  [^\s][^\n]*:\n", after)
    check_block = after[: next_sibling.start()] if next_sibling else after
    assert (
        "verify-wip-cap-framework-self-check" in check_block
        or "verify:wip-cap" in check_block
    )
    # The shim itself must invoke the canonical task with --allow-over-cap.
    assert "--allow-over-cap" in taskfile
    assert "verify:wip-cap" in taskfile
