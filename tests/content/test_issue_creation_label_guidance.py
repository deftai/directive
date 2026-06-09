"""Content tests for issue-creation label hygiene guidance (#1510)."""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_ISSUE_CREATION_SKILLS = (
    "skills/deft-directive-triage/SKILL.md",
    "skills/deft-directive-refinement/SKILL.md",
    "skills/deft-directive-gh-slice/SKILL.md",
    "skills/deft-directive-gh-arch/SKILL.md",
    "skills/deft-directive-article-review/SKILL.md",
)


def _read(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


def test_issue_creation_guidance_uses_existing_repo_labels() -> None:
    """Issue-filing guidance SHOULD use the repository's existing labels."""
    for rel_path in _ISSUE_CREATION_SKILLS:
        text = _read(rel_path)
        assert "gh label list" in text or "labels API" in text, (
            f"{rel_path}: issue-label guidance must fetch existing labels with "
            "`gh label list` or the labels API (#1510)"
        )
        assert "existing label" in text.lower(), (
            f"{rel_path}: issue-label guidance must choose from the repository's "
            "existing label set (#1510)"
        )


def test_issue_creation_guidance_allows_explicit_no_label_note() -> None:
    """No-label issue creation remains allowed when it is deliberate."""
    for rel_path in _ISSUE_CREATION_SKILLS:
        text = _read(rel_path)
        assert "no label was applied" in text.lower(), (
            f"{rel_path}: guidance must tell agents to explicitly note when no "
            "label was applied (#1510)"
        )


def test_issue_creation_guidance_is_recommend_not_mandate() -> None:
    """Label hygiene is a soft nudge, not an issue-creation gate."""
    for rel_path in _ISSUE_CREATION_SKILLS:
        text = _read(rel_path).lower()
        assert "recommendation, not a gate" in text or "not a gate" in text, (
            f"{rel_path}: guidance must preserve recommend-not-mandate semantics "
            "(#1510)"
        )
        assert (
            "do not block issue creation" in text
            or "block issue creation solely because no label was selected" in text
        ), (
            f"{rel_path}: guidance must not hard-gate issue creation when no "
            "label fits (#1510)"
        )


def test_issue_creation_guidance_forbids_ad_hoc_labels() -> None:
    """Agents must not mint one-off labels outside the repo label set."""
    for rel_path in _ISSUE_CREATION_SKILLS:
        text = _read(rel_path).lower()
        assert (
            "do not invent ad hoc labels" in text
            or "invent ad hoc labels outside the repository's existing label set" in text
        ), (
            f"{rel_path}: guidance must forbid inventing ad hoc labels (#1510)"
        )


def test_triage_skill_documents_label_hygiene_rationale() -> None:
    """Triage skill should explain why unlabeled issues matter."""
    text = _read("skills/deft-directive-triage/SKILL.md").lower()
    for phrase in (
        "triage queue ranking",
        "issue gauges",
        "hygiene sweeps",
        "lifecycle reconciliation",
    ):
        assert phrase in text, (
            "skills/deft-directive-triage/SKILL.md: label hygiene rationale "
            f"must mention {phrase!r} (#1510)"
        )
