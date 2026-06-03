"""tests/content/test_upgrading_bigjump_triage.py -- big-jump triage (#1115).

Contract test asserting UPGRADING.md exposes a discoverable top-of-file
big-jump triage entry point for multi-version upgrades:

- a `## Big-jump triage` section that appears before the first version
  section (so a multi-version upgrader sees it first);
- version-range buckets that name which sections apply, their apply-order
  (oldest applicable first), and whether each is auto-handled or manual;
- cross-references to QUICK-START.md and the canonical installer + doctor
  command surface that resolve to real heading anchors (kept consistent
  with #1114).

Story: #1115 (add a big-jump triage / entry point for multi-version upgrades).
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_UPGRADING = _REPO_ROOT / "UPGRADING.md"
_QUICK_START = _REPO_ROOT / "QUICK-START.md"

_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")

_TRIAGE_HEADING = "Big-jump triage"
_DOCTOR_ANCHOR = "canonical-installer--doctor-handoff-v037--epic-56-1339-1340-1409"


def _github_slug(heading_text: str) -> str:
    """Mirror GitHub's heading-anchor slug algorithm."""
    s = heading_text.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    return re.sub(r"\s", "-", s)


def _anchor_set(text: str) -> set[str]:
    """Compute the GitHub heading-anchor set for a markdown document.

    Skips fenced code blocks and applies github-slugger's duplicate-suffix
    rule (``slug``, ``slug-1``, ``slug-2`` ...).
    """
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING_RE.match(line)
        if not m:
            continue
        base = _github_slug(m.group(2))
        if base not in counts:
            counts[base] = 0
            anchors.add(base)
        else:
            counts[base] += 1
            anchors.add(f"{base}-{counts[base]}")
    return anchors


def _section_body(text: str, heading_substr: str, max_level: int) -> str:
    """Return the body of the first heading containing heading_substr."""
    lines = text.splitlines()
    start = None
    for idx, line in enumerate(lines):
        m = _HEADING_RE.match(line)
        if m and heading_substr in m.group(2):
            start = idx
            break
    assert start is not None, f"heading containing {heading_substr!r} not found"
    body: list[str] = []
    for line in lines[start + 1:]:
        m = _HEADING_RE.match(line)
        if m and len(m.group(1)) <= max_level:
            break
        body.append(line)
    return "\n".join(body)


def test_upgrading_exists() -> None:
    assert _UPGRADING.is_file(), f"Expected {_UPGRADING} (#1115)"


def test_big_jump_entry_point_is_discoverable() -> None:
    """The triage entry point MUST appear before the first version section so a
    multi-version upgrader self-routes without reading every section (a1)."""
    text = _UPGRADING.read_text(encoding="utf-8")
    triage_idx = text.find(f"## {_TRIAGE_HEADING}")
    assert triage_idx != -1, (
        "UPGRADING.md must expose a '## Big-jump triage' entry point (#1115)."
    )
    first_from_idx = text.find("\n## From ")
    canonical_idx = text.find("\n## Canonical installer")
    section_idxs = [i for i in (first_from_idx, canonical_idx) if i != -1]
    assert section_idxs, "UPGRADING.md must contain at least one version section"
    assert triage_idx < min(section_idxs), (
        "The big-jump triage entry point must appear before the first version "
        "section so it is the first thing a multi-version upgrader reads (#1115)."
    )


def test_triage_lists_version_buckets_with_apply_order() -> None:
    """The triage MUST map version-range buckets to apply-order (a1)."""
    text = _UPGRADING.read_text(encoding="utf-8")
    body = _section_body(text, _TRIAGE_HEADING, max_level=2)
    buckets = [ln for ln in body.splitlines() if ln.startswith("- **From")]
    assert len(buckets) >= 5, (
        f"The triage must enumerate the version-range buckets; found "
        f"{len(buckets)} (#1115)."
    )
    assert "apply-order" in body, (
        "The triage must spell out an explicit apply-order (#1115)."
    )
    assert "oldest" in body.lower(), (
        "The triage apply-order must name the oldest-applicable-first ordering "
        "(#1115)."
    )


def test_triage_flags_auto_vs_manual() -> None:
    """Each bucket MUST be flagged auto-handled vs manual (a1)."""
    text = _UPGRADING.read_text(encoding="utf-8")
    body = _section_body(text, _TRIAGE_HEADING, max_level=2)
    assert "auto-handled" in body, (
        "The triage must flag which buckets are auto-handled (#1115)."
    )
    assert "manual" in body, (
        "The triage must flag which buckets require manual steps (#1115)."
    )


def test_triage_references_quickstart_and_doctor_surface() -> None:
    """The triage MUST reference QUICK-START.md and the doctor command surface (a2)."""
    text = _UPGRADING.read_text(encoding="utf-8")
    body = _section_body(text, _TRIAGE_HEADING, max_level=2)
    assert "QUICK-START.md#" in body, (
        "The triage must cross-reference QUICK-START.md (#1115)."
    )
    assert "task doctor" in body, (
        "The triage must point multi-version upgraders at the doctor command "
        "surface (#1115)."
    )
    assert "deft-install --yes --upgrade --repo-root . --json" in body, (
        "The triage must name the canonical headless upgrade command as the "
        "final step (#1115)."
    )
    assert f"#{_DOCTOR_ANCHOR}" in body, (
        "The triage must link to the canonical installer + doctor handoff "
        "section (#1115)."
    )


def test_triage_cross_references_resolve() -> None:
    """Every anchor cross-reference in the triage MUST resolve to a real heading
    anchor in its target file (a2, a3)."""
    up_text = _UPGRADING.read_text(encoding="utf-8")
    qs_text = _QUICK_START.read_text(encoding="utf-8")
    up_anchors = _anchor_set(up_text)
    qs_anchors = _anchor_set(qs_text)
    body = _section_body(up_text, _TRIAGE_HEADING, max_level=2)

    checked = 0
    for _label, target in _LINK_RE.findall(body):
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        if "#" not in target:
            continue
        file_part, anchor = target.split("#", 1)
        file_part = file_part.lstrip("./")
        if file_part == "" or file_part.endswith("UPGRADING.md"):
            target_set, where = up_anchors, "UPGRADING.md"
        elif file_part.endswith("QUICK-START.md"):
            target_set, where = qs_anchors, "QUICK-START.md"
        else:
            continue
        assert anchor in target_set, (
            f"Big-jump triage links to {where}#{anchor}, which does not "
            f"resolve to any heading in {where} (#1115)."
        )
        checked += 1
    assert checked >= 7, (
        f"The triage should cross-link the version buckets and the QUICK-START "
        f"+ doctor surfaces; only {checked} anchor links were validated (#1115)."
    )


def test_doctor_anchor_actually_exists() -> None:
    """Guard the doctor-surface anchor token used by the triage (#1115)."""
    up_text = _UPGRADING.read_text(encoding="utf-8")
    assert _DOCTOR_ANCHOR in _anchor_set(up_text), (
        "The canonical installer + doctor handoff heading must exist so the "
        "triage's doctor-surface link resolves (#1115)."
    )
