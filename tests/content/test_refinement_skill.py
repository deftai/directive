"""Deterministic content tests for the rewritten refinement Phase 0 (N1 / #1141).

Pin the cache-first Phase 0 structure landed under #1141 so a future edit that
silently drops a sub-phase, the canonical task verbs, the See-also footer, the
empty-cache backward-compat fallback prompt, or the `task scope:undo` row in
the Phase 4 verb table fails CI immediately.

Mirrors the existing `tests/content/test_triage_skill.py` and
`tests/content/test_swarm_skill.py` patterns -- file-level content lookups
against the real skill body via `pathlib`.

Refs:
  - #1141 (N1 -- this rewrite)
  - #1119 (umbrella -- Wave-2d-1)
  - #1122 (D2 -- `task triage:summary`)
  - #1128 (D11 -- `task triage:queue`)
  - #1123 (D3 -- `[RESUME]` tagging)
  - #1130 (D6 -- `skills/deft-directive-triage/SKILL.md`)
  - #1134 (D15 -- `task scope:undo`)
  - #1143 (N3 -- `task triage:welcome`)
"""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_REFINEMENT_PATH = "skills/deft-directive-refinement/SKILL.md"


def _read(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Phase 0 -- three sub-phases in canonical order (0a -> 0b -> 0c)
# ---------------------------------------------------------------------------


def test_refinement_phase0_top_heading_present() -> None:
    """Phase 0 MUST be a top-level (## ) heading with the #1141 callout."""
    text = _read(_REFINEMENT_PATH)
    assert "## Phase 0 -- Triage-first consultation (cache-first, #1141)" in text, (
        f"{_REFINEMENT_PATH}: missing canonical Phase 0 heading "
        f"'## Phase 0 -- Triage-first consultation (cache-first, #1141)' (N1)"
    )


def test_refinement_phase0_three_subphases_in_canonical_order() -> None:
    """Phase 0a / 0b / 0c MUST each be a `### ` heading and appear in that order."""
    text = _read(_REFINEMENT_PATH)
    heading_0a = "### Phase 0a -- Triage gate (`task triage:summary`)"
    heading_0b = "### Phase 0b -- Cache-first ingestion (`task triage:queue --state=accept`)"
    heading_0c = "### Phase 0c -- Resume conditions (`[RESUME]`-tagged items first)"

    for heading in (heading_0a, heading_0b, heading_0c):
        assert heading in text, (
            f"{_REFINEMENT_PATH}: missing sub-phase heading {heading!r} (N1 / #1141)"
        )

    idx_0a = text.index(heading_0a)
    idx_0b = text.index(heading_0b)
    idx_0c = text.index(heading_0c)
    assert idx_0a < idx_0b < idx_0c, (
        f"{_REFINEMENT_PATH}: Phase 0 sub-phases out of canonical order "
        f"(expected 0a -> 0b -> 0c; got positions {idx_0a} / {idx_0b} / {idx_0c}) "
        f"(N1 / #1141)"
    )


def test_refinement_phase0_sub_phases_inside_phase0_section() -> None:
    """All three sub-phase headings MUST live inside the Phase 0 section."""
    text = _read(_REFINEMENT_PATH)
    phase0_start = text.index("## Phase 0 -- Triage-first consultation (cache-first, #1141)")
    phase1_start = text.index("## Phase 1 -- Ingest")
    phase0_body = text[phase0_start:phase1_start]
    for heading in (
        "### Phase 0a -- Triage gate (`task triage:summary`)",
        "### Phase 0b -- Cache-first ingestion (`task triage:queue --state=accept`)",
        "### Phase 0c -- Resume conditions (`[RESUME]`-tagged items first)",
    ):
        assert heading in phase0_body, (
            f"{_REFINEMENT_PATH}: sub-phase {heading!r} must live inside the "
            f"Phase 0 section, not after Phase 1 (N1 / #1141)"
        )


# ---------------------------------------------------------------------------
# 2. Canonical task verbs / surfaces invoked from Phase 0
# ---------------------------------------------------------------------------


def test_refinement_phase0_invokes_triage_summary() -> None:
    """Phase 0a MUST invoke `task triage:summary` (D2 / #1122)."""
    text = _read(_REFINEMENT_PATH)
    assert "task triage:summary" in text, (
        f"{_REFINEMENT_PATH}: Phase 0a must invoke `task triage:summary` "
        f"(D2 / #1122) (N1 / #1141)"
    )
    assert "#1122" in text, (
        f"{_REFINEMENT_PATH}: must cite D2 / #1122 alongside `task triage:summary`"
    )


def test_refinement_phase0_consumes_triage_queue_accept_state() -> None:
    """Phase 0b MUST consume `task triage:queue --state=accept` (D11 / #1128)."""
    text = _read(_REFINEMENT_PATH)
    assert "task triage:queue --state=accept" in text, (
        f"{_REFINEMENT_PATH}: Phase 0b must consume "
        f"`task triage:queue --state=accept` (D11 / #1128) (N1 / #1141)"
    )
    assert "#1128" in text, (
        f"{_REFINEMENT_PATH}: must cite D11 / #1128 alongside `task triage:queue`"
    )


def test_refinement_phase0_references_resume_tag_and_d3() -> None:
    """Phase 0c MUST reference `[RESUME]`-tagged items and cite D3 / #1123."""
    text = _read(_REFINEMENT_PATH)
    assert "[RESUME]" in text, (
        f"{_REFINEMENT_PATH}: Phase 0c must reference the `[RESUME]` tag class "
        f"(N1 / #1141)"
    )
    assert "#1123" in text, (
        f"{_REFINEMENT_PATH}: must cite D3 / #1123 alongside the `[RESUME]` tag "
        f"(it is the producer of resume-eligible audit entries) (N1 / #1141)"
    )


def test_refinement_phase0_stale_defer_priority_documented() -> None:
    """Phase 0c MUST document that stale-defer (RESUME) takes priority over fresh untriaged."""
    text = _read(_REFINEMENT_PATH)
    assert "Stale-defer" in text or "stale-defer" in text, (
        f"{_REFINEMENT_PATH}: Phase 0c must document stale-defer priority "
        f"(N1 / #1141 issue body)"
    )
    # Sentence in the issue body: "Stale-defer items take priority over fresh untriaged"
    assert "take priority over fresh untriaged" in text, (
        f"{_REFINEMENT_PATH}: Phase 0c must carry the canonical priority phrasing "
        f"`take priority over fresh untriaged` (N1 / #1141)"
    )


# ---------------------------------------------------------------------------
# 3. Empty-cache backward-compat fallback prompt
# ---------------------------------------------------------------------------


def test_refinement_phase0_empty_cache_fallback_prompt_points_at_triage_welcome() -> None:
    """The empty-cache fallback MUST point operators at `task triage:welcome` (N3 / #1143)."""
    text = _read(_REFINEMENT_PATH)
    assert "task triage:welcome" in text, (
        f"{_REFINEMENT_PATH}: empty-cache fallback must point at "
        f"`task triage:welcome` (N3 / #1143) per the #1141 backward-compat "
        f"contract"
    )
    assert "#1143" in text, (
        f"{_REFINEMENT_PATH}: must cite N3 / #1143 alongside `task triage:welcome`"
    )


def test_refinement_phase0_empty_cache_fallback_block_present() -> None:
    """The empty-cache fallback block MUST be inside Phase 0a and mention `stderr`.

    The orchestrator scope is explicit: "emit a clear stderr prompt pointing
    at `task triage:welcome` (N3 / #1143) before any folder scan."
    """
    text = _read(_REFINEMENT_PATH)
    phase0a_start = text.index("### Phase 0a -- Triage gate")
    phase0b_start = text.index("### Phase 0b -- Cache-first ingestion")
    phase0a_body = text[phase0a_start:phase0b_start]
    assert "Empty-cache backward-compat fallback" in phase0a_body, (
        f"{_REFINEMENT_PATH}: Phase 0a must carry the labelled "
        f"`Empty-cache backward-compat fallback` block (N1 / #1141)"
    )
    assert "stderr" in phase0a_body, (
        f"{_REFINEMENT_PATH}: Phase 0a empty-cache fallback must mention `stderr` "
        f"per the orchestrator scope (N1 / #1141)"
    )
    assert "task triage:welcome" in phase0a_body, (
        f"{_REFINEMENT_PATH}: Phase 0a empty-cache fallback must point at "
        f"`task triage:welcome` (N3 / #1143)"
    )


# ---------------------------------------------------------------------------
# 4. Phase 4 verb table includes `task scope:undo` (D15 / #1134)
# ---------------------------------------------------------------------------


def test_refinement_phase4_verb_table_includes_scope_undo() -> None:
    """Phase 4 Available Commands MUST list `task scope:undo` (D15 / #1134)."""
    text = _read(_REFINEMENT_PATH)
    phase4_start = text.index("## Phase 4 -- Promote/Demote")
    phase5_start = text.index("## Phase 5 -- Prioritize")
    phase4_body = text[phase4_start:phase5_start]

    assert "`task scope:undo" in phase4_body, (
        f"{_REFINEMENT_PATH}: Phase 4 verb table must include "
        f"`task scope:undo <file>` (D15 / #1134) per the N1 / #1141 "
        f"acceptance criteria"
    )
    assert "#1134" in phase4_body, (
        f"{_REFINEMENT_PATH}: Phase 4 scope:undo row must cite D15 / #1134 "
        f"so the row is forward-correct documentation"
    )


# ---------------------------------------------------------------------------
# 5. See-also footer pointing at the upstream triage skill
# ---------------------------------------------------------------------------


def test_refinement_see_also_footer_present() -> None:
    """A `## See also` footer MUST exist."""
    text = _read(_REFINEMENT_PATH)
    assert "\n## See also\n" in text, (
        f"{_REFINEMENT_PATH}: missing `## See also` footer (N1 / #1141 "
        f"acceptance criterion)"
    )


def test_refinement_see_also_footer_points_at_triage_skill() -> None:
    """The See-also footer MUST point at `skills/deft-directive-triage/SKILL.md`."""
    text = _read(_REFINEMENT_PATH)
    footer_idx = text.rindex("## See also")
    footer = text[footer_idx:]
    assert "deft-directive-triage/SKILL.md" in footer, (
        f"{_REFINEMENT_PATH}: See-also footer must point at "
        f"`skills/deft-directive-triage/SKILL.md` (D6 / #1130) as the upstream "
        f"skill (N1 / #1141)"
    )
    # The footer should call out the upstream-skill role explicitly so a
    # casual reader knows which direction the dependency flows.
    assert "Upstream skill" in footer or "upstream skill" in footer, (
        f"{_REFINEMENT_PATH}: See-also footer must identify the triage skill "
        f"as the upstream skill (N1 / #1141 acceptance criterion)"
    )


def test_refinement_see_also_footer_cites_all_consumed_surfaces() -> None:
    """See-also footer MUST cite the consumed surfaces D2 / D11 / D3 / D6 / D15 / N3."""
    text = _read(_REFINEMENT_PATH)
    footer_idx = text.rindex("## See also")
    footer = text[footer_idx:]
    for issue_ref in ("#1122", "#1128", "#1123", "#1130", "#1134", "#1143", "#1141"):
        assert issue_ref in footer, (
            f"{_REFINEMENT_PATH}: See-also footer must cite {issue_ref} so the "
            f"cross-reference web is traceable (N1 / #1141)"
        )


# ---------------------------------------------------------------------------
# 6. Pre-#1141 action-menu walk is gone (no `task triage:accept|reject|defer`
# decision verbs in Phase 0). Refinement is now a consumer, not a producer.
# ---------------------------------------------------------------------------


def test_refinement_phase0_does_not_route_decision_verbs() -> None:
    """Phase 0 MUST NOT route through the `task triage:accept|reject|defer|...` decision verbs.

    Pre-#1141 the action menu walked each candidate through these verbs; the
    rewrite moves that responsibility into `skills/deft-directive-triage/SKILL.md`
    (D6 / #1130). Refinement is now strictly a consumer of `state=accept` and
    `[RESUME]` queue rows.
    """
    text = _read(_REFINEMENT_PATH)
    phase0_start = text.index("## Phase 0 -- Triage-first consultation (cache-first, #1141)")
    phase1_start = text.index("## Phase 1 -- Ingest")
    phase0_body = text[phase0_start:phase1_start]

    # The forbidden surface is the action-menu-style enumeration of decision
    # verbs. We pin the literal pipe-separated form that the pre-#1141 body
    # carried so a future edit that re-introduces it fails the gate.
    forbidden = "task triage:accept|reject|defer|needs-ac|mark-duplicate"
    assert forbidden not in phase0_body, (
        f"{_REFINEMENT_PATH}: Phase 0 must NOT route through the decision-verb "
        f"action menu ({forbidden!r}); decisions belong to the triage skill "
        f"(D6 / #1130) -- refinement is a consumer only (N1 / #1141)"
    )
