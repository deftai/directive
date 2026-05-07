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
