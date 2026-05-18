"""Tests for the consolidated typed-policy inspector (#1148 / N8).

Covers:

* :func:`policy.inspect_all_policies` -- enumerates every registered
  typed-policy field with the right ``source`` per state.
* Per-field inspection matrix (default / typed / legacy for the
  branch policy; default / typed for the six other fields).
* JSON envelope schema stability via :mod:`_policy_show_cli`.
* CLI flag matrix: ``--format=text|json``, ``--changed-only``,
  ``--field=<name>``, ``--project-root``.
* Error matrix: missing PROJECT-DEFINITION renders defaults gracefully
  (exit 0); unknown ``--field=<name>`` exits 2.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"


def _load_module(name: str, path: Path):
    """Load a sibling scripts module via importlib so test isolation holds."""
    # Make the scripts/ dir importable for sibling imports inside the loaded
    # module (e.g. `_policy_show_cli` -> `import policy`).
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def policy_module():
    return _load_module("policy", SCRIPTS_DIR / "policy.py")


@pytest.fixture()
def cli_module(policy_module):  # noqa: ARG001 -- ensures `policy` is loaded first
    return _load_module("_policy_show_cli", SCRIPTS_DIR / "_policy_show_cli.py")


@pytest.fixture()
def project_root(tmp_path: Path) -> Path:
    (tmp_path / "vbrief").mkdir()
    return tmp_path


def _write_project_def(project_root: Path, plan: dict[str, Any]) -> Path:
    path = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {"title": "T", "status": "running", "items": [], **plan},
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# inspect_all_policies -- full default state
# ---------------------------------------------------------------------------


def test_inspect_all_policies_returns_seven_fields(policy_module, project_root):
    """Every registered field surfaces in the inspector output."""
    _write_project_def(project_root, {})
    fields = policy_module.inspect_all_policies(project_root)
    names = [f.name for f in fields]
    assert names == [
        "plan.policy.allowDirectCommitsToMaster",
        "plan.policy.wipCap",
        "plan.policy.triageScope",
        "plan.policy.triageScopeIgnores",
        "plan.policy.triageRankingLabels",
        "plan.policy.triageAutoClassify",
        "plan.policy.triageHoldMarkers",
    ]
    # Every row at default when PROJECT-DEFINITION carries no policy block.
    assert all(f.source == "default" for f in fields)


def test_inspect_all_policies_missing_project_definition_renders_defaults(
    policy_module, tmp_path
):
    """Missing PROJECT-DEFINITION yields every default-source row."""
    # tmp_path has no vbrief/ subtree.
    fields = policy_module.inspect_all_policies(tmp_path)
    assert len(fields) == 7
    assert all(f.source == "default" for f in fields)


def test_registered_policy_names_matches_inspectors(policy_module):
    """``registered_policy_names`` mirrors the registry order exactly."""
    names = policy_module.registered_policy_names()
    assert names == [
        "plan.policy.allowDirectCommitsToMaster",
        "plan.policy.wipCap",
        "plan.policy.triageScope",
        "plan.policy.triageScopeIgnores",
        "plan.policy.triageRankingLabels",
        "plan.policy.triageAutoClassify",
        "plan.policy.triageHoldMarkers",
    ]


# ---------------------------------------------------------------------------
# allowDirectCommitsToMaster (#746) -- default / typed / legacy
# ---------------------------------------------------------------------------


def test_inspect_allow_direct_commits_default(policy_module, project_root):
    _write_project_def(project_root, {})
    field = policy_module.inspect_one_policy(
        "plan.policy.allowDirectCommitsToMaster", project_root
    )
    assert field is not None
    assert field.current is False
    assert field.default is False
    assert field.source == "default"


def test_inspect_allow_direct_commits_typed_true(policy_module, project_root):
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": True}})
    field = policy_module.inspect_one_policy(
        "plan.policy.allowDirectCommitsToMaster", project_root
    )
    assert field is not None
    assert field.current is True
    assert field.source == "typed"


def test_inspect_allow_direct_commits_typed_false(policy_module, project_root):
    _write_project_def(project_root, {"policy": {"allowDirectCommitsToMaster": False}})
    field = policy_module.inspect_one_policy(
        "plan.policy.allowDirectCommitsToMaster", project_root
    )
    assert field is not None
    assert field.current is False
    assert field.source == "typed"


def test_inspect_allow_direct_commits_legacy_narrative(policy_module, project_root):
    """Legacy narrative key is recognised when the typed key is absent."""
    _write_project_def(
        project_root,
        {"narratives": {"Allow direct commits to master": "true"}},
    )
    field = policy_module.inspect_one_policy(
        "plan.policy.allowDirectCommitsToMaster", project_root
    )
    assert field is not None
    assert field.current is True
    assert field.source == "legacy"


def test_inspect_allow_direct_commits_typed_overrides_legacy(
    policy_module, project_root
):
    """Typed flag wins when both are present."""
    _write_project_def(
        project_root,
        {
            "policy": {"allowDirectCommitsToMaster": False},
            "narratives": {"Allow direct commits to master": "true"},
        },
    )
    field = policy_module.inspect_one_policy(
        "plan.policy.allowDirectCommitsToMaster", project_root
    )
    assert field is not None
    assert field.current is False
    assert field.source == "typed"


# ---------------------------------------------------------------------------
# wipCap (#1124) -- default / typed / typed-but-malformed
# ---------------------------------------------------------------------------


def test_inspect_wip_cap_default(policy_module, project_root):
    _write_project_def(project_root, {})
    field = policy_module.inspect_one_policy("plan.policy.wipCap", project_root)
    assert field is not None
    assert field.current == policy_module.DEFAULT_WIP_CAP == 10
    assert field.source == "default"


def test_inspect_wip_cap_typed_value(policy_module, project_root):
    _write_project_def(project_root, {"policy": {"wipCap": 8}})
    field = policy_module.inspect_one_policy("plan.policy.wipCap", project_root)
    assert field is not None
    assert field.current == 8
    assert field.default == 10
    assert field.source == "typed"


def test_inspect_wip_cap_typed_zero(policy_module, project_root):
    """``wipCap = 0`` is a legitimate operator state (freezes promotion)."""
    _write_project_def(project_root, {"policy": {"wipCap": 0}})
    field = policy_module.inspect_one_policy("plan.policy.wipCap", project_root)
    assert field is not None
    assert field.current == 0
    assert field.source == "typed"


def test_inspect_wip_cap_malformed_falls_back_to_default(policy_module, project_root):
    """Malformed wipCap still surfaces as typed source (operator set it)."""
    _write_project_def(project_root, {"policy": {"wipCap": "twelve"}})
    field = policy_module.inspect_one_policy("plan.policy.wipCap", project_root)
    assert field is not None
    assert field.current == 10
    assert field.source == "typed"


# ---------------------------------------------------------------------------
# triageScope (#1131) -- default / typed (non-empty) / typed (empty == default)
# ---------------------------------------------------------------------------


def test_inspect_triage_scope_default(policy_module, project_root):
    _write_project_def(project_root, {})
    field = policy_module.inspect_one_policy("plan.policy.triageScope", project_root)
    assert field is not None
    assert field.current == [{"rule": "all-open"}]
    assert field.default == [{"rule": "all-open"}]
    assert field.source == "default"


def test_inspect_triage_scope_typed(policy_module, project_root):
    rules = [{"rule": "labels", "any-of": ["urgent"]}]
    _write_project_def(project_root, {"policy": {"triageScope": rules}})
    field = policy_module.inspect_one_policy("plan.policy.triageScope", project_root)
    assert field is not None
    assert field.current == rules
    assert field.source == "typed"


def test_inspect_triage_scope_empty_list_is_default(policy_module, project_root):
    """Empty list mirrors the resolver: falls back to ``[{rule: all-open}]``."""
    _write_project_def(project_root, {"policy": {"triageScope": []}})
    field = policy_module.inspect_one_policy("plan.policy.triageScope", project_root)
    assert field is not None
    assert field.current == [{"rule": "all-open"}]
    assert field.source == "default"


# ---------------------------------------------------------------------------
# triageScopeIgnores (#1133 / #1182), triageRankingLabels (#1128),
# triageAutoClassify (#1129) -- the empty-list-is-default trio
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("field_name", "policy_key"),
    [
        ("plan.policy.triageScopeIgnores", "triageScopeIgnores"),
        ("plan.policy.triageRankingLabels", "triageRankingLabels"),
        ("plan.policy.triageAutoClassify", "triageAutoClassify"),
    ],
)
def test_empty_list_fields_default_when_unset(
    policy_module, project_root, field_name, policy_key
):
    _write_project_def(project_root, {})
    field = policy_module.inspect_one_policy(field_name, project_root)
    assert field is not None
    assert field.current == []
    assert field.default == []
    assert field.source == "default"


@pytest.mark.parametrize(
    ("field_name", "policy_key", "typed_value"),
    [
        (
            "plan.policy.triageScopeIgnores",
            "triageScopeIgnores",
            [{"label": "wontfix"}],
        ),
        (
            "plan.policy.triageRankingLabels",
            "triageRankingLabels",
            ["urgent", "p0"],
        ),
        (
            "plan.policy.triageAutoClassify",
            "triageAutoClassify",
            [{"match": {"state": "closed"}, "action": "archive", "reason": "closed"}],
        ),
    ],
)
def test_empty_list_fields_typed_when_set(
    policy_module, project_root, field_name, policy_key, typed_value
):
    _write_project_def(project_root, {"policy": {policy_key: typed_value}})
    field = policy_module.inspect_one_policy(field_name, project_root)
    assert field is not None
    assert field.current == typed_value
    assert field.source == "typed"


# ---------------------------------------------------------------------------
# triageHoldMarkers (#1129 Decision 3) -- empty-list-is-typed semantics
# ---------------------------------------------------------------------------


def test_inspect_triage_hold_markers_default(policy_module, project_root):
    _write_project_def(project_root, {})
    field = policy_module.inspect_one_policy(
        "plan.policy.triageHoldMarkers", project_root
    )
    assert field is not None
    # The default is the four universal hold phrases from #1129.
    assert "do not implement" in field.current
    assert "BLOCKED" in field.current
    assert field.source == "default"


def test_inspect_triage_hold_markers_typed_non_empty(policy_module, project_root):
    _write_project_def(
        project_root, {"policy": {"triageHoldMarkers": ["WAITING", "PAUSE"]}}
    )
    field = policy_module.inspect_one_policy(
        "plan.policy.triageHoldMarkers", project_root
    )
    assert field is not None
    assert field.current == ["WAITING", "PAUSE"]
    assert field.source == "typed"


def test_inspect_triage_hold_markers_typed_empty_is_typed(policy_module, project_root):
    """Explicit empty list = operator opt-out; surfaced as ``typed``."""
    _write_project_def(project_root, {"policy": {"triageHoldMarkers": []}})
    field = policy_module.inspect_one_policy(
        "plan.policy.triageHoldMarkers", project_root
    )
    assert field is not None
    assert field.current == []
    assert field.source == "typed"


# ---------------------------------------------------------------------------
# CLI: --format=text + --format=json + JSON schema stability
# ---------------------------------------------------------------------------


def _run_cli(cli_module, argv: list[str]) -> tuple[int, str, str]:
    out = io.StringIO()
    err = io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli_module.main(argv)
    return rc, out.getvalue(), err.getvalue()


def test_cli_text_format_renders_every_field(cli_module, project_root):
    _write_project_def(project_root, {})
    rc, out, _err = _run_cli(cli_module, ["--project-root", str(project_root)])
    assert rc == 0
    # Header for every registered field appears in default rendering.
    for name in (
        "plan.policy.allowDirectCommitsToMaster",
        "plan.policy.wipCap",
        "plan.policy.triageScope",
        "plan.policy.triageScopeIgnores",
        "plan.policy.triageRankingLabels",
        "plan.policy.triageAutoClassify",
        "plan.policy.triageHoldMarkers",
    ):
        assert f"[policy] {name}" in out
    # Default source surfaced for every row.
    assert out.count("source:  default") == 7


def test_cli_json_format_schema_stability(cli_module, project_root):
    _write_project_def(project_root, {"policy": {"wipCap": 12}})
    rc, out, _err = _run_cli(
        cli_module, ["--format=json", "--project-root", str(project_root)]
    )
    assert rc == 0
    envelope = json.loads(out)
    assert set(envelope.keys()) == {"generated_at", "fields"}
    assert envelope["generated_at"].endswith("Z")
    assert isinstance(envelope["fields"], list)
    assert len(envelope["fields"]) == 7
    # Each row carries the contracted four keys in order.
    for row in envelope["fields"]:
        assert list(row.keys()) == ["name", "current", "default", "source"]
    # wipCap row reflects the typed value.
    wip = next(r for r in envelope["fields"] if r["name"] == "plan.policy.wipCap")
    assert wip["current"] == 12
    assert wip["source"] == "typed"


def test_cli_json_format_unicode_round_trips_without_escape(cli_module, project_root):
    """``ensure_ascii=False`` -- non-ASCII operator values survive verbatim."""
    _write_project_def(
        project_root,
        {"policy": {"triageRankingLabels": ["urgent-\u2014-critical"]}},
    )
    rc, out, _err = _run_cli(
        cli_module, ["--format=json", "--project-root", str(project_root)]
    )
    assert rc == 0
    assert "urgent-\u2014-critical" in out


# ---------------------------------------------------------------------------
# CLI: --changed-only
# ---------------------------------------------------------------------------


def test_cli_changed_only_drops_default_rows(cli_module, project_root):
    _write_project_def(project_root, {"policy": {"wipCap": 7}})
    rc, out, _err = _run_cli(
        cli_module, ["--changed-only", "--project-root", str(project_root)]
    )
    assert rc == 0
    # Only the wipCap field (the typed one) should render.
    assert "[policy] plan.policy.wipCap" in out
    assert "plan.policy.triageScope" not in out
    assert "plan.policy.allowDirectCommitsToMaster" not in out


def test_cli_changed_only_empty_renders_informational_line(cli_module, project_root):
    """All-defaults + ``--changed-only`` shows the helpful informational line."""
    _write_project_def(project_root, {})
    rc, out, _err = _run_cli(
        cli_module, ["--changed-only", "--project-root", str(project_root)]
    )
    assert rc == 0
    assert "no fields changed" in out
    assert "framework defaults" in out


def test_cli_changed_only_json_emits_empty_array_when_all_default(
    cli_module, project_root
):
    _write_project_def(project_root, {})
    rc, out, _err = _run_cli(
        cli_module,
        ["--changed-only", "--format=json", "--project-root", str(project_root)],
    )
    assert rc == 0
    envelope = json.loads(out)
    assert envelope["fields"] == []


def test_cli_changed_only_keeps_legacy_source(cli_module, project_root):
    """Legacy narrative key qualifies as a changed surface."""
    _write_project_def(
        project_root,
        {"narratives": {"Allow direct commits to master": "true"}},
    )
    rc, out, _err = _run_cli(
        cli_module, ["--changed-only", "--project-root", str(project_root)]
    )
    assert rc == 0
    assert "plan.policy.allowDirectCommitsToMaster" in out
    assert "source:  legacy" in out


# ---------------------------------------------------------------------------
# CLI: --field=<name>
# ---------------------------------------------------------------------------


def test_cli_field_isolates_one_row(cli_module, project_root):
    _write_project_def(project_root, {"policy": {"wipCap": 9}})
    rc, out, _err = _run_cli(
        cli_module,
        ["--field=plan.policy.wipCap", "--project-root", str(project_root)],
    )
    assert rc == 0
    assert "plan.policy.wipCap" in out
    assert "plan.policy.triageScope" not in out
    assert "plan.policy.allowDirectCommitsToMaster" not in out


def test_cli_field_json_isolates_one_row(cli_module, project_root):
    _write_project_def(project_root, {})
    rc, out, _err = _run_cli(
        cli_module,
        [
            "--field=plan.policy.triageScope",
            "--format=json",
            "--project-root",
            str(project_root),
        ],
    )
    assert rc == 0
    envelope = json.loads(out)
    assert len(envelope["fields"]) == 1
    assert envelope["fields"][0]["name"] == "plan.policy.triageScope"


def test_cli_field_unknown_exits_2(cli_module, project_root):
    _write_project_def(project_root, {})
    rc, out, err = _run_cli(
        cli_module,
        [
            "--field=plan.policy.nonExistentField",
            "--project-root",
            str(project_root),
        ],
    )
    assert rc == 2
    assert "unknown --field" in err
    # The error message names every registered field so the operator can
    # discover the correct spelling.
    assert "plan.policy.wipCap" in err


# ---------------------------------------------------------------------------
# CLI: missing PROJECT-DEFINITION
# ---------------------------------------------------------------------------


def test_cli_missing_project_definition_exits_zero_with_stderr_note(
    cli_module, tmp_path
):
    rc, out, err = _run_cli(cli_module, ["--project-root", str(tmp_path)])
    assert rc == 0
    # All seven rows still render with default sources.
    assert out.count("source:  default") == 7
    assert "PROJECT-DEFINITION not found" in err


# ---------------------------------------------------------------------------
# Registry shape gate -- regression guard so future typed-flag children
# do not accidentally break the contract.
# ---------------------------------------------------------------------------


def test_registry_contains_seven_callables_in_order(policy_module):
    """Append-only registry; reorder/drop changes user-visible output order."""
    registry = policy_module._REGISTERED_POLICIES
    assert isinstance(registry, tuple)
    assert len(registry) == 7
    # Every entry is callable -- the show CLI assumes this.
    assert all(callable(insp) for insp in registry)


def test_policy_field_dataclass_is_frozen(policy_module):
    """``PolicyField`` is immutable so JSON-rendered dicts cannot drift."""
    field = policy_module.PolicyField(
        name="plan.policy.wipCap", current=10, default=10, source="default"
    )
    with pytest.raises((AttributeError, Exception)):
        field.current = 20  # type: ignore[misc]
