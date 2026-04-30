"""tests/content/test_agents_entry_contract.py -- AGENTS.md template contract (#768).

Rail-agnostic conformance test for `templates/agents-entry.md` and the
companion `templates/agents-entry.placeholders.md` spec.

Asserts:
- `templates/agents-entry.md` carries both `<!-- deft:managed-section v1 -->`
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
_PLACEHOLDER_SPEC = _REPO_ROOT / "templates" / "agents-entry.placeholders.md"

_OPEN_MARKER = "<!-- deft:managed-section v1 -->"
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
