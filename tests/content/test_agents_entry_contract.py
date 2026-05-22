"""tests/content/test_agents_entry_contract.py -- AGENTS.md template contract (#768).

Rail-agnostic conformance test for `templates/agents-entry.md` and the
companion `templates/agents-entry.placeholders.md` spec.

Asserts:
- `templates/agents-entry.md` carries both `<!-- deft:managed-section v3 -->`
  open and `<!-- /deft:managed-section -->` close markers, in that order.
- The placeholder spec file exists and documents each token used in the
  template body (and only documented tokens appear in the template).
- `_render_managed_section` extracts the bracketed bytes; the result
  starts with the open marker and ends with the close marker (no leading or
  trailing whitespace inside the inclusive slice).
- Byte-identical refresh: rendering twice produces byte-identical output.

Story: #768 (universal-upgrade-gate)
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_TEMPLATE = _REPO_ROOT / "templates" / "agents-entry.md"
_AGENTS_MD = _REPO_ROOT / "AGENTS.md"
_PLACEHOLDER_SPEC = _REPO_ROOT / "templates" / "agents-entry.placeholders.md"

_OPEN_MARKER = "<!-- deft:managed-section v3 -->"
_CLOSE_MARKER = "<!-- /deft:managed-section -->"

_TOKEN_RE = re.compile(r"\{\{([A-Z][A-Z0-9_]*)\}\}")


def _read_template() -> str:
    return _TEMPLATE.read_text(encoding="utf-8")


def _read_spec() -> str:
    return _PLACEHOLDER_SPEC.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Marker presence + ordering
# ---------------------------------------------------------------------------


def test_template_exists_at_expected_path() -> None:
    assert _TEMPLATE.is_file(), (
        f"Expected canonical AGENTS.md template at {_TEMPLATE} (#768)"
    )


def test_template_carries_open_marker() -> None:
    assert _OPEN_MARKER in _read_template(), (
        f"`{_TEMPLATE.name}` must include the deft:managed-section open marker (#768)"
    )


def test_template_carries_close_marker() -> None:
    assert _CLOSE_MARKER in _read_template(), (
        f"`{_TEMPLATE.name}` must include the deft:managed-section close marker (#768)"
    )


def test_open_marker_precedes_close_marker() -> None:
    text = _read_template()
    assert text.index(_OPEN_MARKER) < text.index(_CLOSE_MARKER), (
        "Open marker must appear before close marker (#768)"
    )


# ---------------------------------------------------------------------------
# Placeholder spec
# ---------------------------------------------------------------------------


def test_placeholder_spec_file_exists() -> None:
    assert _PLACEHOLDER_SPEC.is_file(), (
        f"Expected placeholder spec at {_PLACEHOLDER_SPEC} (#768)"
    )


def test_placeholder_spec_documents_known_tokens() -> None:
    """The spec MUST document each of the v1 inherited tokens."""
    spec = _read_spec()
    for token in (
        "UPSTREAM_SHA",
        "UPSTREAM_REF",
        "UPSTREAM_TAG",
        "FETCHED_AT",
        "FETCHED_BY",
    ):
        assert f"{{{{{token}}}}}" in spec, (
            f"Placeholder spec must document token `{{{{{token}}}}}` (#768)"
        )


def test_template_uses_only_documented_tokens() -> None:
    """If the template body contains placeholder tokens, each MUST appear in the spec.

    Custom tokens are allowed via the spec's extension policy, but they
    MUST first land in the spec; this test fails when an undocumented
    placeholder appears in the template body so the spec stays the
    single source of truth.
    """
    template = _read_template()
    spec = _read_spec()
    used_tokens = set(_TOKEN_RE.findall(template))
    documented_tokens = set(_TOKEN_RE.findall(spec))
    undocumented = used_tokens - documented_tokens
    assert not undocumented, (
        f"Undocumented placeholder tokens found in template: {sorted(undocumented)}. "
        "Add them to templates/agents-entry.placeholders.md (#768)"
    )


# ---------------------------------------------------------------------------
# Renderer output (byte-identical refresh)
# ---------------------------------------------------------------------------


def test_render_managed_section_extracts_bracketed_block(deft_run_module) -> None:
    """`_render_managed_section` returns the inclusive bracketed slice.

    Underscore-prefixed names are not re-exported through `from x import *`
    in `run.py`; tests therefore access them via the underlying ``deft_run``
    module rather than the ``deft_module`` re-export shim.
    """
    rendered = deft_run_module._render_managed_section(_read_template())
    assert rendered is not None
    assert rendered.startswith(_OPEN_MARKER)
    assert rendered.endswith(_CLOSE_MARKER)


def test_render_is_byte_stable(deft_run_module) -> None:
    """Two consecutive render calls produce byte-identical output."""
    template = _read_template()
    first = deft_run_module._render_managed_section(template)
    second = deft_run_module._render_managed_section(template)
    assert first == second


# ---------------------------------------------------------------------------
# Implementation Intent Gate (#810)
# ---------------------------------------------------------------------------


def _managed_section_text() -> str:
    """Slice the managed-section bytes inclusive of the markers."""
    text = _read_template()
    start = text.index(_OPEN_MARKER)
    end = text.index(_CLOSE_MARKER) + len(_CLOSE_MARKER)
    return text[start:end]


def test_managed_section_contains_implementation_intent_gate_anchor() -> None:
    """The managed section MUST surface the Implementation Intent Gate block (#810).

    Pinning the literal anchor 'Implementation Intent Gate' (and not the
    surrounding prose) lets the bullets evolve while keeping the section
    discoverable by future agents searching for it.
    """
    section = _managed_section_text()
    assert "Implementation Intent Gate" in section, (
        "templates/agents-entry.md managed section MUST contain the "
        "'Implementation Intent Gate' anchor (#810). The block is the "
        "prompt-side guardrail propagated by cmd_agents_refresh."
    )


def test_managed_section_implementation_intent_gate_has_four_bullets() -> None:
    """The Implementation Intent Gate block MUST contain at least four bullets.

    Counts list items starting with `- ` between the gate's heading and
    the next `## ` (or end of managed section). Pinning the count, not
    exact wording, lets future copy-edits adjust phrasing without
    breaking the contract (#810).
    """
    section = _managed_section_text()
    # Locate the gate region: from the anchor heading to the next `## `
    # heading or close marker.
    anchor_idx = section.index("Implementation Intent Gate")
    rest = section[anchor_idx:]
    # Next top-level section starts with `\n## ` (two hashes, space).
    next_section = re.search(r"\n## ", rest)
    region = rest[: next_section.start()] if next_section else rest
    bullets = [line for line in region.splitlines() if line.lstrip().startswith("- ")]
    assert len(bullets) >= 4, (
        f"Implementation Intent Gate block MUST contain at least 4 bullets "
        f"(found {len(bullets)}). Refs #810."
    )


def test_managed_section_implementation_intent_gate_uses_required_tokens() -> None:
    """The Implementation Intent Gate block MUST mix `!` and `⊗` prefix tokens.

    Per #810: at least 2 bullets carry the `!` (MUST) prefix and at
    least 2 carry the `⊗` (MUST NOT) prefix. Pinning token counts (not
    exact wording) preserves the prohibition / requirement balance
    while letting copy-edits land freely.
    """
    section = _managed_section_text()
    anchor_idx = section.index("Implementation Intent Gate")
    rest = section[anchor_idx:]
    next_section = re.search(r"\n## ", rest)
    region = rest[: next_section.start()] if next_section else rest

    must_count = 0
    forbid_count = 0
    for line in region.splitlines():
        stripped = line.lstrip()
        if not stripped.startswith("- "):
            continue
        body = stripped[2:].lstrip()
        if body.startswith("! "):
            must_count += 1
        elif body.startswith("\u2297 "):
            forbid_count += 1

    assert must_count >= 2, (
        f"Implementation Intent Gate MUST have at least 2 `!` bullets "
        f"(found {must_count}). Refs #810."
    )
    assert forbid_count >= 2, (
        f"Implementation Intent Gate MUST have at least 2 `⊗` bullets "
        f"(found {forbid_count}). Refs #810."
    )


# ---------------------------------------------------------------------------
# Maintainer <-> template propagation gate (#1309)
#
# Curated marker list shared by both `AGENTS.md` (maintainer) and
# `templates/agents-entry.md` (consumer template). Match is whitespace-
# normalised substring containment so em-dash spacing churn cannot poison
# the gate, but the markers themselves are distinctive enough (header
# anchors with issue numbers, full command-and-flag strings) to avoid
# substring collisions. Add a new marker here in the same PR that adds a
# consumer-relevant rule to either file -- see the maintainer
# `## Template propagation discipline (#1309)` block for the rule body.
# ---------------------------------------------------------------------------

_PROPAGATION_COMMAND_MARKERS: tuple[str, ...] = (
    # ``task triage:welcome --onboard`` is explicit on both sides (it's also a
    # substring containing ``task triage:welcome``, so the bare-form marker
    # would silently pass a divergence -- per Greptile P1 on the #1309 PR).
    "task triage:welcome --onboard",
    "task triage:queue",
    "task verify:cache-fresh",
    "task verify:branch",
    "task doctor",
    "task agents:refresh",
)

_PROPAGATION_POLICY_KEY_MARKERS: tuple[str, ...] = (
    "plan.policy.wipCap",
    "plan.policy.allowDirectCommitsToMaster",
)

_PROPAGATION_HEADER_MARKERS: tuple[str, ...] = (
    "## Session-start ritual (#1149)",
    "## Cache-as-authoritative work selection (#1149)",
    "## Skill Routing",
    "## WIP cap",
)

#: The action-verb directive list (#810) is a SINGLE assertion -- the list
#: itself is the gate, not each verb individually. Each token MUST appear in
#: both files within the same managed-section / discoverable surface.
_PROPAGATION_ACTION_VERBS: tuple[str, ...] = (
    "build",
    "implement",
    "ship",
    "swarm",
    "run agents",
    "start agent",
)


def _normalize_whitespace(text: str) -> str:
    """Collapse all runs of whitespace (incl. tabs, CRLF, NBSP) to single spaces.

    Matches the whitespace-normalisation contract from the #1309 vBRIEF:
    the propagation gate keys off content, not formatting drift, so any
    span of one-or-more whitespace characters compares equal to a single
    ASCII space. NBSP (U+00A0) is folded into ASCII space too because em-dash
    spacing in markdown rendering occasionally substitutes one for the other.
    """
    folded = text.replace("\u00a0", " ")
    return " ".join(folded.split())


def _read_agents_md() -> str:
    return _AGENTS_MD.read_text(encoding="utf-8")


def _missing_markers(haystack_text: str, markers: tuple[str, ...]) -> list[str]:
    """Return every marker absent from ``haystack_text`` (whitespace-normalised)."""
    haystack = _normalize_whitespace(haystack_text)
    return [m for m in markers if _normalize_whitespace(m) not in haystack]


def test_propagation_command_markers_present_in_both_files() -> None:
    """#1309: every curated command MUST appear in AGENTS.md AND the template."""
    template = _read_template()
    agents = _read_agents_md()
    template_missing = _missing_markers(template, _PROPAGATION_COMMAND_MARKERS)
    agents_missing = _missing_markers(agents, _PROPAGATION_COMMAND_MARKERS)
    assert not template_missing, (
        "templates/agents-entry.md missing command marker(s) from the #1309 "
        f"propagation gate: {template_missing}. Extend the template or the "
        "_PROPAGATION_COMMAND_MARKERS list in the same PR."
    )
    assert not agents_missing, (
        "AGENTS.md missing command marker(s) from the #1309 propagation "
        f"gate: {agents_missing}. Add the rule on the maintainer side or "
        "trim the marker list -- the two files MUST stay in lockstep."
    )


def test_propagation_policy_key_markers_present_in_both_files() -> None:
    """#1309: typed `plan.policy.*` keys MUST be named in both surfaces."""
    template = _read_template()
    agents = _read_agents_md()
    template_missing = _missing_markers(template, _PROPAGATION_POLICY_KEY_MARKERS)
    agents_missing = _missing_markers(agents, _PROPAGATION_POLICY_KEY_MARKERS)
    assert not template_missing, (
        "templates/agents-entry.md missing policy-key marker(s) from the "
        f"#1309 propagation gate: {template_missing}."
    )
    assert not agents_missing, (
        "AGENTS.md missing policy-key marker(s) from the #1309 propagation "
        f"gate: {agents_missing}."
    )


def test_propagation_header_markers_present_in_both_files() -> None:
    """#1309: distinctive headers MUST appear verbatim in both files."""
    template = _read_template()
    agents = _read_agents_md()
    template_missing = _missing_markers(template, _PROPAGATION_HEADER_MARKERS)
    agents_missing = _missing_markers(agents, _PROPAGATION_HEADER_MARKERS)
    assert not template_missing, (
        "templates/agents-entry.md missing distinctive header(s) from the "
        f"#1309 propagation gate: {template_missing}. The header itself is "
        "the marker; mirror the maintainer wording exactly."
    )
    assert not agents_missing, (
        "AGENTS.md missing distinctive header(s) from the #1309 propagation "
        f"gate: {agents_missing}."
    )


def test_propagation_action_verb_list_present_in_both_files() -> None:
    """#1309: the #810 action-verb directive list MUST appear in both files.

    Single combined assertion -- the LIST is the gate, not each verb in
    isolation. The verbs land together inside the Implementation Intent
    Gate's `!` MUST rule on both surfaces.
    """
    template = _read_template()
    agents = _read_agents_md()
    template_missing = _missing_markers(template, _PROPAGATION_ACTION_VERBS)
    agents_missing = _missing_markers(agents, _PROPAGATION_ACTION_VERBS)
    assert not template_missing, (
        "templates/agents-entry.md missing action-verb directive list "
        f"token(s) from the #1309 propagation gate (#810): {template_missing}."
    )
    assert not agents_missing, (
        "AGENTS.md missing action-verb directive list token(s) from the "
        f"#1309 propagation gate (#810): {agents_missing}."
    )
