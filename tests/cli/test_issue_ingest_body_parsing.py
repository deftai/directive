"""test_issue_ingest_body_parsing.py -- Body parsing regression for #1248.

`task issue:ingest` used to emit stub-only scope vBRIEFs (no Overview,
``plan.items == []``, no cross-refs derived from the body), forcing the
refinement workflow to re-read the GitHub issue body by hand. The tests
below pin the four required acceptance criteria from issue #1248:

(a) issue with body + AC checklist -> ``plan.items[]`` populated.
(b) issue with body but no checklist -> ``plan.items == []`` (graceful
    degradation); ``narratives.Overview`` still present so refinement
    has *something* to project from.
(c) issue with empty body -> no ``Overview``, no ``items``, no body-
    derived references (canonical ``x-vbrief/github-issue`` origin still
    present).
(d) closing-keyword cross-ref extraction -> ``Closes #N`` / ``Refs #N`` /
    ``Blocked by #N`` land as ``x-vbrief/closes`` / ``x-vbrief/refs`` /
    ``x-vbrief/blocks`` entries on ``plan.references[]`` alongside the
    canonical origin reference.

Loaded with the same ``importlib.util`` pattern as the sibling tests
(``test_issue_ingest.py`` / ``test_issue_ingest_canonical_refs.py``) so
sibling-module imports (``_vbrief_build``, ``reconcile_issues``) resolve
without a fresh ``sys.path`` mutation per test.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def _load_issue_ingest():
    """Load ``scripts/issue_ingest.py`` in-process via ``importlib.util``."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "issue_ingest_body_parsing",
        scripts_dir / "issue_ingest.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


issue_ingest = _load_issue_ingest()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _issue(
    number: int,
    title: str,
    *,
    body: str | None = None,
    labels: list[str] | None = None,
) -> dict:
    return {
        "number": number,
        "title": title,
        "url": f"https://github.com/owner/repo/issues/{number}",
        "body": body or "",
        "labels": [{"name": name} for name in (labels or [])],
    }


# ---------------------------------------------------------------------------
# (a) Issue with body + AC checklist -> plan.items[] populated
# ---------------------------------------------------------------------------


class TestBodyWithChecklist:
    """Checkbox task-list lines become ``plan.items[]`` entries."""

    def test_checkbox_list_becomes_plan_items(self):
        body = (
            "## Summary\n"
            "Add widget support to the dashboard.\n\n"
            "## Acceptance Criteria\n"
            "- [ ] Widget renders in the sidebar\n"
            "- [ ] Widget exposes a click handler\n"
            "- [x] Spec doc updated\n"
        )
        vbrief, folder = issue_ingest._build_issue_vbrief(
            _issue(500, "Widget support", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        assert folder == "proposed"
        items = vbrief["plan"]["items"]
        assert len(items) == 3
        assert items[0] == {
            "title": "Widget renders in the sidebar",
            "status": "proposed",
        }
        assert items[1] == {
            "title": "Widget exposes a click handler",
            "status": "proposed",
        }
        # Checked box maps to ``completed`` so partial progress shows up.
        assert items[2] == {
            "title": "Spec doc updated",
            "status": "completed",
        }
        # Overview carries the full body verbatim per #988 / #1248.
        assert (
            "Add widget support to the dashboard."
            in vbrief["plan"]["narratives"]["Overview"]
        )

    def test_numbered_ac_section_fallback(self):
        """Numbered list under an ``Acceptance Criteria`` heading lands as items."""
        body = (
            "## Overview\n"
            "Improve the search ranking.\n\n"
            "## Acceptance criteria\n"
            "1. Search latency below 200ms p95\n"
            "2. Result relevance metric improves by 5%\n"
            "3. Telemetry pinned in dashboards\n\n"
            "## Out of scope\n"
            "- Re-training the ranking model\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(501, "Better search ranking", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        items = vbrief["plan"]["items"]
        titles = [i["title"] for i in items]
        assert titles == [
            "Search latency below 200ms p95",
            "Result relevance metric improves by 5%",
            "Telemetry pinned in dashboards",
        ]
        # The Out-of-scope bullet must NOT leak across the section
        # boundary into ``plan.items``.
        assert all("Re-training" not in t for t in titles)
        for item in items:
            assert item["status"] == "proposed"

    def test_checkbox_takes_priority_over_ac_section(self):
        """When both shapes are present, checkbox wins (more specific signal)."""
        body = (
            "- [ ] Top-level task A\n"
            "- [ ] Top-level task B\n\n"
            "## Acceptance Criteria\n"
            "1. Different bullet\n"
            "2. Another bullet\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(502, "Mixed shapes", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        titles = [i["title"] for i in vbrief["plan"]["items"]]
        assert titles == ["Top-level task A", "Top-level task B"]

    def test_numbered_ac_section_preserves_checked_status_mix(self):
        """Numbered AC list with ``[x]`` markers preserves the checked state.

        Greptile finding on PR #1252: previously ``_extract_ac_section_items``
        stripped the ``[x]`` / ``[ ]`` checkbox prefix but always emitted
        ``status = "proposed"`` even for completed items, silently inflating
        the refinement / ``triage:queue`` work queue. These items do NOT
        satisfy ``_CHECKBOX_RE`` (which requires a ``[-*+]`` bullet, not a
        numbered marker), so they reach the AC-section fallback and exercise
        the defensive checkbox-prefix strip.
        """
        body = (
            "## Acceptance Criteria\n"
            "1. [x] First criterion done\n"
            "2. [ ] Second criterion pending\n"
            "3. [X] Third criterion also done\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(503, "Mixed AC numbered+checkbox", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        items = vbrief["plan"]["items"]
        assert items == [
            {"title": "First criterion done", "status": "completed"},
            {"title": "Second criterion pending", "status": "proposed"},
            {"title": "Third criterion also done", "status": "completed"},
        ]


# ---------------------------------------------------------------------------
# (b) Issue with body but no checklist -> graceful degradation
# ---------------------------------------------------------------------------


class TestBodyOnlyNoChecklist:
    """A body without checkboxes / AC heading degrades to ``items == []``."""

    def test_prose_only_body_yields_empty_items_but_overview_present(self):
        body = (
            "## Summary\n"
            "We saw five users hit a permission error during onboarding.\n"
            "The error message says `denied by policy` but the user is in\n"
            "the right group. Investigation needed.\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(600, "Onboarding permission error", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        assert vbrief["plan"]["items"] == []
        assert vbrief["plan"]["narratives"]["Overview"] == body
        # Single canonical reference (the github-issue origin).
        refs = vbrief["plan"]["references"]
        assert len(refs) == 1
        assert refs[0]["type"] == "x-vbrief/github-issue"


# ---------------------------------------------------------------------------
# (c) Empty body -> no Overview / no items
# ---------------------------------------------------------------------------


class TestEmptyBody:
    """An empty / missing body produces no Overview and no items."""

    def test_empty_body_string(self):
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(700, "Empty body", body=""),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        assert "Overview" not in vbrief["plan"]["narratives"]
        assert vbrief["plan"]["items"] == []
        refs = vbrief["plan"]["references"]
        assert len(refs) == 1
        assert refs[0]["type"] == "x-vbrief/github-issue"

    def test_missing_body_key(self):
        issue = _issue(701, "No body key at all")
        issue.pop("body", None)
        vbrief, _ = issue_ingest._build_issue_vbrief(
            issue,
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        assert "Overview" not in vbrief["plan"]["narratives"]
        assert vbrief["plan"]["items"] == []

    def test_null_body_field(self):
        """``gh api`` returns ``"body": null`` for issues opened with no body."""
        issue = _issue(702, "Null body")
        issue["body"] = None
        vbrief, _ = issue_ingest._build_issue_vbrief(
            issue,
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        assert "Overview" not in vbrief["plan"]["narratives"]
        assert vbrief["plan"]["items"] == []


# ---------------------------------------------------------------------------
# (d) Closing-keyword cross-ref extraction
# ---------------------------------------------------------------------------


class TestCrossRefExtraction:
    """Closes / Refs / Blocked-by lift into typed ``plan.references[]`` entries."""

    def test_closes_keyword_extracted(self):
        body = (
            "## Summary\n"
            "Fix the off-by-one error in the paginator.\n\n"
            "Closes #1200\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(800, "Paginator off-by-one", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        refs = vbrief["plan"]["references"]
        # First ref is the canonical origin; the body-derived close-ref follows.
        assert refs[0]["type"] == "x-vbrief/github-issue"
        closes = [r for r in refs if r["type"] == "x-vbrief/closes"]
        assert len(closes) == 1
        assert closes[0]["uri"] == "https://github.com/owner/repo/issues/1200"
        assert closes[0]["title"] == "Issue #1200"

    def test_fixes_resolves_inflections_extracted(self):
        body = (
            "Fixes #10. Also resolves #11.\n"
            "Earlier patch closed #12 (already merged).\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(801, "Inflections", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        closes = [
            r for r in vbrief["plan"]["references"]
            if r["type"] == "x-vbrief/closes"
        ]
        numbers = sorted(int(r["uri"].rsplit("/", 1)[-1]) for r in closes)
        assert numbers == [10, 11, 12]

    def test_refs_and_related_extracted_as_refs_type(self):
        body = (
            "Refs #300.\n"
            "See also #301.\n"
            "Related to #302.\n"
            "References #303.\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(802, "Refs cohort", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        refs_type = [
            r for r in vbrief["plan"]["references"]
            if r["type"] == "x-vbrief/refs"
        ]
        numbers = sorted(int(r["uri"].rsplit("/", 1)[-1]) for r in refs_type)
        assert numbers == [300, 301, 302, 303]

    def test_blocked_by_extracted_as_blocks_type(self):
        body = (
            "## Summary\n"
            "Add the new dashboard widget.\n\n"
            "Blocked by #999\n"
            "Blocked-by #1000\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(803, "Dashboard widget", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        blocks = [
            r for r in vbrief["plan"]["references"]
            if r["type"] == "x-vbrief/blocks"
        ]
        numbers = sorted(int(r["uri"].rsplit("/", 1)[-1]) for r in blocks)
        assert numbers == [999, 1000]

    def test_self_reference_excluded(self):
        """``Closes #N`` in #N's own body must not duplicate the origin ref."""
        body = "This issue is itself. Closes #888."
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(888, "Self-ref", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        closes = [
            r for r in vbrief["plan"]["references"]
            if r["type"] == "x-vbrief/closes"
        ]
        assert closes == []
        # Origin still emitted.
        origins = [
            r for r in vbrief["plan"]["references"]
            if r["type"] == "x-vbrief/github-issue"
        ]
        assert len(origins) == 1

    def test_code_block_mentions_ignored(self):
        """Cross-ref tokens inside fenced code blocks must not match."""
        body = (
            "## Summary\n"
            "Document the closing-keyword grammar.\n\n"
            "Example body that would auto-close an upstream issue:\n\n"
            "```\nCloses #2000\nFixes #2001\n```\n\n"
            "Real cross-ref:\n\nCloses #2002\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(900, "Docs", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        closes = [
            r for r in vbrief["plan"]["references"]
            if r["type"] == "x-vbrief/closes"
        ]
        numbers = sorted(int(r["uri"].rsplit("/", 1)[-1]) for r in closes)
        # Only the real cross-ref (#2002) lifts; the two inside the fence
        # are quoted examples and must not auto-create references.
        assert numbers == [2002]

    def test_inline_code_mentions_ignored(self):
        body = "Inline `Closes #3000` is an example, not a real ref. Closes #3001."
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(901, "Inline code", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        closes = [
            r for r in vbrief["plan"]["references"]
            if r["type"] == "x-vbrief/closes"
        ]
        numbers = sorted(int(r["uri"].rsplit("/", 1)[-1]) for r in closes)
        assert numbers == [3001]

    def test_tilde_fenced_code_block_mentions_ignored(self):
        """``~~~``-fenced code blocks strip identically to triple-backticks.

        Greptile finding on PR #1252: previously ``_CODE_FENCE_RE`` only
        matched triple-backtick fences, so a body that quoted the closing-
        keyword grammar inside a tilde-fenced block (a valid GitHub
        Flavoured Markdown alternative) produced spurious cross-references.
        """
        body = (
            "## Summary\n"
            "Document the closing-keyword grammar with a tilde fence.\n\n"
            "~~~\nCloses #4000\nFixes #4001\n~~~\n\n"
            "Real cross-ref:\n\nCloses #4002\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            _issue(902, "Tilde fence docs", body=body),
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        closes = [
            r for r in vbrief["plan"]["references"]
            if r["type"] == "x-vbrief/closes"
        ]
        numbers = sorted(int(r["uri"].rsplit("/", 1)[-1]) for r in closes)
        # Only the real cross-ref (#4002) lifts; #4000 + #4001 are inside
        # the ``~~~`` fence and must be stripped before pattern matching.
        assert numbers == [4002]

    def test_cross_refs_skipped_when_repo_url_unknown(self):
        """No ``repo_url`` -> no cross-refs (cannot synthesise a honest URI)."""
        body = "Closes #1. Refs #2. Blocked by #3."
        issue = _issue(1000, "No repo url", body=body)
        issue["url"] = ""  # also drop the explicit URL
        vbrief, _ = issue_ingest._build_issue_vbrief(
            issue,
            status="proposed",
            repo_url="",
        )
        # No references at all (origin requires URL; cross-refs require
        # ``repo_url``).
        assert vbrief["plan"].get("references", []) == []


# ---------------------------------------------------------------------------
# (e) End-to-end smoke through ingest_one for the full path
# ---------------------------------------------------------------------------


class TestIngestOneEndToEnd:
    """Drive ``ingest_one`` so the on-disk JSON reflects every enrichment."""

    def test_written_vbrief_carries_items_and_cross_refs(self, tmp_path):
        body = (
            "## Summary\n"
            "Refactor the cache layer.\n\n"
            "## Acceptance Criteria\n"
            "- [ ] Cache TTL configurable per source\n"
            "- [ ] Backfill verb exists for cold-start\n\n"
            "Closes #1200\n"
            "Refs #883\n"
        )
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        result, path, _msg = issue_ingest.ingest_one(
            _issue(1100, "Cache refactor", body=body, labels=["enhancement"]),
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        assert result == "created"
        data = json.loads(path.read_text(encoding="utf-8"))

        # Items present and well-shaped.
        items = data["plan"]["items"]
        assert len(items) == 2
        for item in items:
            assert item["status"] == "proposed"
            assert isinstance(item["title"], str) and item["title"]

        # References: origin + closes + refs.
        ref_types = sorted(
            {r["type"] for r in data["plan"]["references"]}
        )
        assert ref_types == [
            "x-vbrief/closes",
            "x-vbrief/github-issue",
            "x-vbrief/refs",
        ]

        # Overview present; labels mirrored to plan.tags.
        assert "Refactor the cache layer." in data["plan"]["narratives"]["Overview"]
        assert data["plan"]["tags"] == ["enhancement"]
