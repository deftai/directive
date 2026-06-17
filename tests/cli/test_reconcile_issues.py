"""
test_reconcile_issues.py -- Tests for scripts/reconcile_issues.py.

Covers vBRIEF reference extraction, issue number parsing, directory scanning,
reconciliation logic, and output formatting.

Story #322. RFC #309.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()

# Import the module under test directly for unit tests
sys.path.insert(0, str(REPO_ROOT / "scripts"))
import reconcile_issues as ri_mod  # noqa: E402
from reconcile_issues import (  # noqa: E402, I001
    CANCELLED_STATE_REASONS,  # #1290
    IssueState,  # #1290
    apply_lifecycle_fixes,  # #1290
    build_lifecycle_report,  # #1290
    extract_references_from_vbrief,
    fetch_issue_states,  # #1290
    format_json,
    format_markdown,
    is_terminal_lifecycle_path,
    parse_decomposition_origin,  # #1319
    parse_issue_number,
    parse_parent_issue,  # #1319
    parse_plan_ref,  # #1290
    reconcile_with_unlinked as reconcile,  # legacy three-section shape (#754)
    resolve_lifecycle_anchor,  # #1290
    scan_lifecycle_anchors,  # #1290
    scan_vbrief_dir,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_vbrief_with_refs(
    tmp_path: Path,
    folder: str,
    filename: str,
    references: list[dict],
    item_references: list[dict] | None = None,
) -> Path:
    """Create a vBRIEF file with the given references in a lifecycle folder."""
    vbrief_root = tmp_path / "vbrief"
    folder_path = vbrief_root / folder
    folder_path.mkdir(parents=True, exist_ok=True)

    items = []
    if item_references:
        items.append({
            "title": "Test item",
            "status": "pending",
            "references": item_references,
        })

    data = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": "Test scope",
            "status": "pending",
            "references": references,
            "items": items,
        },
    }
    file_path = folder_path / filename
    file_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return file_path


# ---------------------------------------------------------------------------
# terminal lifecycle predicate
# ---------------------------------------------------------------------------


class TestTerminalLifecyclePredicate:
    def test_completed_and_cancelled_are_terminal(self):
        assert is_terminal_lifecycle_path("completed/done.vbrief.json")
        assert is_terminal_lifecycle_path("cancelled/duplicate.vbrief.json")

    def test_in_progress_folders_are_not_terminal(self):
        assert not is_terminal_lifecycle_path("proposed/scope.vbrief.json")
        assert not is_terminal_lifecycle_path("pending/scope.vbrief.json")
        assert not is_terminal_lifecycle_path("active/scope.vbrief.json")
        assert not is_terminal_lifecycle_path("malformed")


# ---------------------------------------------------------------------------
# extract_references_from_vbrief
# ---------------------------------------------------------------------------


class TestExtractReferences:
    def test_plan_level_references(self):
        data = {
            "plan": {
                "title": "Test",
                "status": "pending",
                "references": [
                    {"type": "github-issue", "url": "https://github.com/o/r/issues/1", "id": "#1"},
                ],
                "items": [],
            }
        }
        refs = extract_references_from_vbrief(data)
        assert len(refs) == 1
        assert refs[0]["id"] == "#1"

    def test_item_level_references(self):
        data = {
            "plan": {
                "title": "Test",
                "status": "pending",
                "references": [],
                "items": [
                    {
                        "title": "Item 1",
                        "status": "pending",
                        "references": [
                            {"type": "github-issue", "id": "#42"},
                        ],
                    },
                ],
            }
        }
        refs = extract_references_from_vbrief(data)
        assert len(refs) == 1
        assert refs[0]["id"] == "#42"

    def test_nested_subitems(self):
        data = {
            "plan": {
                "title": "Test",
                "status": "pending",
                "references": [],
                "items": [
                    {
                        "title": "Parent",
                        "status": "pending",
                        "subItems": [
                            {
                                "title": "Child",
                                "status": "pending",
                                "references": [
                                    {"type": "github-issue", "id": "#99"},
                                ],
                            },
                        ],
                    },
                ],
            }
        }
        refs = extract_references_from_vbrief(data)
        assert len(refs) == 1
        assert refs[0]["id"] == "#99"

    def test_no_references(self):
        data = {
            "plan": {
                "title": "Test",
                "status": "pending",
                "items": [],
            }
        }
        refs = extract_references_from_vbrief(data)
        assert refs == []

    def test_empty_plan(self):
        refs = extract_references_from_vbrief({})
        assert refs == []


# ---------------------------------------------------------------------------
# parse_issue_number
# ---------------------------------------------------------------------------


class TestParseIssueNumber:
    def test_full_url(self):
        ref = {"type": "github-issue", "url": "https://github.com/deftai/directive/issues/322"}
        assert parse_issue_number(ref) == 322

    def test_hash_id(self):
        ref = {"type": "github-issue", "id": "#115"}
        assert parse_issue_number(ref) == 115

    def test_url_takes_precedence(self):
        ref = {
            "type": "github-issue",
            "url": "https://github.com/deftai/directive/issues/100",
            "id": "#200",
        }
        assert parse_issue_number(ref) == 100

    def test_no_number(self):
        ref = {"type": "github-issue", "url": "not-a-url"}
        assert parse_issue_number(ref) is None

    def test_empty_ref(self):
        assert parse_issue_number({}) is None


# ---------------------------------------------------------------------------
# scan_vbrief_dir
# ---------------------------------------------------------------------------


class TestScanVbriefDir:
    def test_scans_lifecycle_folders(self, tmp_path):
        make_vbrief_with_refs(
            tmp_path,
            "pending",
            "2026-04-12-feature-a.vbrief.json",
            [{"type": "github-issue", "url": "https://github.com/o/r/issues/10", "id": "#10"}],
        )
        make_vbrief_with_refs(
            tmp_path,
            "active",
            "2026-04-12-feature-b.vbrief.json",
            [{"type": "github-issue", "id": "#20"}],
        )

        result = scan_vbrief_dir(tmp_path / "vbrief")
        assert 10 in result
        assert 20 in result
        assert result[10] == ["pending/2026-04-12-feature-a.vbrief.json"]
        assert result[20] == ["active/2026-04-12-feature-b.vbrief.json"]

    def test_skips_non_github_issue_refs(self, tmp_path):
        make_vbrief_with_refs(
            tmp_path,
            "proposed",
            "2026-04-12-test.vbrief.json",
            [{"type": "x-vbrief/plan", "url": "./active/other.vbrief.json"}],
        )
        result = scan_vbrief_dir(tmp_path / "vbrief")
        assert len(result) == 0

    def test_handles_missing_folders(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        result = scan_vbrief_dir(vbrief_dir)
        assert result == {}

    def test_handles_malformed_json(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        folder = vbrief_dir / "pending"
        folder.mkdir(parents=True)
        bad_file = folder / "2026-04-12-bad.vbrief.json"
        bad_file.write_text("{invalid json", encoding="utf-8")
        result = scan_vbrief_dir(vbrief_dir)
        assert result == {}

    def test_item_level_references_scanned(self, tmp_path):
        make_vbrief_with_refs(
            tmp_path,
            "active",
            "2026-04-12-with-items.vbrief.json",
            references=[],
            item_references=[
                {"type": "github-issue", "url": "https://github.com/o/r/issues/55", "id": "#55"},
            ],
        )
        result = scan_vbrief_dir(tmp_path / "vbrief")
        assert 55 in result


# ---------------------------------------------------------------------------
# reconcile
# ---------------------------------------------------------------------------


class TestReconcile:
    def test_linked_issues(self):
        issue_map = {10: ["pending/feat.vbrief.json"]}
        issues = [{"number": 10, "title": "Feature A", "url": "https://example.com/10"}]
        report = reconcile(issue_map, issues)
        assert len(report["linked"]) == 1
        assert report["linked"][0]["issue_number"] == 10
        assert report["unlinked"] == []

    def test_unlinked_issues(self):
        issue_map: dict[int, list[str]] = {}
        issues = [{"number": 20, "title": "Orphan", "url": "https://example.com/20"}]
        report = reconcile(issue_map, issues)
        assert len(report["unlinked"]) == 1
        assert report["unlinked"][0]["issue_number"] == 20
        assert report["linked"] == []

    def test_vbrief_no_open_issue(self):
        issue_map = {99: ["completed/done.vbrief.json"]}
        issues: list[dict] = []
        report = reconcile(issue_map, issues)
        assert len(report["no_open_issue"]) == 1
        assert report["no_open_issue"][0]["issue_number"] == 99

    def test_mixed_scenario(self):
        issue_map = {
            10: ["pending/feat.vbrief.json"],
            99: ["completed/done.vbrief.json"],
        }
        issues = [
            {"number": 10, "title": "Feature A", "url": ""},
            {"number": 20, "title": "Orphan", "url": ""},
        ]
        report = reconcile(issue_map, issues)
        assert report["summary"]["linked_count"] == 1
        assert report["summary"]["unlinked_count"] == 1
        assert report["summary"]["vbriefs_no_open_issue_count"] == 1
        assert report["summary"]["total_open_issues"] == 2

    def test_empty_inputs(self):
        report = reconcile({}, [])
        assert report["summary"]["total_open_issues"] == 0
        assert report["linked"] == []
        assert report["unlinked"] == []
        assert report["no_open_issue"] == []


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


class TestFormatJson:
    def test_valid_json_output(self):
        report = reconcile({}, [{"number": 1, "title": "Test", "url": ""}])
        output = format_json(report)
        parsed = json.loads(output)
        assert parsed["summary"]["total_open_issues"] == 1


class TestFormatMarkdown:
    def test_markdown_contains_sections(self):
        report = reconcile(
            {10: ["pending/f.vbrief.json"]},
            [
                {"number": 10, "title": "Linked", "url": ""},
                {"number": 20, "title": "Unlinked", "url": ""},
            ],
        )
        md = format_markdown(report)
        assert "# Issue Reconciliation Report" in md
        assert "## (a)" in md
        assert "## (b)" in md
        assert "## (c)" in md
        assert "#10 Linked" in md
        assert "#20 Unlinked" in md

    def test_empty_report(self):
        report = reconcile({}, [])
        md = format_markdown(report)
        assert "None." in md


# ---------------------------------------------------------------------------
# CLI subprocess integration
# ---------------------------------------------------------------------------


class TestCLI:
    def test_help(self):
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "reconcile_issues.py"), "--help"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0
        assert "Reconcile GitHub issues" in result.stdout

    def test_missing_vbrief_dir(self, tmp_path):
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "reconcile_issues.py"),
                "--vbrief-dir", str(tmp_path / "nonexistent"),
                "--repo", "test/test",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 1
        assert "not found" in result.stderr


# ---------------------------------------------------------------------------
# #1290 -- stateReason routing + Axis B planRef-first lifecycle resolution
# ---------------------------------------------------------------------------


def _write_vbrief_1290(
    vbrief_dir: Path,
    folder: str,
    filename: str,
    *,
    plan_ref: int | None = None,
    ref_issue: int | None = None,
    status: str = "running",
) -> Path:
    """Write a synthetic vBRIEF with optional ``plan.planRef`` + a
    github-issue reference, for the #1290 anchor-resolution tests."""
    folder_path = vbrief_dir / folder
    folder_path.mkdir(parents=True, exist_ok=True)
    plan: dict = {
        "title": filename,
        "status": status,
        "items": [],
        "references": [],
    }
    if plan_ref is not None:
        plan["planRef"] = f"#{plan_ref}"
    if ref_issue is not None:
        plan["references"].append(
            {
                "uri": (
                    f"https://github.com/deftai/directive/issues/{ref_issue}"
                ),
                "type": "x-vbrief/github-issue",
                "title": f"Issue #{ref_issue}",
            }
        )
    data = {"vBRIEFInfo": {"version": "0.6"}, "plan": plan}
    p = folder_path / filename
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return p


class TestIssueState:
    def test_is_str_and_carries_reason(self):
        st = IssueState("CLOSED", "NOT_PLANNED")
        # Behaves as the bare state string (back-compat with every
        # existing caller / equality test).
        assert st == "CLOSED"
        assert isinstance(st, str)
        # ...but additionally carries the stateReason.
        assert st.state_reason == "NOT_PLANNED"

    def test_dict_equality_with_bare_strings(self):
        # A state map of IssueState values MUST compare equal to a map of
        # bare strings -- the property that keeps release.py + the #754
        # tests working unchanged.
        rich = {1: IssueState("OPEN", None), 2: IssueState("CLOSED", "DUPLICATE")}
        assert rich == {1: "OPEN", 2: "CLOSED"}

    def test_null_reason_defaults_to_none(self):
        assert IssueState("OPEN").state_reason is None


class TestFetchIssueStatesStateReason:
    """Phase A: ``fetch_issue_states`` selects + returns ``stateReason``."""

    def test_query_selects_state_reason_and_parses_it(self, monkeypatch):
        payload = {
            "data": {
                "repository": {
                    "i10": {"state": "CLOSED", "stateReason": "NOT_PLANNED"},
                    "i20": {"state": "OPEN", "stateReason": None},
                }
            }
        }
        calls: list[str] = []

        class R:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        def fake_run(argv, **_kw):
            calls.append(
                next(
                    (a for a in argv if isinstance(a, str) and a.startswith("query=")),
                    "",
                )
            )
            return R()

        monkeypatch.setattr(ri_mod.subprocess, "run", fake_run)
        states = fetch_issue_states("deftai/directive", {10, 20})
        assert states is not None
        # The GraphQL query MUST request stateReason.
        assert "stateReason" in calls[0]
        # Values still equal the bare state string...
        assert states[10] == "CLOSED"
        assert states[20] == "OPEN"
        # ...and carry the parsed stateReason.
        assert states[10].state_reason == "NOT_PLANNED"
        assert states[20].state_reason is None


class TestParsePlanRefAndAnchor:
    def test_parse_plan_ref_hash(self):
        assert parse_plan_ref({"plan": {"planRef": "#1290"}}) == 1290

    def test_parse_plan_ref_url(self):
        data = {
            "plan": {
                "planRef": "https://github.com/deftai/directive/issues/742"
            }
        }
        assert parse_plan_ref(data) == 742

    def test_parse_plan_ref_absent(self):
        assert parse_plan_ref({"plan": {}}) is None
        assert parse_plan_ref({"plan": {"planRef": "not-a-ref"}}) is None

    def test_anchor_prefers_plan_ref(self):
        data = {
            "plan": {
                "planRef": "#1290",
                "references": [
                    {
                        "type": "x-vbrief/github-issue",
                        "uri": "https://github.com/deftai/directive/issues/742",
                    }
                ],
            }
        }
        num, axis = resolve_lifecycle_anchor(data)
        assert num == 1290
        assert axis == "planRef"

    def test_anchor_falls_back_to_references(self):
        data = {
            "plan": {
                "references": [
                    {
                        "type": "x-vbrief/github-issue",
                        "uri": "https://github.com/deftai/directive/issues/742",
                    }
                ]
            }
        }
        num, axis = resolve_lifecycle_anchor(data)
        assert num == 742
        assert axis == "references"

    def test_anchor_none_when_no_issue(self):
        num, axis = resolve_lifecycle_anchor({"plan": {"references": []}})
        assert num is None
        assert axis == "none"


class TestApplyStateReasonRouting:
    """Phase A: apply-mode routes by stateReason."""

    def _setup(self, tmp_path, *, reason, state="CLOSED"):
        vbrief_dir = tmp_path / "vbrief"
        src = _write_vbrief_1290(
            vbrief_dir, "active", "a.vbrief.json", ref_issue=10
        )
        anchors = scan_lifecycle_anchors(vbrief_dir)
        state_map = {10: IssueState(state, reason)}
        report = build_lifecycle_report(anchors, state_map, log=False)
        return vbrief_dir, src, report

    def test_not_planned_routes_to_cancelled(self, tmp_path):
        vbrief_dir, src, report = self._setup(tmp_path, reason="NOT_PLANNED")
        moved, skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert failures == []
        assert not src.is_file()
        dst = vbrief_dir / "cancelled" / "a.vbrief.json"
        assert dst.is_file()
        data = json.loads(dst.read_text(encoding="utf-8"))
        assert data["plan"]["status"] == "cancelled"

    def test_duplicate_routes_to_cancelled(self, tmp_path):
        vbrief_dir, src, report = self._setup(tmp_path, reason="DUPLICATE")
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert failures == []
        assert (vbrief_dir / "cancelled" / "a.vbrief.json").is_file()

    def test_completed_routes_to_completed(self, tmp_path):
        vbrief_dir, src, report = self._setup(tmp_path, reason="COMPLETED")
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert failures == []
        dst = vbrief_dir / "completed" / "a.vbrief.json"
        assert dst.is_file()
        data = json.loads(dst.read_text(encoding="utf-8"))
        assert data["plan"]["status"] == "completed"

    def test_null_reason_defaults_to_completed(self, tmp_path):
        vbrief_dir, src, report = self._setup(tmp_path, reason=None)
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert (vbrief_dir / "completed" / "a.vbrief.json").is_file()

    def test_reopened_is_report_only(self, tmp_path):
        # An OPEN issue whose stateReason is REOPENED must NOT be moved --
        # OPEN anchors are linked, never apply-mode candidates.
        vbrief_dir = tmp_path / "vbrief"
        src = _write_vbrief_1290(
            vbrief_dir, "active", "reopened.vbrief.json", ref_issue=11
        )
        anchors = scan_lifecycle_anchors(vbrief_dir)
        state_map = {11: IssueState("OPEN", "REOPENED")}
        report = build_lifecycle_report(anchors, state_map, log=False)
        assert report["no_open_issue"] == []
        assert report["summary"]["linked_count"] == 1
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 0
        assert failures == []
        assert src.is_file()

    def test_cancelled_reasons_constant(self):
        assert sorted(CANCELLED_STATE_REASONS) == ["DUPLICATE", "NOT_PLANNED"]


class TestAxisBPrimaryReferenceFilter:
    """Phase B: planRef is the canonical lifecycle anchor (#742 recurrence)."""

    def test_planref_open_with_closed_umbrella_ref_stays_put(self, tmp_path):
        # The recurrence record: a cohort member's planRef issue (#1284)
        # is OPEN, but it merely *references* a closed umbrella (#742).
        # Pre-#1290 the reconciler dragged it into the umbrella's terminal
        # state; Axis B keeps it put because planRef is canonical.
        vbrief_dir = tmp_path / "vbrief"
        src = _write_vbrief_1290(
            vbrief_dir,
            "active",
            "cohort-member.vbrief.json",
            plan_ref=1284,
            ref_issue=742,
        )
        anchors = scan_lifecycle_anchors(vbrief_dir)
        assert len(anchors) == 1
        assert anchors[0]["issue_number"] == 1284
        assert anchors[0]["axis"] == "planRef"

        state_map = {
            1284: IssueState("OPEN", None),
            742: IssueState("CLOSED", "COMPLETED"),
        }
        report = build_lifecycle_report(anchors, state_map, log=False)
        assert report["no_open_issue"] == []

        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 0
        assert failures == []
        assert src.is_file(), (
            "a vBRIEF whose planRef issue is OPEN MUST stay put even when "
            "it references a closed umbrella"
        )

    def test_without_planref_closed_ref_is_dragged(self, tmp_path):
        # Contrast: with NO planRef, the resolver falls back to
        # references[] -- the closed umbrella DOES drive the lifecycle.
        vbrief_dir = tmp_path / "vbrief"
        src = _write_vbrief_1290(
            vbrief_dir, "active", "no-planref.vbrief.json", ref_issue=742
        )
        anchors = scan_lifecycle_anchors(vbrief_dir)
        assert anchors[0]["issue_number"] == 742
        assert anchors[0]["axis"] == "references"
        state_map = {742: IssueState("CLOSED", "COMPLETED")}
        report = build_lifecycle_report(anchors, state_map, log=False)
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert failures == []
        assert not src.is_file()
        assert (vbrief_dir / "completed" / "no-planref.vbrief.json").is_file()

    def test_structured_log_names_axis(self, tmp_path, capsys):
        vbrief_dir = tmp_path / "vbrief"
        _write_vbrief_1290(
            vbrief_dir, "active", "logged.vbrief.json", plan_ref=1284, ref_issue=742
        )
        anchors = scan_lifecycle_anchors(vbrief_dir)
        build_lifecycle_report(
            anchors, {1284: IssueState("OPEN", None)}, log=True
        )
        err = capsys.readouterr().err
        assert "[lifecycle-resolve]" in err
        assert "axis=planRef" in err
        assert "anchor=#1284" in err


# ---------------------------------------------------------------------------
# #924 -- apply_lifecycle_fixes propagates items[*].status to terminal state
# ---------------------------------------------------------------------------

_ISO_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def _write_vbrief_with_items_924(
    vbrief_dir: Path,
    folder: str,
    filename: str,
    *,
    ref_issue: int,
    item_statuses: list[str],
) -> Path:
    """Write a synthetic vBRIEF whose plan.items carry non-terminal status.

    Includes a nested ``subItems`` tree on the first item so the #924
    propagation is exercised recursively, not just at the top level.
    """
    folder_path = vbrief_dir / folder
    folder_path.mkdir(parents=True, exist_ok=True)
    items: list[dict] = []
    for idx, status in enumerate(item_statuses):
        item: dict = {
            "title": f"Item {idx}",
            "status": status,
            "completed": None,
        }
        if idx == 0:
            item["subItems"] = [
                {"title": "Sub A", "status": "pending", "completed": None}
            ]
        items.append(item)
    data = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": filename,
            "status": "running",
            "items": items,
            "references": [
                {
                    "uri": (
                        f"https://github.com/deftai/directive/issues/{ref_issue}"
                    ),
                    "type": "x-vbrief/github-issue",
                    "title": f"Issue #{ref_issue}",
                }
            ],
        },
    }
    p = folder_path / filename
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return p


class TestApplyItemStatusPropagation:
    """#924: apply-mode flips plan.items[*].status to the terminal state."""

    def test_completed_destination_propagates_items(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        _write_vbrief_with_items_924(
            vbrief_dir,
            "active",
            "completed-prop.vbrief.json",
            ref_issue=10,
            item_statuses=["proposed", "pending"],
        )
        anchors = scan_lifecycle_anchors(vbrief_dir)
        # CLOSED + COMPLETED routes to completed/.
        state_map = {10: IssueState("CLOSED", "COMPLETED")}
        report = build_lifecycle_report(anchors, state_map, log=False)
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert failures == []
        dst = vbrief_dir / "completed" / "completed-prop.vbrief.json"
        assert dst.is_file()
        data = json.loads(dst.read_text(encoding="utf-8"))
        assert data["plan"]["status"] == "completed"
        items = data["plan"]["items"]
        assert items, "expected items to be present"
        for item in items:
            assert item["status"] == "completed"
            assert _ISO_UTC_RE.match(item["completed"]), item["completed"]
        # Nested subItems propagate too.
        sub = items[0]["subItems"][0]
        assert sub["status"] == "completed"
        assert _ISO_UTC_RE.match(sub["completed"]), sub["completed"]

    def test_null_items_does_not_raise(self, tmp_path):
        # An explicit ``"items": null`` on disk returns None from
        # ``.get("items", [])`` (the default only applies to ABSENT keys),
        # which would crash the recursion with TypeError and abort the
        # whole batch. The ``.get("items") or []`` guard handles it. (#924)
        vbrief_dir = tmp_path / "vbrief"
        folder_path = vbrief_dir / "active"
        folder_path.mkdir(parents=True, exist_ok=True)
        data = {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "title": "null-items",
                "status": "running",
                "items": None,
                "references": [
                    {
                        "uri": "https://github.com/deftai/directive/issues/12",
                        "type": "x-vbrief/github-issue",
                        "title": "Issue #12",
                    }
                ],
            },
        }
        src = folder_path / "null-items.vbrief.json"
        src.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        anchors = scan_lifecycle_anchors(vbrief_dir)
        state_map = {12: IssueState("CLOSED", "COMPLETED")}
        report = build_lifecycle_report(anchors, state_map, log=False)
        # Must not raise TypeError and must still move the vBRIEF.
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert failures == []
        dst = vbrief_dir / "completed" / "null-items.vbrief.json"
        assert dst.is_file()
        moved_data = json.loads(dst.read_text(encoding="utf-8"))
        assert moved_data["plan"]["status"] == "completed"

    def test_null_nested_subitems_and_items_does_not_raise(self, tmp_path):
        # A nested item whose ``subItems`` / ``items`` keys are explicit
        # JSON null must not crash the recursion either. (#924)
        vbrief_dir = tmp_path / "vbrief"
        folder_path = vbrief_dir / "active"
        folder_path.mkdir(parents=True, exist_ok=True)
        data = {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "title": "null-nested",
                "status": "running",
                "items": [
                    {
                        "title": "Item 0",
                        "status": "pending",
                        "completed": None,
                        "subItems": None,
                        "items": None,
                    }
                ],
                "references": [
                    {
                        "uri": "https://github.com/deftai/directive/issues/13",
                        "type": "x-vbrief/github-issue",
                        "title": "Issue #13",
                    }
                ],
            },
        }
        src = folder_path / "null-nested.vbrief.json"
        src.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        anchors = scan_lifecycle_anchors(vbrief_dir)
        state_map = {13: IssueState("CLOSED", "NOT_PLANNED")}
        report = build_lifecycle_report(anchors, state_map, log=False)
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert failures == []
        dst = vbrief_dir / "cancelled" / "null-nested.vbrief.json"
        assert dst.is_file()
        moved_data = json.loads(dst.read_text(encoding="utf-8"))
        assert moved_data["plan"]["items"][0]["status"] == "cancelled"
        assert _ISO_UTC_RE.match(moved_data["plan"]["items"][0]["completed"])

    def test_cancelled_destination_propagates_items(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        _write_vbrief_with_items_924(
            vbrief_dir,
            "active",
            "cancelled-prop.vbrief.json",
            ref_issue=11,
            item_statuses=["proposed", "pending"],
        )
        anchors = scan_lifecycle_anchors(vbrief_dir)
        # CLOSED + NOT_PLANNED routes to cancelled/.
        state_map = {11: IssueState("CLOSED", "NOT_PLANNED")}
        report = build_lifecycle_report(anchors, state_map, log=False)
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert failures == []
        dst = vbrief_dir / "cancelled" / "cancelled-prop.vbrief.json"
        assert dst.is_file()
        data = json.loads(dst.read_text(encoding="utf-8"))
        assert data["plan"]["status"] == "cancelled"
        items = data["plan"]["items"]
        assert items, "expected items to be present"
        for item in items:
            assert item["status"] == "cancelled"
            assert _ISO_UTC_RE.match(item["completed"]), item["completed"]
        sub = items[0]["subItems"][0]
        assert sub["status"] == "cancelled"
        assert _ISO_UTC_RE.match(sub["completed"]), sub["completed"]


# ---------------------------------------------------------------------------
# #1319 -- decomposition children: own primary issue is the lifecycle anchor,
# NOT the (often closed) decomposition_origin umbrella.
# ---------------------------------------------------------------------------


def _write_decomposition_child_1319(
    vbrief_dir: Path,
    folder: str,
    filename: str,
    *,
    parent_issue: int | None,
    decomposition_origin: int | None,
    reference_issues: list[int],
    plan_ref: int | None = None,
    status: str = "running",
) -> Path:
    """Write a synthetic decomposition-child vBRIEF for the #1319 tests.

    Mirrors the real shape of #1283 / #1284 / #1285 / #1291: an
    ``x-tracking`` block under ``plan.metadata`` carrying ``parent_issue``
    (the child's OWN issue) and ``decomposition_origin`` (the umbrella it
    was carved from), plus a ``references[]`` array that may list both the
    own issue and the closed umbrella.
    """
    folder_path = vbrief_dir / folder
    folder_path.mkdir(parents=True, exist_ok=True)
    x_tracking: dict = {}
    if parent_issue is not None:
        x_tracking["parent_issue"] = f"#{parent_issue}"
    if decomposition_origin is not None:
        x_tracking["decomposition_origin"] = f"#{decomposition_origin}"
    references = [
        {
            "uri": f"https://github.com/deftai/directive/issues/{n}",
            "type": "x-vbrief/github-issue",
            "title": f"Issue #{n}",
        }
        for n in reference_issues
    ]
    plan: dict = {
        "title": filename,
        "status": status,
        "items": [],
        "references": references,
        "metadata": {"kind": "research", "x-tracking": x_tracking},
    }
    if plan_ref is not None:
        plan["planRef"] = f"#{plan_ref}"
    data = {"vBRIEFInfo": {"version": "0.6"}, "plan": plan}
    p = folder_path / filename
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return p


class TestParentIssueAccessors:
    """#1319: x-tracking accessors read the child's provenance fields."""

    def test_parse_parent_issue_hash(self):
        data = {"plan": {"metadata": {"x-tracking": {"parent_issue": "#1283"}}}}
        assert parse_parent_issue(data) == 1283

    def test_parse_decomposition_origin_hash(self):
        data = {
            "plan": {"metadata": {"x-tracking": {"decomposition_origin": "#742"}}}
        }
        assert parse_decomposition_origin(data) == 742

    def test_accessors_absent_return_none(self):
        assert parse_parent_issue({"plan": {}}) is None
        assert parse_decomposition_origin({"plan": {}}) is None
        assert parse_parent_issue({}) is None


class TestDecompositionChildPrimaryAnchor:
    """#1319: a decomposition child's own OPEN issue anchors its lifecycle.

    The v0.33.0 cut moved #1283 / #1284 / #1285 / #1291 to ``completed/``
    because their ``decomposition_origin`` umbrella (#742) was CLOSED,
    even though each child's own primary issue was still OPEN. These
    tests fail before the fix (the closed umbrella drives the move) and
    pass after (the child's own issue is the canonical anchor).
    """

    def test_parent_issue_anchor_beats_closed_umbrella_reference(self):
        # Umbrella (#742) listed FIRST in references[] to stress the
        # order-dependent pre-fix references fallback.
        data = {
            "plan": {
                "metadata": {
                    "x-tracking": {
                        "parent_issue": "#1283",
                        "decomposition_origin": "#742",
                    }
                },
                "references": [
                    {
                        "type": "x-vbrief/github-issue",
                        "uri": "https://github.com/deftai/directive/issues/742",
                    },
                    {
                        "type": "x-vbrief/github-issue",
                        "uri": "https://github.com/deftai/directive/issues/1283",
                    },
                ],
            }
        }
        num, axis = resolve_lifecycle_anchor(data)
        assert num == 1283
        assert axis == "parent_issue"

    def test_decomposition_origin_excluded_from_references_fallback(self):
        # No parent_issue: the references fallback must STILL skip the
        # decomposition_origin umbrella and resolve to the own open issue.
        data = {
            "plan": {
                "metadata": {
                    "x-tracking": {"decomposition_origin": "#742"}
                },
                "references": [
                    {
                        "type": "x-vbrief/github-issue",
                        "uri": "https://github.com/deftai/directive/issues/742",
                    },
                    {
                        "type": "x-vbrief/github-issue",
                        "uri": "https://github.com/deftai/directive/issues/1283",
                    },
                ],
            }
        }
        num, axis = resolve_lifecycle_anchor(data)
        assert num == 1283
        assert axis == "references"

    def test_child_with_open_own_issue_stays_put(self, tmp_path):
        # End-to-end: closed umbrella + closed cross-link, but the child's
        # OWN issue (#1283) is OPEN -> the child must NOT be moved.
        vbrief_dir = tmp_path / "vbrief"
        src = _write_decomposition_child_1319(
            vbrief_dir,
            "active",
            "1283-pack-slicing-rfc.vbrief.json",
            parent_issue=1283,
            decomposition_origin=742,
            reference_issues=[742, 1283, 1290],
        )
        anchors = scan_lifecycle_anchors(vbrief_dir)
        assert len(anchors) == 1
        assert anchors[0]["issue_number"] == 1283
        assert anchors[0]["axis"] == "parent_issue"

        state_map = {
            1283: IssueState("OPEN", None),
            742: IssueState("CLOSED", "COMPLETED"),
            1290: IssueState("CLOSED", "COMPLETED"),
        }
        report = build_lifecycle_report(anchors, state_map, log=False)
        assert report["no_open_issue"] == []
        assert report["summary"]["linked_count"] == 1

        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 0
        assert failures == []
        assert src.is_file(), (
            "a decomposition child whose own issue is OPEN MUST stay put "
            "even when its decomposition_origin umbrella is CLOSED"
        )

    def test_child_with_closed_own_issue_still_moves(self, tmp_path):
        # Contrast: when the child's OWN issue is CLOSED+COMPLETED the
        # move still fires -- the fix narrows the trigger, it does not
        # disable legitimate completion.
        vbrief_dir = tmp_path / "vbrief"
        src = _write_decomposition_child_1319(
            vbrief_dir,
            "active",
            "1283-done.vbrief.json",
            parent_issue=1283,
            decomposition_origin=742,
            reference_issues=[742, 1283],
        )
        anchors = scan_lifecycle_anchors(vbrief_dir)
        state_map = {
            1283: IssueState("CLOSED", "COMPLETED"),
            742: IssueState("CLOSED", "COMPLETED"),
        }
        report = build_lifecycle_report(anchors, state_map, log=False)
        moved, _skipped, failures = apply_lifecycle_fixes(vbrief_dir, report)
        assert moved == 1
        assert failures == []
        assert not src.is_file()
        assert (vbrief_dir / "completed" / "1283-done.vbrief.json").is_file()
