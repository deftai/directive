#!/usr/bin/env python3
"""rule_ownership_lint.py -- Rule Ownership Map (ROM) drift detector.

Reads ``conventions/rule-ownership.json`` and verifies, for every row, that
the ``owner_file`` still exists, that the ``owner_section`` heading is still
present in the file, and that the rule ``text`` substring still appears
somewhere inside that section's body. When any of these invariants drift,
the lint exits non-zero with an actionable diagnostic so ``task check`` can
fail CI before the drift lands on master.

Background
----------
PR #401 originally documented framework rule ownership as a descriptive
``Rule Ownership Map`` table inside ``REFERENCES.md``. Per the canonical
#642 workflow comment locked decision, that prose decays under agent
pressure (rules move; the table stays stale; readers cannot trust it).
The replacement is this structural data file plus this lint, wired into
``task check`` via ``tasks/verify.yml``. See
``vbrief/proposed/2026-04-27-635-rule-ownership-map-data-file-and-lint.vbrief.json``
and the ``## Rule Authority [AXIOM]`` block in ``main.md``: deterministic
encodings (this lint) rank above prose, so every ROM row gets pre-merge
enforcement instead of post-hoc readability.

Usage
-----
    uv run python scripts/rule_ownership_lint.py
    uv run python scripts/rule_ownership_lint.py --map conventions/rule-ownership.json
    uv run python scripts/rule_ownership_lint.py --root /path/to/repo

Exit codes
----------
    0 -- all rows verified clean (no drift)
    1 -- at least one row drifted (rule moved, section renamed, text changed)
    2 -- config error (data file missing, malformed JSON, schema violation)

Refs #635 (epic), #642 (workflow umbrella), #634 (determinism-tier ladder T5/T6).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# Make sibling helpers importable both when run as __main__ and when imported by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

# ---- Exit codes -------------------------------------------------------------

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_CONFIG_ERROR = 2

# ---- Constants --------------------------------------------------------------

DEFAULT_MAP_PATH = Path("conventions/rule-ownership.json")

VALID_AUTHORITIES = {
    "MUST",
    "SHOULD",
    "MUST_NOT",
    "SHOULD_NOT",
    "AXIOM",
    "lesson",
}

REQUIRED_FIELDS = ("id", "text", "owner_file", "owner_section", "authority", "last_verified")

# Markdown ATX heading: 1-6 leading hashes, mandatory space, then heading text.
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


# ---- Data loading -----------------------------------------------------------


def _load_map(map_path: Path) -> dict[str, Any]:
    """Load and minimally validate the ROM data file.

    Raises ``ValueError`` on any malformed input so the caller can map to
    ``EXIT_CONFIG_ERROR``.
    """
    if not map_path.is_file():
        raise ValueError(f"ROM data file not found: {map_path}")
    try:
        raw = map_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"Failed to read ROM data file {map_path}: {exc}") from exc
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Malformed JSON in ROM data file {map_path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(
            f"ROM data file {map_path} must contain a JSON object at the top level "
            f"(got {type(payload).__name__})."
        )
    rules = payload.get("rules")
    if not isinstance(rules, list):
        raise ValueError(
            f"ROM data file {map_path} must contain a 'rules' array "
            f"(got {type(rules).__name__})."
        )
    seen_ids: set[str] = set()
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise ValueError(
                f"ROM rule at index {index} must be a JSON object "
                f"(got {type(rule).__name__})."
            )
        for field in REQUIRED_FIELDS:
            if field not in rule:
                raise ValueError(
                    f"ROM rule at index {index} is missing required field '{field}'."
                )
            if not isinstance(rule[field], str) or not rule[field]:
                raise ValueError(
                    f"ROM rule at index {index} field '{field}' must be a non-empty string."
                )
        rule_id = rule["id"]
        if rule_id in seen_ids:
            raise ValueError(f"Duplicate ROM rule id: {rule_id!r}")
        seen_ids.add(rule_id)
        authority = rule["authority"]
        if authority not in VALID_AUTHORITIES:
            raise ValueError(
                f"ROM rule {rule_id!r} has invalid authority {authority!r}; "
                f"expected one of {sorted(VALID_AUTHORITIES)}."
            )
    return payload


# ---- Section extraction -----------------------------------------------------


def _parse_heading(line: str) -> tuple[int, str] | None:
    """Return ``(level, text)`` for a markdown ATX heading line, or ``None``.

    Only ATX-style headings (``# foo``) are recognised; setext (underline)
    headings are intentionally ignored because the ROM data file mirrors
    the canonical owner_section value verbatim including the ``#`` prefix.
    """
    match = _HEADING_RE.match(line)
    if not match:
        return None
    return len(match.group(1)), match.group(2).strip()


def _parse_owner_section(spec: str) -> tuple[int, str] | None:
    """Parse the ROM ``owner_section`` field (e.g. ``"## Code Design"``)."""
    return _parse_heading(spec.strip())


def extract_section_body(content: str, owner_section: str) -> str | None:
    """Return the body text of ``owner_section`` inside ``content``.

    The section body starts on the line after the matching heading and ends
    at the next heading whose level is less than or equal to the matched
    heading's level (or end-of-file). Returns ``None`` when the section is
    not found, allowing the caller to distinguish "section missing" from
    "section present, text missing".
    """
    parsed = _parse_owner_section(owner_section)
    if parsed is None:
        return None
    target_level, target_text = parsed
    lines = content.splitlines()
    in_section = False
    body: list[str] = []
    for line in lines:
        heading = _parse_heading(line)
        if not in_section:
            if heading and heading[0] == target_level and heading[1] == target_text:
                in_section = True
            continue
        if heading and heading[0] <= target_level:
            break
        body.append(line)
    if not in_section:
        return None
    return "\n".join(body)


# ---- Lint core --------------------------------------------------------------


def lint_rules(payload: dict[str, Any], root: Path) -> list[str]:
    """Return a list of human-readable drift diagnostics; empty list = clean."""
    diagnostics: list[str] = []
    rules: list[dict[str, Any]] = payload["rules"]  # validated by _load_map
    for rule in rules:
        rule_id = rule["id"]
        owner_file = rule["owner_file"]
        owner_section = rule["owner_section"]
        text = rule["text"]
        target = root / owner_file
        if not target.is_file():
            diagnostics.append(
                f"[{rule_id}] owner_file not found: {owner_file} -- "
                f"either restore the file or update the ROM row to point at the new owner."
            )
            continue
        try:
            content = target.read_text(encoding="utf-8")
        except OSError as exc:
            diagnostics.append(
                f"[{rule_id}] failed to read {owner_file}: {exc}"
            )
            continue
        body = extract_section_body(content, owner_section)
        if body is None:
            diagnostics.append(
                f"[{rule_id}] owner_section {owner_section!r} not found in {owner_file} -- "
                f"either restore the heading or update the ROM row to point at the new section."
            )
            continue
        if text not in body:
            diagnostics.append(
                f"[{rule_id}] rule text not found in {owner_file} {owner_section!r} -- "
                f"the rule has been moved, deleted, or rewritten. "
                f"Update the ROM row's 'text' (or 'owner_file' / 'owner_section') to match. "
                f"Looked for: {text!r}"
            )
    return diagnostics


# ---- argument parsing -------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rule_ownership_lint",
        description=(
            "Rule Ownership Map (ROM) drift detector. Verifies that every row "
            "in conventions/rule-ownership.json still resolves to a live "
            "(owner_file, owner_section, text) triple. Wired into task check "
            "via tasks/verify.yml so drift fails CI before merge. See "
            "vbrief/proposed/2026-04-27-635-rule-ownership-map-data-file-and-lint."
            "vbrief.json. Refs #635, #642, #634."
        ),
    )
    parser.add_argument(
        "--map",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Path to the ROM data file (default: <root>/conventions/rule-ownership.json)."
        ),
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Repository root used to resolve owner_file paths. Defaults to "
            "the parent of the scripts/ directory."
        ),
    )
    return parser


def _resolve_root(arg_root: Path | None) -> Path:
    if arg_root is not None:
        return arg_root.resolve()
    # scripts/rule_ownership_lint.py -> repo root is the parent of scripts/.
    return Path(__file__).resolve().parent.parent


# ---- main -------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    root = _resolve_root(args.root)
    map_path = args.map if args.map is not None else (root / DEFAULT_MAP_PATH)

    try:
        payload = _load_map(map_path)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    diagnostics = lint_rules(payload, root)
    if diagnostics:
        print(
            f"FAIL: rule ownership map drift detected in "
            f"{len(diagnostics)} row(s):",
            file=sys.stderr,
        )
        for diag in diagnostics:
            print(f"  - {diag}", file=sys.stderr)
        return EXIT_DRIFT

    rule_count = len(payload["rules"])
    print(
        f"OK: rule ownership map clean -- {rule_count} row(s) verified against "
        f"their owner files (root={root}).",
        file=sys.stderr,
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
