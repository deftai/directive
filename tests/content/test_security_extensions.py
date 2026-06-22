"""
test_security_extensions.py -- Deterministic content regression for the
three Wave 2 security cohort extensions to `coding/security.md`:

* #587 -- No-read-secret rule for agent systems
* #686 -- Tool-call safety is independent of text-level safety
* #708 -- Destructive-op guardrails (env-isolation + irreversibility gates)
          plus the `incidents/` library and seed entry

Per the Rule Authority [AXIOM] in `main.md` the strongest applicable
encoding tier for a prose rule is a deterministic content test. This
module pins:

1. Each new section heading is present in `coding/security.md`.
2. Each new section carries the load-bearing MUST + MUST NOT tokens.
3. Each new section cross-references its companion artefacts.
4. The `incidents/` library exists with README, template, and seed entry.
5. The seed entry cross-references the rule body for #587, #686, and #708.

A future rename, section drop, or accidental deletion of any cross-
reference fails this lane before the change can land via `task check`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

SECURITY_MD = _REPO_ROOT / "content/coding/security.md"
# Post-#1875 C3 split: the shippable library files (README + template) moved
# under content/incidents/; the dated incident records stay at root incidents/.
INCIDENTS_DIR = _REPO_ROOT / "incidents"
CONTENT_INCIDENTS_DIR = _REPO_ROOT / "content/incidents"
INCIDENTS_README = CONTENT_INCIDENTS_DIR / "README.md"
INCIDENTS_TEMPLATE = CONTENT_INCIDENTS_DIR / "_template.md"
INCIDENTS_SEED = INCIDENTS_DIR / "2026-04-pocketos-railway-prod-db-wipe.md"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")

def _locate_section(text: str, heading: str) -> int:
    """Return the index of the section ``heading`` in ``text``, anchored
    on a newline boundary so prose mentions (e.g. cross-references from
    earlier sections) do not capture the lookup. Fails the test with a
    descriptive ``AssertionError`` when the heading is absent (instead
    of leaking a raw ``ValueError`` from ``str.index``)."""
    anchored = "\n" + heading
    idx = text.find(anchored)
    assert idx >= 0, (
        f"coding/security.md: section heading {heading!r} not "
        f"found at a newline-anchored position -- the section-specific "
        f"test that consumes this lookup cannot proceed."
    )
    return idx + 1  # skip the leading newline so the caller's slice
    # window starts at the heading itself.


# ---------------------------------------------------------------------------
# Section headings
# ---------------------------------------------------------------------------

NEW_SECTION_HEADINGS = (
    "## No-Read-Secret Rule for Agent Systems (#587)",
    "## Tool-Call Safety Is Independent of Text-Level Safety (#686)",
    "## Destructive-Op Guardrails -- Environment Isolation + Irreversibility (#708)",
    "### Environment Isolation Gate",
    "### Irreversibility Gate",
)


@pytest.mark.parametrize("heading", NEW_SECTION_HEADINGS)
def test_security_md_new_section_heading_present(heading: str) -> None:
    """Each Wave 2 section heading MUST appear verbatim in `coding/security.md`."""
    text = _read(SECURITY_MD)
    assert heading in text, (
        f"coding/security.md: missing required section heading {heading!r} "
        f"-- introduced by Wave 2 cohort #587 / #686 / #708"
    )


# ---------------------------------------------------------------------------
# No-read-secret rule (#587)
# ---------------------------------------------------------------------------


def test_no_read_secret_rule_section_present() -> None:
    """#587: the no-read-secret rule MUST carry MUST + MUST NOT bullets and
    name the credential-proxy + per-identity scoping mitigations."""
    text = _read(SECURITY_MD)
    section_start = _locate_section(
        text, "## No-Read-Secret Rule for Agent Systems (#587)"
    )
    section = text[section_start:section_start + 2500]

    # Load-bearing rule tokens.
    for token in (
        "secret manager",
        "credential proxy",
        "Scope each credential",
        "per-identity",
    ):
        assert token in section, (
            f"#587 section: missing load-bearing token {token!r}"
        )

    # Must include at least one MUST and one MUST NOT bullet.
    assert "- ! " in section, "#587 section: missing any `- ! ` MUST bullet"
    assert "- \u2297 " in section, (
        "#587 section: missing any `- \u2297 ` MUST NOT bullet"
    )

    # Cross-reference to the existing coding.md Secrets rule.
    assert "coding.md" in section, (
        "#587 section: missing cross-reference to existing coding.md Secrets rule"
    )


# ---------------------------------------------------------------------------
# Tool-call safety rule (#686)
# ---------------------------------------------------------------------------


def test_tool_call_safety_rule_section_present() -> None:
    """#686: tool-call safety section MUST name the constraint-tier
    declaration requirement and the call-site enforcement contract."""
    text = _read(SECURITY_MD)
    section_start = _locate_section(
        text, "## Tool-Call Safety Is Independent of Text-Level Safety (#686)"
    )
    section = text[section_start:section_start + 2500]

    for token in (
        "constraint tier",
        "read-only",
        "reversible",
        "irreversible",
        "destructive",
        "Audit-log",
        "preflight",
    ):
        assert token in section, (
            f"#686 section: missing load-bearing token {token!r}"
        )

    assert "- ! " in section, "#686 section: missing any `- ! ` MUST bullet"
    assert "- \u2297 " in section, (
        "#686 section: missing any `- \u2297 ` MUST NOT bullet"
    )

    # Source attribution -- empirical claim cites the ABC paper. Match
    # against either the author surname or the full arxiv URL form so the
    # check is unambiguous (CodeQL py/incomplete-url-substring-sanitization
    # flags the bare-domain substring form as a potential URL-validation
    # foot-gun; using the full https://arxiv.org/abs/ prefix avoids that
    # heuristic while strengthening the assertion).
    assert "Cartagena" in section or "https://arxiv.org/abs/" in section, (
        "#686 section: missing source attribution for the empirical claim"
    )


# ---------------------------------------------------------------------------
# Destructive-op guardrails (#708)
# ---------------------------------------------------------------------------


def test_destructive_op_guardrails_section_present() -> None:
    """#708: destructive-op guardrails MUST carry both the env-isolation
    gate AND the irreversibility gate, including the backup-is-first-class
    rule (the load-bearing detail the PocketOS incident missed)."""
    text = _read(SECURITY_MD)
    section_start = _locate_section(
        text, "## Destructive-Op Guardrails -- Environment Isolation + Irreversibility (#708)"
    )
    # Look at a generous window: this section has two subheadings.
    section = text[section_start:section_start + 4000]

    # Environment isolation gate tokens. The trusted-signal token is
    # asserted case-insensitively because the rule body emphasises it
    # with uppercase ("TRUSTED, NON-PROMPT signal").
    section_lower = section.lower()
    for token in (
        "### Environment Isolation Gate",
        "connection-string",
        "refuse the operation",
    ):
        assert token in section, (
            f"#708 env-isolation gate: missing load-bearing token {token!r}"
        )
    assert "trusted, non-prompt signal" in section_lower, (
        "#708 env-isolation gate: missing load-bearing token "
        "'trusted, non-prompt signal' (case-insensitive)"
    )

    # Irreversibility gate tokens.
    for token in (
        "### Irreversibility Gate",
        "DROP",
        "TRUNCATE",
        "rollback path",
        "ack token",
        "Backups are first-class state",
    ):
        assert token in section, (
            f"#708 irreversibility gate: missing load-bearing token {token!r}"
        )

    assert "- ! " in section, "#708 section: missing any `- ! ` MUST bullet"
    assert "- \u2297 " in section, (
        "#708 section: missing any `- \u2297 ` MUST NOT bullet"
    )

    # Incident cross-reference.
    assert "PocketOS" in section, (
        "#708 section: missing PocketOS incident reference"
    )
    assert "incidents/2026-04-pocketos-railway-prod-db-wipe.md" in section, (
        "#708 section: missing path-link to the seed incident entry"
    )


# ---------------------------------------------------------------------------
# Incidents library
# ---------------------------------------------------------------------------


def test_incidents_library_files_exist() -> None:
    """The incidents library MUST have a README, a template, and the seed entry."""
    assert INCIDENTS_README.is_file(), (
        f"{INCIDENTS_README}: missing -- #708 vBRIEF mandates incidents/README.md"
    )
    assert INCIDENTS_TEMPLATE.is_file(), (
        f"{INCIDENTS_TEMPLATE}: missing -- #708 vBRIEF mandates incidents/_template.md"
    )
    assert INCIDENTS_SEED.is_file(), (
        f"{INCIDENTS_SEED}: missing -- #708 vBRIEF mandates the seed entry "
        f"`incidents/2026-04-pocketos-railway-prod-db-wipe.md`"
    )


def test_incidents_readme_documents_entry_format() -> None:
    """`incidents/README.md` MUST document the entry-format contract from the
    #708 vBRIEF: summary, date, root cause, intervening rule, eval link."""
    text = _read(INCIDENTS_README)
    for token in (
        "Entry format",
        "Root cause",
        "Which Deft rule(s) would have intervened",
        "Eval / regression coverage",
    ):
        assert token in text, (
            f"incidents/README.md: missing required section / token {token!r}"
        )


def test_incidents_library_seed_entry_present() -> None:
    """The seed PocketOS entry MUST cross-reference the rule body for #708
    AND #686 AND #587, so the entry encodes the full intervention surface
    rather than just the most direct rule."""
    text = _read(INCIDENTS_SEED)
    for token in (
        "PocketOS",
        "Railway",
        "Environment Isolation Gate",
        "Irreversibility Gate",
        "#708",
        "#686",
        "#587",
        "content/coding/security.md",
    ):
        assert token in text, (
            f"incidents/2026-04-pocketos-railway-prod-db-wipe.md: missing "
            f"cross-reference / token {token!r}"
        )
