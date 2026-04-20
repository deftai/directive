"""test_glossary.py -- Content tests for #457.

Verifies:
- `glossary.md` exists at the repo root.
- Contains all 13 required v0.20 vocabulary term labels.
- File length stays under 150 lines (single-page scope cap).
- Cross-references appear in `vbrief/vbrief.md`, `README.md`, and
  `UPGRADING.md`.

Story: #457 (Glossary v0.20 vocabulary)
"""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


REQUIRED_TERMS = (
    "Scope vBRIEF",
    "Lifecycle folder",
    "Plan-level narrative",
    "Item-level narrative",
    "Filename stem",
    "Cross-scope dependency",
    "Exit Commands",
    "Origin provenance",
    "Canonical narrative key",
    "Preparatory strategy",
    "Spec-generating strategy",
    "Rendered export",
    "Source of truth",
)


def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


class TestGlossaryFile:
    def test_glossary_exists(self) -> None:
        assert (_REPO_ROOT / "glossary.md").is_file(), (
            "glossary.md must exist at the repo root (#457)"
        )

    def test_glossary_under_150_lines(self) -> None:
        content = _read("glossary.md")
        line_count = len(content.splitlines())
        assert line_count < 150, (
            f"glossary.md must stay under 150 lines (#457); "
            f"current count: {line_count}"
        )

    def test_glossary_has_rfc2119_legend(self) -> None:
        content = _read("glossary.md")
        assert "RFC2119" in content or "RFC 2119" in content, (
            "glossary.md must declare its RFC2119 legend (#457)"
        )
        # Legend symbols
        assert "!=MUST" in content, "glossary.md legend must include !=MUST"
        assert "\u2297=MUST NOT" in content, (
            "glossary.md legend must include the \u2297 (MUST NOT) symbol"
        )


class TestGlossaryTerms:
    _text = _read("glossary.md")

    def test_all_13_terms_present(self) -> None:
        missing = [t for t in REQUIRED_TERMS if f"**{t}**" not in self._text]
        assert not missing, (
            f"glossary.md missing required term labels (#457): {missing}. "
            f"Each term must appear as **<Term>** bold."
        )

    def test_every_term_has_authoritative_cross_link(self) -> None:
        # Each term block should contain at least one markdown link.
        for term in REQUIRED_TERMS:
            # Find the bullet for this term, then scan the remainder of the
            # glossary for the first markdown link occurring after it.
            anchor = f"**{term}**"
            idx = self._text.find(anchor)
            assert idx != -1, f"{term!r} anchor missing"
            # Look at the term's bullet -- bullets end at the next blank line
            # or the next `- **` bullet start.
            remainder = self._text[idx:]
            # Extract until the next double-newline or next bullet
            stop = remainder.find("\n- **", 1)
            if stop == -1:
                stop = len(remainder)
            block = remainder[:stop]
            assert "](" in block, (
                f"Term {term!r} must include at least one markdown cross-link "
                f"to an authoritative doc/section (#457)."
            )


class TestGlossaryCrossReferences:
    def test_vbrief_md_links_to_glossary(self) -> None:
        content = _read("vbrief/vbrief.md")
        assert "glossary.md" in content, (
            "vbrief/vbrief.md must cross-link to glossary.md (#457)"
        )

    def test_readme_links_to_glossary(self) -> None:
        content = _read("README.md")
        assert "glossary.md" in content, (
            "README.md must include a one-line pointer to glossary.md (#457)"
        )

    def test_upgrading_md_links_to_glossary(self) -> None:
        content = _read("UPGRADING.md")
        assert "glossary.md" in content, (
            "UPGRADING.md v0.20 section must reference glossary.md (#457)"
        )
