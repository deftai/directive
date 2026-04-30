"""Content tests for the detection-bound branch gate (#747).

Asserts the surfaces around `scripts/preflight_branch.py` exist and
reference each other consistently:

- ``.githooks/pre-commit`` and ``.githooks/pre-push`` exist and call the
  preflight script.
- ``Taskfile.yml`` aggregate ``check`` task includes ``verify:branch``.
- ``tasks/verify.yml`` declares ``branch`` and ``hooks-installed`` tasks.
- ``tasks/policy.yml`` declares the policy:* surface.
- ``.github/workflows/branch-gate.yml`` rejects ``head_ref == base_ref``.
- AGENTS.md and main.md reference the policy + enforcement surfaces.
- README.md has the Branch policy section.
- ``Taskfile.yml`` has a top-level ``setup`` task that sets
  ``core.hooksPath`` idempotently.

Pure content-string assertions -- no subprocess, no go-task dispatch.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(rel: str) -> str:
    return (REPO_ROOT / rel).read_text(encoding="utf-8")


def test_pre_commit_hook_exists_and_calls_script():
    text = _read(".githooks/pre-commit")
    assert "scripts/preflight_branch.py" in text
    assert "git rev-parse --show-toplevel" in text


def test_pre_push_hook_exists_and_calls_script():
    text = _read(".githooks/pre-push")
    assert "scripts/preflight_branch.py" in text


def test_taskfile_check_includes_verify_branch():
    text = _read("Taskfile.yml")
    # The aggregate check task must depend on verify:branch.
    assert "verify:branch" in text


def test_taskfile_has_setup_task_for_hooks_path():
    text = _read("Taskfile.yml")
    # task setup configures core.hooksPath idempotently.
    assert "core.hooksPath" in text
    assert ".githooks" in text


def test_taskfile_includes_policy_yml():
    text = _read("Taskfile.yml")
    assert "./tasks/policy.yml" in text


def test_verify_yml_declares_branch_and_hooks_installed():
    text = _read("tasks/verify.yml")
    assert "branch:" in text
    assert "hooks-installed:" in text
    assert "preflight_branch.py" in text
    assert "core.hooksPath" in text


def test_policy_yml_declares_show_enforce_allow():
    text = _read("tasks/policy.yml")
    assert "show:" in text
    assert "enforce-branches:" in text
    assert "allow-direct-commits:" in text
    assert "scripts/policy.py" in text
    assert "scripts/policy_set.py" in text


def test_branch_gate_workflow_rejects_head_eq_base():
    text = _read(".github/workflows/branch-gate.yml")
    assert "branch-gate" in text
    assert "head_ref" in text
    assert "base_ref" in text
    # The refusal step must compare and exit 1.
    assert "exit 1" in text
    assert 'pull_request:' in text


def test_agents_md_disclosure_block_present():
    text = _read("AGENTS.md")
    assert "Branch Policy Disclosure" in text
    assert "allowDirectCommitsToMaster" in text
    assert "DEFT_ALLOW_DEFAULT_BRANCH_COMMIT" in text


def test_agents_md_branching_cross_references_enforcement_surfaces():
    text = _read("AGENTS.md")
    # The Branching section must cite all three enforcement surfaces.
    assert "verify:branch" in text
    assert "branch-gate" in text
    assert ".githooks/pre-commit" in text


def test_main_md_branching_rule_cites_policy_and_typed_flag():
    text = _read("main.md")
    assert "allowDirectCommitsToMaster" in text
    assert "#746" in text
    assert "#747" in text
    assert "deterministic-questions.md" in text


def test_readme_has_branch_policy_section():
    text = _read("README.md")
    assert "Branch policy" in text
    assert "allowDirectCommitsToMaster" in text
    assert "task policy:show" in text
    assert "task policy:enforce-branches" in text
    assert "task policy:allow-direct-commits" in text


def test_schema_declares_policy_definition():
    text = _read("vbrief/schemas/vbrief-core.schema.json")
    assert "\"Policy\":" in text
    assert "\"allowDirectCommitsToMaster\":" in text
    # Policy is referenced from the Plan definition.
    assert '"$ref": "#/$defs/Policy"' in text
