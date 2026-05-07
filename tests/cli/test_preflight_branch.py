"""Tests for scripts/preflight_branch.py (#747).

Covers the detection-bound branch-protection gate's exit-code states:

- exit 0 -- feature branch, detached HEAD, opted-out, env-var bypass, or
  setup-interview exemption.
- exit 1 -- on default branch and policy says no.
- exit 2 -- PROJECT-DEFINITION missing AND no bootstrap flag.

Tests drive :func:`preflight_branch.evaluate` directly (pure function) so
we don't shell out to git in pytest's tmp_path. ``preflight_branch._git`` is
monkeypatched per test to return a deterministic branch state -- this is
important on Windows where leaving real ``.git`` directories in pytest's
``tmp_path`` causes downstream cleanup race conditions (#281).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT_PATH = REPO_ROOT / "scripts" / "preflight_branch.py"
POLICY_PATH = REPO_ROOT / "scripts" / "policy.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def preflight():
    # policy must be importable as a sibling module first.
    _load_module("policy", POLICY_PATH)
    return _load_module("preflight_branch", PREFLIGHT_PATH)


def _write_project_def(project_root: Path, plan: dict) -> Path:
    (project_root / "vbrief").mkdir(exist_ok=True)
    path = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {"title": "T", "status": "running", "items": [], **plan},
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _stub_branch(monkeypatch, preflight, branch: str, *, detached: bool = False) -> None:
    """Replace ``preflight._current_branch`` with a deterministic stub.

    Avoids pytest tmp_path .git pollution on Windows (#281).
    """

    def fake_current_branch(_root: Path) -> tuple[str, bool]:  # noqa: ARG001
        return ("" if detached else branch, detached)

    monkeypatch.setattr(preflight, "_current_branch", fake_current_branch)


def _git_init(project_root: Path, branch: str) -> None:
    """Compatibility shim for tests that still want a real shape on disk.

    Currently a no-op -- the new tests use ``_stub_branch`` instead. Kept
    so any future test that genuinely needs a real ``.git`` can opt in
    without re-importing subprocess.
    """
    return


def test_feature_branch_passes(preflight, tmp_path, monkeypatch):
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "feat/my-work")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": False}})
    code, msg = preflight.evaluate(tmp_path)
    assert code == 0
    assert "feature branch" in msg


def test_master_with_typed_opt_out_passes(preflight, tmp_path, monkeypatch):
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "master")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": True}})
    code, msg = preflight.evaluate(tmp_path)
    assert code == 0
    assert "policy allows it" in msg


def test_master_default_fail_closed_blocks(preflight, tmp_path, monkeypatch):
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "master")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": False}})
    code, msg = preflight.evaluate(tmp_path)
    assert code == 1
    assert "refusing to commit/push" in msg
    assert "feature branch" in msg


def test_main_branch_also_blocks(preflight, tmp_path, monkeypatch):
    """Both `master` and `main` are default branches."""
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "main")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": False}})
    code, _ = preflight.evaluate(tmp_path)
    assert code == 1


def test_detached_head_passes(preflight, tmp_path, monkeypatch):
    """Detached HEAD is never gated."""
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "", detached=True)
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": False}})
    code, msg = preflight.evaluate(tmp_path)
    assert code == 0
    assert "detached HEAD" in msg


def test_env_bypass_overrides_policy(preflight, tmp_path, monkeypatch):
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    _stub_branch(monkeypatch, preflight, "master")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": False}})
    monkeypatch.setenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", "1")
    code, msg = preflight.evaluate(tmp_path)
    assert code == 0
    assert "policy allows it" in msg


def test_setup_exemption_passes_without_policy_lookup(preflight, tmp_path, monkeypatch):
    """The setup-interview exemption skips the policy lookup entirely."""
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    # Intentionally NO PROJECT-DEFINITION written; exemption short-circuits.
    monkeypatch.setenv(preflight.ENV_SETUP_EXEMPTION, "1")
    code, msg = preflight.evaluate(tmp_path)
    assert code == 0
    assert "setup-interview exemption" in msg


def test_missing_project_def_default_returns_config_error(preflight, tmp_path, monkeypatch):
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "master")
    code, msg = preflight.evaluate(tmp_path)
    assert code == 2
    # The fix-aware message says "cannot be resolved" with the underlying
    # "not found" detail surfaced separately.
    assert "cannot be resolved" in msg
    assert "not found" in msg
    assert "task setup" in msg


def test_missing_project_def_with_bootstrap_flag_passes(preflight, tmp_path, monkeypatch):
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "master")
    code, msg = preflight.evaluate(tmp_path, allow_missing_project_definition=True)
    assert code == 0
    assert "bootstrap state" in msg


def test_legacy_narrative_with_deprecation_warning(preflight, tmp_path, monkeypatch):
    """Legacy narrative `Allow direct commits to master: true` honored, with warning."""
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "master")
    _write_project_def(
        tmp_path, {"narratives": {"Allow direct commits to master": "true"}}
    )
    code, msg = preflight.evaluate(tmp_path)
    assert code == 0  # Allowed via legacy narrative.
    # Warning surfaces when policy=ON and there's a legacy fallback. Here policy
    # says allow, so the OK message includes the disclosure_line. Check at least
    # source attribution surfaces somewhere.
    assert "legacy-narrative" in msg or "policy allows it" in msg


def test_main_default_path_uses_cwd(preflight, tmp_path, monkeypatch):
    """`main` resolves --project-root or cwd; smoke test."""
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "feat/x")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": False}})
    code = preflight.main(["--project-root", str(tmp_path), "--quiet"])
    assert code == 0


def test_main_blocked_path_returns_1(preflight, tmp_path, capsys, monkeypatch):
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "master")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": False}})
    code = preflight.main(["--project-root", str(tmp_path)])
    err = capsys.readouterr().err
    assert code == 1
    assert "refusing" in err


def test_custom_default_branch_list(preflight, tmp_path, monkeypatch):
    """Custom default-branch list (e.g. trunk) blocks on that branch."""
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "trunk")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": False}})
    code, _ = preflight.evaluate(tmp_path, default_branches=frozenset({"trunk"}))
    assert code == 1


# ---------------------------------------------------------------------------
# Greptile P1 + P2 review fixes (#777)
# ---------------------------------------------------------------------------


def test_malformed_typed_field_returns_config_error(preflight, tmp_path, monkeypatch):
    """Non-bool ``allowDirectCommitsToMaster`` MUST exit 2 (Greptile P1 #777).

    Previously the gate misclassified malformed configs (typed field set to
    a string, etc.) as exit 1 (policy block) with misleading recovery
    guidance. The fix broadens the config-error branch beyond the
    ``"not found" in error`` check.
    """
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "master")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": "yes"}})
    code, msg = preflight.evaluate(tmp_path)
    assert code == 2
    assert "PROJECT-DEFINITION cannot be resolved" in msg
    assert "must be a boolean" in msg
    # Recovery message tailored for malformed-config (NOT "run task setup").
    assert "malformed PROJECT-DEFINITION" in msg


def test_malformed_typed_field_with_bootstrap_flag_still_exits_2(
    preflight, tmp_path, monkeypatch
):
    """`--allow-missing-project-definition` only short-circuits missing-file (Greptile P1 #777).

    Malformed-config errors still exit 2 even with the bootstrap flag --
    the operator MUST fix the malformed file before the gate can pass.
    """
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)
    _stub_branch(monkeypatch, preflight, "master")
    _write_project_def(tmp_path, {"policy": {"allowDirectCommitsToMaster": 42}})
    code, msg = preflight.evaluate(tmp_path, allow_missing_project_definition=True)
    assert code == 2
    assert "must be a boolean" in msg


def test_git_not_found_returns_config_error(preflight, tmp_path, monkeypatch):
    """Missing ``git`` on PATH MUST exit 2 (Greptile P2 #777).

    Previously this was silently treated as a detached HEAD and the gate
    passed (exit 0). The fix raises :class:`GitNotFoundError` from
    ``_current_branch`` and surfaces an actionable recovery message.
    """
    monkeypatch.delenv(preflight.ENV_SETUP_EXEMPTION, raising=False)
    monkeypatch.delenv("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT", raising=False)

    def fake_git(_args, _root):
        return 127, "", "git executable not found on PATH"

    monkeypatch.setattr(preflight, "_git", fake_git)
    code, msg = preflight.evaluate(tmp_path)
    assert code == 2
    assert "cannot determine current branch" in msg
    assert "install git" in msg
