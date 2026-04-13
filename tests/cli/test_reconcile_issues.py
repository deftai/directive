"""
test_reconcile_issues.py -- Tests for scripts/reconcile_issues.py.

Covers vBRIEF reference extraction, issue number parsing, directory scanning,
reconciliation logic, and output formatting.

Story #322. RFC #309.
"""

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()

# Import the module under test directly for unit tests
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from reconcile_issues import (  # noqa: E402, I001
    extract_references_from_vbrief,
    format_json,
    format_markdown,
    parse_issue_number,
    reconcile,
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
