"""Tests for scripts/preflight_story_start.py (#1378 Story C).

Covers the deterministic story-start Gate 0 across the four contractually
required cases plus the surrounding edge matrix:

- dirty-tree -> exit 1 (not ready)
- missing-allocation-context / solo -> exit 0 (ready)
- valid swarm-cohort -> exit 0 (ready)
- invalid / malformed allocation-context -> exit 2 (config error)

Plus: swarm-cohort with null/missing consent token (exit 1), explicit
``dispatch_kind: solo`` (exit 0), vBRIEF-not-active/running (exit 1),
git-undeterminable (exit 2), ``--allow-dirty`` override, the
``parse_allocation_section`` parser unit, the ``--json`` schema, and the
``main()`` CLI plumbing (argparse + stderr redirect + envelope-file read).

Tests drive ``preflight_story_start.evaluate()`` directly (a pure function)
so the git working-tree state is injected as data rather than shelled out --
this avoids leaving real ``.git`` directories in pytest's ``tmp_path``
(Windows cleanup race #281), mirroring ``tests/cli/test_preflight_branch.py``.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT_PATH = REPO_ROOT / "scripts" / "preflight_story_start.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def preflight():
    return _load_module("preflight_story_start", PREFLIGHT_PATH)


# ---------------------------------------------------------------------------
# fixtures / builders
# ---------------------------------------------------------------------------

CLEAN_TREE = ""
DIRTY_TREE = " M scripts/foo.py\n?? scratch.txt\n"


def _write_vbrief(
    base: Path,
    folder: str = "active",
    *,
    status: str | None = "running",
    include_plan: bool = True,
    raw_override: str | None = None,
    name: str = "2026-06-01-story.vbrief.json",
) -> Path:
    """Write a minimal vBRIEF to ``<base>/vbrief/<folder>/<name>``."""
    folder_dir = base / "vbrief" / folder
    folder_dir.mkdir(parents=True, exist_ok=True)
    path = folder_dir / name
    if raw_override is not None:
        path.write_text(raw_override, encoding="utf-8")
        return path
    payload: dict[str, Any] = {"vBRIEFInfo": {"version": "0.6"}}
    if include_plan:
        plan: dict[str, Any] = {"title": "T", "items": []}
        if status is not None:
            plan["status"] = status
        payload["plan"] = plan
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _render_allocation(
    fields: dict[str, str | None],
    *,
    preamble: str = "Dispatch envelope for the story.",
) -> str:
    """Render a ``## Allocation context`` section as a dispatch envelope would.

    A field whose value is None is emitted as the literal ``null`` (the
    present-but-null shape); omit a key from ``fields`` to drop it entirely.
    A trailing ``## Next section`` proves the parser stops at the next heading.
    """
    lines = [preamble, "", "## Allocation context", ""]
    for key, value in fields.items():
        rendered = "null" if value is None else value
        lines.append(f"- {key}: {rendered}")
    lines.append("")
    lines.append("## Next section")
    lines.append("- trailing: ignored")
    return "\n".join(lines)


def _valid_cohort_fields() -> dict[str, str | None]:
    return {
        "dispatch_kind": "swarm-cohort",
        "allocation_plan_id": "orchestrator-run-019e80bd",
        "batching_rationale": "Three disjoint-file-scope stories from #1378.",
        "cohort_vbriefs": "[vbrief/active/a.json, vbrief/active/b.json]",
        "operator_approval_evidence": "user directive 2026-06-01T02:26Z",
    }


# ---------------------------------------------------------------------------
# The four contractually required cases
# ---------------------------------------------------------------------------


def test_dirty_tree_is_not_ready(preflight, tmp_path):
    """Case 1: a dirty working tree is not ready (exit 1)."""
    path = _write_vbrief(tmp_path)
    code, msg = preflight.evaluate(path, git_status=DIRTY_TREE)
    assert code == 1
    assert "dirty" in msg.lower()


def test_missing_allocation_context_solo_is_ready(preflight, tmp_path):
    """Case 2: no allocation-context section => solo path => ready (exit 0)."""
    path = _write_vbrief(tmp_path)
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE, allocation_context=None)
    assert code == 0
    assert "solo" in msg.lower()


def test_valid_cohort_is_ready(preflight, tmp_path):
    """Case 3: swarm-cohort with non-null plan_id + rationale => ready (exit 0)."""
    path = _write_vbrief(tmp_path)
    envelope = _render_allocation(_valid_cohort_fields())
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE, allocation_context=envelope)
    assert code == 0
    assert "swarm-cohort" in msg.lower()


def test_malformed_allocation_context_is_config_error(preflight, tmp_path):
    """Case 4: a section missing dispatch_kind is a config error (exit 2)."""
    path = _write_vbrief(tmp_path)
    fields = _valid_cohort_fields()
    del fields["dispatch_kind"]
    envelope = _render_allocation(fields)
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE, allocation_context=envelope)
    assert code == 2
    assert "dispatch_kind" in msg


def test_unrecognised_dispatch_kind_is_config_error(preflight, tmp_path):
    """An unknown dispatch_kind value is a config error (exit 2)."""
    path = _write_vbrief(tmp_path)
    fields = _valid_cohort_fields()
    fields["dispatch_kind"] = "bonus-round"
    envelope = _render_allocation(fields)
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE, allocation_context=envelope)
    assert code == 2
    assert "unrecognised dispatch_kind" in msg


# ---------------------------------------------------------------------------
# consent-token (exit 1) variants
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("null_field", ["allocation_plan_id", "batching_rationale"])
def test_swarm_cohort_null_consent_field_is_not_ready(preflight, tmp_path, null_field):
    """A swarm-cohort with a null plan_id/rationale is not ready (exit 1)."""
    path = _write_vbrief(tmp_path)
    fields = _valid_cohort_fields()
    fields[null_field] = None  # emitted as literal `null`
    envelope = _render_allocation(fields)
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE, allocation_context=envelope)
    assert code == 1
    assert null_field in msg
    assert "consent token" in msg.lower()


def test_swarm_cohort_missing_consent_field_is_not_ready(preflight, tmp_path):
    """A swarm-cohort with the plan_id key omitted entirely is not ready (exit 1)."""
    path = _write_vbrief(tmp_path)
    fields = _valid_cohort_fields()
    del fields["allocation_plan_id"]
    envelope = _render_allocation(fields)
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE, allocation_context=envelope)
    assert code == 1
    assert "allocation_plan_id" in msg


def test_explicit_solo_dispatch_is_ready(preflight, tmp_path):
    """dispatch_kind: solo is ready even with null cohort fields (exit 0)."""
    path = _write_vbrief(tmp_path)
    fields = {
        "dispatch_kind": "solo",
        "allocation_plan_id": None,
        "batching_rationale": None,
        "cohort_vbriefs": "[vbrief/active/only.json]",
        "operator_approval_evidence": "solo-interactive",
    }
    envelope = _render_allocation(fields)
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE, allocation_context=envelope)
    assert code == 0
    assert "solo" in msg.lower()


def test_section_absent_from_supplied_text_is_solo(preflight, tmp_path):
    """A supplied envelope WITHOUT the heading falls back to the solo path."""
    path = _write_vbrief(tmp_path)
    envelope = "Some dispatch prose with no allocation block at all.\n"
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE, allocation_context=envelope)
    assert code == 0
    assert "solo" in msg.lower()


# ---------------------------------------------------------------------------
# working-tree + vBRIEF preconditions
# ---------------------------------------------------------------------------


def test_allow_dirty_overrides_dirty_tree(preflight, tmp_path):
    """--allow-dirty lets a dirty tree through (the include-existing-work path)."""
    path = _write_vbrief(tmp_path)
    code, _ = preflight.evaluate(path, git_status=DIRTY_TREE, allow_dirty=True)
    assert code == 0


def test_git_undeterminable_is_config_error(preflight, tmp_path):
    """git_status None (git absent / not a repo) is a config error (exit 2)."""
    path = _write_vbrief(tmp_path)
    code, msg = preflight.evaluate(path, git_status=None)
    assert code == 2
    assert "working-tree state" in msg


def test_vbrief_in_pending_is_not_ready(preflight, tmp_path):
    """A target vBRIEF outside active/ is not ready (exit 1)."""
    path = _write_vbrief(tmp_path, folder="pending", status="running")
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE)
    assert code == 1
    assert "pending/" in msg


def test_vbrief_not_running_is_not_ready(preflight, tmp_path):
    """An active/ vBRIEF that is not running is not ready (exit 1)."""
    path = _write_vbrief(tmp_path, folder="active", status="approved")
    code, msg = preflight.evaluate(path, git_status=CLEAN_TREE)
    assert code == 1
    assert "running" in msg


def test_missing_vbrief_is_not_ready(preflight, tmp_path):
    """A nonexistent target vBRIEF is not ready (exit 1)."""
    missing = tmp_path / "vbrief" / "active" / "nope.vbrief.json"
    code, msg = preflight.evaluate(missing, git_status=CLEAN_TREE)
    assert code == 1
    assert "not found" in msg


def test_dirty_tree_checked_before_vbrief(preflight, tmp_path):
    """The working-tree gate (a) fires ahead of the vBRIEF gate (b)."""
    missing = tmp_path / "vbrief" / "active" / "nope.vbrief.json"
    code, msg = preflight.evaluate(missing, git_status=DIRTY_TREE)
    assert code == 1
    assert "dirty" in msg.lower()


# ---------------------------------------------------------------------------
# parse_allocation_section parser unit
# ---------------------------------------------------------------------------


def test_parser_returns_false_when_no_heading(preflight):
    found, fields = preflight.parse_allocation_section("no heading here")
    assert found is False
    assert fields == {}


def test_parser_returns_false_on_none(preflight):
    found, fields = preflight.parse_allocation_section(None)
    assert found is False
    assert fields == {}


def test_parser_extracts_fields_and_normalises_null(preflight):
    text = _render_allocation(
        {
            "dispatch_kind": "swarm-cohort",
            "allocation_plan_id": None,
            "batching_rationale": "why",
        }
    )
    found, fields = preflight.parse_allocation_section(text)
    assert found is True
    assert fields["dispatch_kind"] == "swarm-cohort"
    assert fields["allocation_plan_id"] is None
    assert fields["batching_rationale"] == "why"
    # The trailing "## Next section" bullet must NOT leak into the fields.
    assert "trailing" not in fields


def test_parser_strips_backticked_values(preflight):
    text = "## Allocation context\n- dispatch_kind: `swarm-cohort`\n"
    found, fields = preflight.parse_allocation_section(text)
    assert found is True
    assert fields["dispatch_kind"] == "swarm-cohort"


# ---------------------------------------------------------------------------
# --json schema
# ---------------------------------------------------------------------------


def test_json_emit_ready_schema(preflight, tmp_path, monkeypatch, capsys):
    path = _write_vbrief(tmp_path)
    monkeypatch.setattr(preflight, "_git_porcelain", lambda _root: CLEAN_TREE)
    code = preflight.main(["--vbrief-path", str(path), "--project-root", str(tmp_path), "--json"])
    out = capsys.readouterr().out.strip()
    assert code == 0
    payload = json.loads(out)
    assert set(payload.keys()) == {
        "ready",
        "exit_code",
        "vbrief_path",
        "dispatch_kind",
        "message",
    }
    assert payload["ready"] is True
    assert payload["exit_code"] == 0
    assert payload["dispatch_kind"] is None  # no envelope -> solo


def test_json_emit_cohort_reports_dispatch_kind(preflight, tmp_path, monkeypatch, capsys):
    path = _write_vbrief(tmp_path)
    envelope_file = tmp_path / "envelope.md"
    envelope_file.write_text(_render_allocation(_valid_cohort_fields()), encoding="utf-8")
    monkeypatch.setattr(preflight, "_git_porcelain", lambda _root: CLEAN_TREE)
    code = preflight.main(
        [
            "--vbrief-path",
            str(path),
            "--project-root",
            str(tmp_path),
            "--allocation-context",
            str(envelope_file),
            "--json",
        ]
    )
    out = capsys.readouterr().out.strip()
    assert code == 0
    payload = json.loads(out)
    assert payload["dispatch_kind"] == "swarm-cohort"


# ---------------------------------------------------------------------------
# main() / argparse plumbing
# ---------------------------------------------------------------------------


def test_main_ready_prints_to_stdout(preflight, tmp_path, monkeypatch, capsys):
    path = _write_vbrief(tmp_path)
    monkeypatch.setattr(preflight, "_git_porcelain", lambda _root: CLEAN_TREE)
    code = preflight.main(["--vbrief-path", str(path), "--project-root", str(tmp_path)])
    out = capsys.readouterr()
    assert code == 0
    assert "OK" in out.out
    assert out.err == ""


def test_main_not_ready_prints_to_stderr(preflight, tmp_path, monkeypatch, capsys):
    path = _write_vbrief(tmp_path)
    monkeypatch.setattr(preflight, "_git_porcelain", lambda _root: DIRTY_TREE)
    code = preflight.main(["--vbrief-path", str(path), "--project-root", str(tmp_path)])
    out = capsys.readouterr()
    assert code == 1
    assert "dirty" in out.err.lower()
    assert out.out == ""


def test_main_unreadable_envelope_is_config_error(preflight, tmp_path, monkeypatch, capsys):
    path = _write_vbrief(tmp_path)
    monkeypatch.setattr(preflight, "_git_porcelain", lambda _root: CLEAN_TREE)
    missing_envelope = tmp_path / "does-not-exist.md"
    code = preflight.main(
        [
            "--vbrief-path",
            str(path),
            "--project-root",
            str(tmp_path),
            "--allocation-context",
            str(missing_envelope),
        ]
    )
    out = capsys.readouterr()
    assert code == 2
    assert "could not read --allocation-context" in out.err


def test_main_missing_required_arg_exits_2(preflight):
    """argparse exits 2 when --vbrief-path is missing (CLI contract)."""
    with pytest.raises(SystemExit) as excinfo:
        preflight.main([])
    assert excinfo.value.code == 2


def test_main_help_exits_0(preflight):
    """`--help` short-circuits before the required-arg check (exit 0)."""
    with pytest.raises(SystemExit) as excinfo:
        preflight.main(["--help"])
    assert excinfo.value.code == 0


# ---------------------------------------------------------------------------
# contract documentation guard
# ---------------------------------------------------------------------------


def test_module_documents_three_state_contract(preflight):
    doc = preflight.__doc__ or ""
    assert "Gate 0" in doc
    assert "## Allocation context" in doc
    assert "#1378" in doc
    assert "#1371" in doc
