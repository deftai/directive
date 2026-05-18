"""tests/test_triage_smoketest_fixture.py -- pin the shape of the N6 fixture (#1146).

Read-only assertions against ``tests/fixtures/triage_smoketest/issues.json``
and the sibling vBRIEF files. The smoketest itself walks the lifecycle;
these content tests guard the fixture's contract so a future edit that
silently breaks the assertion targets (e.g. drops a hold-marker issue,
removes the consumer research rule) is caught before the smoketest
fails opaquely.

Run cost: fast (read-only JSON parses). Not marked ``@pytest.mark.slow``;
included in the default ``task check``.

Refs:

* Umbrella: #1119
* This deliverable: #1146 (N6)
"""

from __future__ import annotations

import json
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_FIXTURE = _REPO_ROOT / "tests" / "fixtures" / "triage_smoketest"


def test_fixture_root_has_required_files() -> None:
    """The committed fixture carries every required artefact."""
    assert (_FIXTURE / "README.md").is_file()
    assert (_FIXTURE / "issues.json").is_file()
    assert (_FIXTURE / "PROJECT-DEFINITION.vbrief.json").is_file()
    assert (
        _FIXTURE / "vbrief" / "active" / "2026-05-18-referenced.vbrief.json"
    ).is_file()
    assert (
        _FIXTURE / "vbrief" / "proposed" / "test-1.vbrief.json"
    ).is_file()


def test_issues_spec_has_twenty_issues_in_five_buckets() -> None:
    """20-issue distribution: 12 normal + 1 referenced + 3 hold + 2 research + 2 dormant."""
    spec = json.loads((_FIXTURE / "issues.json").read_text(encoding="utf-8"))
    issues = spec["issues"]
    assert len(issues) == 20, f"expected 20 issues, got {len(issues)}"
    by_bucket: dict[str, int] = {}
    for issue in issues:
        bucket = issue.get("bucket", "<no-bucket>")
        by_bucket[bucket] = by_bucket.get(bucket, 0) + 1
    assert by_bucket == {
        "normal": 12,
        "referenced": 1,
        "hold": 3,
        "research": 2,
        "dormant": 2,
    }, f"bucket counts diverged: {by_bucket}"


def test_issues_spec_carries_expected_hold_markers() -> None:
    """Each of the 3 hold-marker issues contains one of the framework defaults."""
    spec = json.loads((_FIXTURE / "issues.json").read_text(encoding="utf-8"))
    holds = [i for i in spec["issues"] if i.get("bucket") == "hold"]
    assert len(holds) == 3
    markers_seen: set[str] = set()
    canonical_markers = {"do not implement", "BLOCKED", "HOLDING"}
    for issue in holds:
        body = issue.get("body", "")
        for marker in canonical_markers:
            if marker in body:
                markers_seen.add(marker)
                break
    assert markers_seen == canonical_markers, (
        f"hold markers seen: {markers_seen}; expected: {canonical_markers}"
    )


def test_research_issues_carry_rfc_or_type_research_label() -> None:
    """Both research issues carry one of the consumer-rule labels."""
    spec = json.loads((_FIXTURE / "issues.json").read_text(encoding="utf-8"))
    research = [i for i in spec["issues"] if i.get("bucket") == "research"]
    assert len(research) == 2
    label_set: set[str] = set()
    for issue in research:
        for label in issue.get("labels", []):
            label_set.add(label)
    assert label_set <= {"rfc", "type:research"}
    assert {"rfc", "type:research"} <= label_set, (
        f"expected both 'rfc' and 'type:research' present across research issues; "
        f"got {label_set}"
    )


def test_project_definition_carries_research_consumer_rule() -> None:
    """PROJECT-DEFINITION ships the research consumer auto-classify rule."""
    pd = json.loads(
        (_FIXTURE / "PROJECT-DEFINITION.vbrief.json").read_text(encoding="utf-8")
    )
    rules = (
        pd.get("plan", {}).get("policy", {}).get("triageAutoClassify", [])
    )
    assert len(rules) == 1, f"expected exactly one consumer rule, got {len(rules)}"
    rule = rules[0]
    assert rule.get("action") == "defer"
    assert rule.get("reason") == "research"
    labels_pred = rule.get("match", {}).get("labels", {})
    assert set(labels_pred.get("any-of", [])) == {"rfc", "type:research"}


def test_active_vbrief_references_issue_20() -> None:
    """The pre-existing active vBRIEF references fixture issue #20."""
    pd = json.loads(
        (
            _FIXTURE / "vbrief" / "active" / "2026-05-18-referenced.vbrief.json"
        ).read_text(encoding="utf-8")
    )
    refs = pd.get("plan", {}).get("references", [])
    assert any(
        ref.get("uri", "").rstrip("/").endswith("/20")
        and ref.get("type") == "x-vbrief/github-issue"
        for ref in refs
    ), f"no x-vbrief/github-issue ref to issue #20 in {refs}"


def test_proposed_test_vbrief_references_issue_1() -> None:
    """The proposed scope used by the promote/demote stage references issue #1."""
    pd = json.loads(
        (
            _FIXTURE / "vbrief" / "proposed" / "test-1.vbrief.json"
        ).read_text(encoding="utf-8")
    )
    assert pd.get("plan", {}).get("status") == "proposed"
    refs = pd.get("plan", {}).get("references", [])
    assert any(
        ref.get("uri", "").rstrip("/").endswith("/1")
        and ref.get("type") == "x-vbrief/github-issue"
        for ref in refs
    ), f"no x-vbrief/github-issue ref to issue #1 in {refs}"
