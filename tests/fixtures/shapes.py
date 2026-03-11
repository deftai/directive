"""
shapes.py — Shape schemas for Deft Directive framework file categories.

Spec: SPECIFICATION.md Subphase 2.5 (Task 2.5.1)

A "shape" defines the required structural sections for a given category of
.md file. Shapes are used by test_shape.py to ensure every file in a category
has the expected scaffolding. Adding a new file without the required sections
will cause a test failure, enforcing consistent structure across the framework.

Author: Scott Adams (msadams) — 2026-03-10
"""

import re
from dataclasses import dataclass, field

__all__ = [
    "ShapeSchema",
    "LANGUAGE_SHAPE",
    "STRATEGY_SHAPE",
    "INTERFACE_SHAPE",
    "TOOL_SHAPE",
    "validate_shape",
]

_H2_RE = re.compile(r"^##\s+(.+)$", re.MULTILINE)


@dataclass(frozen=True)
class ShapeSchema:
    """Defines the required structure for a category of .md file.

    Attributes:
        name:              Human-readable category name (for error messages).
        required_sections: Every listed section heading must appear (case-insensitive
                           substring match against ## headers).
        one_of_sections:   At least one of these headings must appear.
                           Empty list means this constraint is not applied.
        min_h2_count:      Minimum number of ## sections required.
                           0 means no minimum is enforced.
    """

    name: str
    required_sections: tuple[str, ...] = field(default_factory=tuple)
    one_of_sections: tuple[str, ...] = field(default_factory=tuple)
    min_h2_count: int = 0


# ---------------------------------------------------------------------------
# Canonical schemas
# ---------------------------------------------------------------------------

LANGUAGE_SHAPE = ShapeSchema(
    name="language",
    required_sections=("Standards", "Commands", "Patterns"),
)

STRATEGY_SHAPE = ShapeSchema(
    name="strategy",
    required_sections=("When to Use", "Workflow"),
)

INTERFACE_SHAPE = ShapeSchema(
    name="interface",
    # Must contain EITHER Core Architecture OR Framework Selection
    one_of_sections=("Core Architecture", "Framework Selection"),
)

TOOL_SHAPE = ShapeSchema(
    name="tool",
    min_h2_count=1,
)


# ---------------------------------------------------------------------------
# Validator
# ---------------------------------------------------------------------------

def validate_shape(text: str, schema: ShapeSchema) -> list[str]:
    """Check text against a ShapeSchema. Returns a list of violation strings.

    An empty list means the file passes the shape check.

    Args:
        text:   Full text content of the .md file.
        schema: The ShapeSchema to validate against.

    Returns:
        List of human-readable violation messages, empty if compliant.
    """
    headers = _H2_RE.findall(text)
    headers_lower = [h.lower() for h in headers]
    violations: list[str] = []

    for section in schema.required_sections:
        if not any(section.lower() in h for h in headers_lower):
            violations.append(f"missing required section '## {section}'")

    if schema.one_of_sections and not any(
        s.lower() in h for s in schema.one_of_sections for h in headers_lower
    ):
        options = " or ".join(f"'## {s}'" for s in schema.one_of_sections)
        violations.append(f"missing at least one of: {options}")

    if schema.min_h2_count > 0 and len(headers) < schema.min_h2_count:
        violations.append(
            f"needs at least {schema.min_h2_count} '##' section(s), found {len(headers)}"
        )

    return violations
