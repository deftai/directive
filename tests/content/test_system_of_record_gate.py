"""Content contract for the system-of-record architecture gate."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(rel_path: str) -> str:
    return (REPO_ROOT / rel_path).read_text(encoding="utf-8")


def test_system_of_record_docs_define_classifications() -> None:
    text = _read("docs/system-of-record-gate.md")
    for token in (
        "durable_product_state",
        "auth_session_state",
        "authorization_state",
        "audit_event_state",
        "external_integration_state",
        "canonical_artifact",
        "cache",
        "projection",
        "import_export_artifact",
        "dev_only_fixture",
        "ephemeral_ui_state",
    ):
        assert token in text
    assert "task architecture:sor-preflight" in text
    assert "task verify:architecture-sor" in text


def test_taskfile_surfaces_system_of_record_gate() -> None:
    taskfile = _read("Taskfile.yml")
    architecture_tasks = _read("tasks/architecture.yml")
    verify_tasks = _read("tasks/verify.yml")
    assert "tasks/architecture.yml" in taskfile
    assert "sor-preflight" in architecture_tasks
    assert "preflight_architecture_sor.py" in architecture_tasks
    assert "architecture-sor" in verify_tasks
    assert "preflight_architecture_sor.py" in verify_tasks


# NOTE: the AGENTS.md / templates/agents-entry.md / build-skill wiring assertion
# (test_agents_and_build_skill_require_system_of_record_gate) intentionally lives
# with the deferred mandatory-wiring change, not this advisory core PR. The gate
# ships here as opt-in task targets only; promoting it into the agent flow is
# tracked by the follow-up RFC. See CHANGELOG [Unreleased] and PR #1481.
