#!/usr/bin/env python3
"""
spec_validate.py — Validate a vbrief specification JSON file.

Usage:
    uv run python scripts/spec_validate.py <spec_file>

Exit codes:
    0 — valid
    1 — invalid (file missing or bad JSON)
    2 — usage error (no argument provided)

Implementation: IMPLEMENTATION.md Phase 5.1
"""

import json
import sys
from pathlib import Path


def validate_spec(spec_path: str) -> tuple[bool, str]:
    """
    Validate the spec file at *spec_path*.

    Returns:
        (True, success_message) on success.
        (False, error_message)  on failure.
    """
    path = Path(spec_path)
    if not path.exists():
        return (
            False,
            f"✗ {spec_path} not found\n"
            "  Create it by running the interview process "
            "(see deft/templates/make-spec.md)",
        )
    try:
        with open(path, encoding="utf-8") as fh:
            json.load(fh)
    except json.JSONDecodeError as exc:
        return False, f"✗ {spec_path} is not valid JSON: {exc}"

    return True, f"✓ {path.name} is valid"


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: spec_validate.py <spec_file>", file=sys.stderr)
        return 2

    ok, message = validate_spec(sys.argv[1])
    print(message)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
