"""
test_mermaid_guidance.py - Guardrails for Mermaid authoring guidance in languages/mermaid.md.

Tracks issue #102.
"""

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_MERMAID_MD = _REPO_ROOT / "languages" / "mermaid.md"


def _read_mermaid_rules() -> str:
    return _MERMAID_MD.read_text(encoding="utf-8")


def test_github_gist_sequence_rules_present() -> None:
    """Mermaid standards must codify GitHub/Gist sequence readability rules."""
    text = _read_mermaid_rules()

    required_phrases = [
        (
            "For `sequenceDiagram` readability on GitHub/Gist renderers, "
            "do not rely on `init.background` or `themeCSS` alone"
        ),
        (
            "For `sequenceDiagram` readability on GitHub/Gist renderers, place "
            "participant declarations inside a grey `box ... end` block"
        ),
        (
            "When using `box` in `sequenceDiagram`, place only participant "
            "declarations inside the block; message lines and notes must remain outside"
        ),
        (
            "Treat renderer quirks as diagram-type-specific; `sequenceDiagram` "
            "workarounds SHOULD NOT be generalized to other Mermaid diagram "
            "types without testing"
        ),
    ]

    for phrase in required_phrases:
        assert phrase in text, f"languages/mermaid.md missing required guidance: {phrase}"


def test_github_gist_safe_example_uses_participants_only_inside_box() -> None:
    """
    The gist-safe sequence example must keep message flow outside the participant box.
    """
    text = _read_mermaid_rules()

    pattern = re.compile(
        r"sequenceDiagram\s+"
        r"box rgb\(192, 192, 192\) Participants\s+"
        r"participant A as Alice\s+"
        r"participant B as Bob\s+"
        r"end\s+"
        r"A->>B: Hello\s+"
        r"B->>A: Hi back\s+"
        r"Note over A,B: Example",
        re.MULTILINE,
    )

    assert pattern.search(text), (
        "languages/mermaid.md must include a GitHub/Gist-safe sequence example with "
        "participants in `box ... end` and messages/notes outside the box"
    )
