"""tests/content/test_quickstart_combined_remediation.py -- Case G+H (#1114).

Contract test asserting QUICK-START.md documents the combined Case G+H
remediation path for a big-jump upgrade where AGENTS.md is stale (Case G)
AND pre-cutover artifacts are present (Case H):

- a 2b "Big-jump joint check" gate that detects the joint condition and
  routes to Case G+H instead of Case G;
- a "### Case G+H" section that orders the AGENTS.md refresh ahead of the
  migration and emits exactly ONE restart instruction;
- the documented byte-identical-to-running-separately guarantee; and
- a cross-reference into UPGRADING.md's big-jump triage entry point that
  resolves to a real heading anchor (kept consistent with #1115).

Story: #1114 (combine QUICK-START Case G + Case H into one session).
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_QUICK_START = _REPO_ROOT / "QUICK-START.md"
_UPGRADING = _REPO_ROOT / "UPGRADING.md"

_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")


def _github_slug(heading_text: str) -> str:
    """Mirror GitHub's heading-anchor slug algorithm.

    Lowercase, drop everything that is not a word char / whitespace /
    hyphen, then map each whitespace char to a hyphen (no collapsing).
    """
    s = heading_text.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    return re.sub(r"\s", "-", s)


def _anchor_set(text: str) -> set[str]:
    """Compute the set of GitHub heading anchors for a markdown document.

    Skips fenced code blocks so ``# comment`` lines inside ```` ``` ````
    blocks are not mistaken for headings, and applies github-slugger's
    duplicate-suffix rule (``slug``, ``slug-1``, ``slug-2`` ...).
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
    """Return the body of the first heading whose text contains heading_substr.

    The body runs until the next heading at level <= max_level.
    """
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


def test_quick_start_exists() -> None:
    assert _QUICK_START.is_file(), f"Expected {_QUICK_START} (#1114)"


def test_joint_check_gate_present_in_detection() -> None:
    """Step 2 detection MUST document the joint big-jump check that routes
    a stale-AGENTS.md + pre-cutover project to Case G+H (a1)."""
    text = _QUICK_START.read_text(encoding="utf-8")
    step3_idx = text.find("## Step 3")
    assert step3_idx != -1, "QUICK-START.md must retain its Step 3 heading"
    gate_idx = text.find("Big-jump joint check")
    assert gate_idx != -1, (
        "QUICK-START.md Step 2 must document a 'Big-jump joint check' that "
        "detects the joint stale-AGENTS.md + pre-cutover condition (#1114)."
    )
    assert gate_idx < step3_idx, (
        "The joint check must live in the Step 2 detection phase, before Step 3."
    )
    gate_window = text[gate_idx:step3_idx]
    for token in ("Case G+H", "pre-cutover", "Case G", "Case H"):
        assert token in gate_window, (
            f"Joint-check gate is missing required token {token!r} (#1114)."
        )
    assert "jump to **Case G+H**" in gate_window or "Case G+H" in gate_window, (
        "The joint check must route to Case G+H (#1114)."
    )


def test_combined_case_section_present() -> None:
    text = _QUICK_START.read_text(encoding="utf-8")
    assert "### Case G+H" in text, (
        "QUICK-START.md must document a '### Case G+H' combined remediation "
        "section (#1114)."
    )


def test_combined_case_orders_refresh_before_migration() -> None:
    """The combined path MUST run the AGENTS.md refresh before the migration (a1)."""
    text = _QUICK_START.read_text(encoding="utf-8")
    body = _section_body(text, "Case G+H", max_level=3)
    assert "AGENTS.md refresh first, migration second" in body, (
        "Case G+H must state the canonical ordering "
        "'AGENTS.md refresh first, migration second' (#1114)."
    )
    refresh_idx = body.find("Refresh AGENTS.md first")
    migration_idx = body.find("Run migration second")
    assert refresh_idx != -1 and migration_idx != -1, (
        "Case G+H must contain a refresh step and a migration step (#1114)."
    )
    assert refresh_idx < migration_idx, (
        "Case G+H must order the AGENTS.md refresh step before the migration "
        "step (#1114)."
    )


def test_combined_case_emits_single_restart() -> None:
    """The combined path MUST collapse the two restarts into exactly one (a1)."""
    text = _QUICK_START.read_text(encoding="utf-8")
    body = _section_body(text, "Case G+H", max_level=3)
    assert "EXACTLY ONCE" in body, (
        "Case G+H must instruct the single restart EXACTLY ONCE (#1114)."
    )
    assert "Do NOT emit a second restart" in body, (
        "Case G+H must forbid emitting a second restart instruction (#1114)."
    )
    # Defers the per-case restarts so only one is emitted.
    assert "step-5 restart" in body and "step 8 (restart)" in body, (
        "Case G+H must defer the Case G and Case H restart instructions so a "
        "single restart is emitted at the end (#1114)."
    )


def test_combined_case_documents_equivalent_end_state() -> None:
    """The combined path MUST document the byte-identical-to-separate guarantee (a2)."""
    text = _QUICK_START.read_text(encoding="utf-8")
    body = _section_body(text, "Case G+H", max_level=3)
    assert "byte-identical" in body, (
        "Case G+H must state the end state is byte-identical to running the "
        "cases separately (#1114, acceptance a2)."
    )
    assert "separately" in body, (
        "Case G+H must compare against running Case G and Case H separately "
        "(#1114, acceptance a2)."
    )


def test_combined_case_cross_reference_resolves() -> None:
    """The Case G+H cross-reference into UPGRADING.md must resolve to a real
    anchor, keeping the QUICK-START <-> UPGRADING references consistent (#1114/#1115)."""
    qs_text = _QUICK_START.read_text(encoding="utf-8")
    up_text = _UPGRADING.read_text(encoding="utf-8")
    up_anchors = _anchor_set(up_text)
    body = _section_body(qs_text, "Case G+H", max_level=3)

    upgrading_links = [
        target
        for _label, target in _LINK_RE.findall(body)
        if "UPGRADING.md#" in target
    ]
    assert upgrading_links, (
        "Case G+H must cross-reference UPGRADING.md's big-jump triage entry "
        "point (#1114)."
    )
    for target in upgrading_links:
        anchor = target.split("#", 1)[1]
        assert anchor in up_anchors, (
            f"Case G+H links to UPGRADING.md#{anchor}, which does not resolve "
            f"to any heading in UPGRADING.md (#1114)."
        )
