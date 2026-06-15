#!/usr/bin/env python3
"""pack_migrate_rules.py -- one-shot migration: coding/*.md -> structured pack.

Builds the canonical structured source ``packs/rules/rules-pack-0.1.json`` (the
source of truth per ADR-001) by parsing the marker-prefixed RFC2119 directive
lines out of every ``coding/*.md``. This is the #1296 generalization of the
#1294 lessons pilot + #1295 skills pack: the same render/slice machinery, a
third domain.

What is captured per rule
-------------------------
- ``id``     a stable, deterministic ``{domain}-{NNN}`` slug (in-document order).
- ``tier``   the RFC2119 strength normalized from the coding/* legend marker
  (per #748): ``!`` -> MUST, ``~`` -> SHOULD, the SHOULD-NOT glyph ->
  SHOULD_NOT, the MUST-NOT glyph -> MUST_NOT, ``?`` -> MAY. Prose RFC2119
  bullets (uppercase MUST / SHOULD / ... in a plain ``- `` bullet) are also
  recognized.
- ``domain`` the source doc stem (testing, security, hygiene, ...).
- ``text``   the directive text after the strength marker, verbatim.
- ``path``   the repo-relative ``coding/<doc>.md``.
- ``body``   the full source-document body (banner-stripped) for the ONE
  designated proof doc's first rule entry (``coding/testing.md``); ``null`` for
  every other entry (metadata-only, per the "migrate ONE doc as proof" scope).

Usage::

    uv run python scripts/pack_migrate_rules.py \\
        [--coding-dir coding] [--proof-doc coding/testing.md] \\
        [--out packs/rules/rules-pack-0.1.json]

Exit codes:
    0 -- migrated successfully
    1 -- coding dir missing, or no directives discovered
    2 -- usage error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Repo root resolved from this file's location (scripts/ -> repo root) so the
# default paths are CWD-independent.
REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_CODING_DIR = REPO_ROOT / "coding"
DEFAULT_OUT = REPO_ROOT / "packs" / "rules" / "rules-pack-0.1.json"

PACK_ID = "rules-pack-0.1"
PACK_VERSION = "0.1"

# The single proof DOC whose full body is captured + regenerated as a
# banner-marked, drift-checked projection. Small, well-structured, the legend
# anchor for the whole coding/* RFC2119 dialect.
DEFAULT_PROOF_DOC = "coding/testing.md"

# Strength-marker glyphs -> normalized tier. Mirrors the coding/* legend
# documented at the top of coding/testing.md (and #748's strength axis):
#   ! = MUST, ~ = SHOULD, the SHOULD-NOT glyph, the MUST-NOT glyph, ? = MAY.
_SHOULD_NOT_GLYPH = "\u2249"  # the coding/* SHOULD NOT legend glyph
_MUST_NOT_GLYPH = "\u2297"  # the coding/* MUST NOT legend glyph
GLYPH_TIER: dict[str, str] = {
    "!": "MUST",
    "~": "SHOULD",
    _SHOULD_NOT_GLYPH: "SHOULD_NOT",
    _MUST_NOT_GLYPH: "MUST_NOT",
    "?": "MAY",
}

# A marker-prefixed directive bullet: optional leading ``- `` then a single
# strength glyph then the directive text.
_MARKER_RE = re.compile(
    rf"^\s*(?:-\s+)?([!~?{_SHOULD_NOT_GLYPH}{_MUST_NOT_GLYPH}])\s+(\S.*)$"
)

# Prose RFC2119 bullets: a plain ``- `` bullet that spells out the keyword in
# uppercase (no glyph). Longer keywords are matched first so "MUST NOT" wins
# over "MUST". The keyword must appear as a standalone token in the bullet.
_PROSE_TIERS: tuple[tuple[str, str], ...] = (
    ("MUST NOT", "MUST_NOT"),
    ("SHOULD NOT", "SHOULD_NOT"),
    ("MUST", "MUST"),
    ("SHOULD", "SHOULD"),
    ("MAY", "MAY"),
)
_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")


def _prose_tier(text: str) -> str | None:
    """Return the tier for a plain bullet that spells an uppercase RFC2119 word.

    Matches the longest keyword first ("MUST NOT" before "MUST") and requires a
    word boundary so substrings inside other words are not mistaken for rules.
    """
    for keyword, tier in _PROSE_TIERS:
        if re.search(rf"\b{keyword.replace(' ', r'[ ]')}\b", text):
            return tier
    return None


def parse_rules(md_text: str, domain: str) -> list[dict]:
    """Parse a coding doc's marker-prefixed + prose RFC2119 directives.

    Returns one record per directive in document order with ``id`` /
    ``tier`` / ``domain`` / ``text`` / ``path`` (``body`` is attached by the
    caller). ``path`` is left for the caller to set.
    """
    rules: list[dict] = []
    seq = 0
    for raw in md_text.splitlines():
        line = raw.rstrip()
        marker = _MARKER_RE.match(line)
        if marker:
            tier = GLYPH_TIER[marker.group(1)]
            text = marker.group(2).strip()
        else:
            stripped = line.strip()
            if not stripped.startswith("- "):
                continue
            text = stripped[2:].strip()
            tier = _prose_tier(text) if text else None
            if tier is None:
                continue
        if not text:
            continue
        seq += 1
        rules.append(
            {
                "id": f"{domain}-{seq:03d}",
                "tier": tier,
                "domain": domain,
                "text": text,
            }
        )
    return rules


def strip_leading_banner(body: str) -> str:
    """Strip a leading provenance banner + blank lines from a captured body.

    Makes re-migration idempotent: after the proof doc is regenerated
    (banner + body), re-running the migration recovers the same body. Only
    strips a banner block that opens with the renderer's first banner line, so
    unrelated leading HTML comments survive.
    """
    lines = body.split("\n")
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    if i < len(lines) and lines[i].startswith(
        "<!-- AUTO-GENERATED by task packs:render"
    ):
        while i < len(lines) and lines[i].lstrip().startswith("<!--"):
            i += 1
        while i < len(lines) and lines[i].strip() == "":
            i += 1
    return "\n".join(lines[i:])


def build_pack(coding_dir: Path, *, proof_doc: str) -> dict:
    """Scan the coding dir and assemble the full pack object."""
    rules: list[dict] = []
    for md in sorted(coding_dir.glob("*.md")):
        rel_path = md.resolve().relative_to(coding_dir.resolve().parent).as_posix()
        domain = _SLUG_STRIP_RE.sub("-", md.stem.lower()).strip("-")
        text = md.read_text(encoding="utf-8")
        doc_rules = parse_rules(text, domain)
        capture_body = rel_path == proof_doc
        for idx, rule in enumerate(doc_rules):
            rule["path"] = rel_path
            # Attach the full doc body to the proof doc's FIRST rule only; every
            # other entry is metadata-only (body null). The renderer's documents
            # mode then projects that single bodied entry -> coding/testing.md.
            if capture_body and idx == 0:
                rule["body"] = strip_leading_banner(text)
            else:
                rule["body"] = None
            rules.append(rule)

    return {
        "pack": PACK_ID,
        "version": PACK_VERSION,
        "generated_from": "coding/*.md (marker-prefixed RFC2119 directives)",
        "rules": rules,
    }


def migrate(coding_dir: Path, out: Path, *, proof_doc: str) -> dict:
    """Build the pack from ``coding_dir`` and write it to ``out``.

    Raises ``FileNotFoundError`` when the coding dir is missing and
    ``ValueError`` when no directives are discovered.
    """
    if not coding_dir.is_dir():
        raise FileNotFoundError(f"coding directory not found: {coding_dir}")

    pack = build_pack(coding_dir, proof_doc=proof_doc)
    if not pack["rules"]:
        raise ValueError(f"no directives discovered under {coding_dir}")

    out.parent.mkdir(parents=True, exist_ok=True)
    # ensure_ascii=True: the canonical source is serialized as pure ASCII with
    # \uXXXX escapes (mirrors pack_migrate_lessons / pack_migrate_skills).
    # Lossless and keeps the JSON clean against `task verify:encoding` (#798)
    # even though the directive text carries non-ASCII glyphs (RFC2119 symbols,
    # em dashes, the >= sign).
    out.write_text(
        json.dumps(pack, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    return pack


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pack_migrate_rules.py",
        description="Migrate coding/*.md RFC2119 directives into the rules-pack-0.1 source.",
    )
    parser.add_argument(
        "--coding-dir",
        type=Path,
        default=DEFAULT_CODING_DIR,
        help="Directory of coding docs to scan (default: coding/).",
    )
    parser.add_argument(
        "--proof-doc",
        default=DEFAULT_PROOF_DOC,
        help="Repo-relative path of the one doc whose full body is captured.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="Output pack JSON path (default: packs/rules/rules-pack-0.1.json).",
    )
    args = parser.parse_args(argv)

    try:
        pack = migrate(args.coding_dir, args.out, proof_doc=args.proof_doc)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    bodied = sum(1 for r in pack["rules"] if r["body"] is not None)
    print(f"Migrated {len(pack['rules'])} rules ({bodied} with body) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
