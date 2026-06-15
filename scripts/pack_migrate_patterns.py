#!/usr/bin/env python3
"""pack_migrate_patterns.py -- one-shot migration: patterns/*.md -> pack.

Builds the canonical structured source ``packs/patterns/patterns-pack-0.1.json``
(the source of truth per ADR-001) by scanning every ``patterns/*.md``. This is
the #1637 generalization of the #1294 lessons pilot + #1295 skills pack + #1296
rules/strategies packs: the same render/slice machinery, a fifth domain. The
``patterns/`` directory existed with no pack until #1637 (packs:slice v2).

What is captured per pattern
----------------------------
- ``id``          the slugified doc stem (e.g. multi-agent, role-as-overlay).
- ``title``       the leading ``# `` heading text, verbatim.
- ``description`` the leading description paragraph after the title, folded to a
  single normalised string (Legend / See-also / HTML-comment / rule chrome
  skipped). Empty when the doc has no leading paragraph.
- ``triggers``    invocation keywords for the pattern. Pattern docs carry no
  frontmatter and there is no pattern-routing table, so the derivable trigger
  is the doc stem itself; the list is otherwise empty (mirrors #1296 strategies
  scope: "if no trigger metadata exists, use an empty list and rely on list").
- ``path``        the repo-relative ``patterns/<name>.md``.
- ``body``        the full pattern body (banner-stripped) for the ONE designated
  proof pattern (``patterns/multi-agent.md``); ``null`` for every other pattern
  (metadata-only, per the "migrate ONE doc as proof" 0.1-pilot scope).

Usage::

    uv run python scripts/pack_migrate_patterns.py \\
        [--patterns-dir patterns] [--proof-pattern patterns/multi-agent.md] \\
        [--out packs/patterns/patterns-pack-0.1.json]

Exit codes:
    0 -- migrated successfully
    1 -- patterns dir missing, or no patterns discovered
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

DEFAULT_PATTERNS_DIR = REPO_ROOT / "patterns"
DEFAULT_OUT = REPO_ROOT / "packs" / "patterns" / "patterns-pack-0.1.json"

PACK_ID = "patterns-pack-0.1"
PACK_VERSION = "0.1"

# The single proof PATTERN whose full body is captured + regenerated as a
# banner-marked, drift-checked projection.
DEFAULT_PROOF_PATTERN = "patterns/multi-agent.md"

_H1_RE = re.compile(r"^#\s+(.+?)\s*$")
_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")

# Lines that open the description-paragraph scan but are document chrome, not a
# description: the RFC2119 legend, "See also" pointers, HTML comments, and
# horizontal rules.
_CHROME_PREFIXES = ("legend ", "legend(", "**legend", "**⚠️", "**see also", "<!--")


def _is_chrome(line: str) -> bool:
    """True when a line is document chrome rather than a description paragraph."""
    low = line.lstrip().lower()
    if low.startswith(_CHROME_PREFIXES):
        return True
    stripped = line.strip()
    # A horizontal rule (e.g. `---`, `===`) is chrome, not a description.
    return bool(stripped) and set(stripped) <= {"-", "="}


def extract_title(md_text: str) -> str:
    """Return the leading ``# `` heading text, or '' when absent."""
    for line in md_text.splitlines():
        match = _H1_RE.match(line)
        if match:
            return match.group(1).strip()
    return ""


def extract_description(md_text: str) -> str:
    """Return the leading description paragraph after the ``# `` title.

    Scans past the title, skips blank lines and chrome lines (Legend, See-also,
    HTML comments, horizontal rules), then collects the first contiguous block
    of non-blank, non-chrome lines and folds it to a single normalised string.
    A leading blockquote marker (``> ``) is stripped so redirect/superseded
    notes still yield a readable description.
    """
    lines = md_text.splitlines()
    i = 0
    n = len(lines)
    # Advance to just past the first H1.
    while i < n and not _H1_RE.match(lines[i]):
        i += 1
    if i < n:
        i += 1  # skip the title line itself
    # Skip leading blanks / chrome before the description.
    while i < n and (lines[i].strip() == "" or _is_chrome(lines[i])):
        i += 1
    # Collect the first contiguous non-blank block. A markdown heading is a
    # section boundary, not a description -- a doc whose first content after the
    # title is a `## ` heading has no leading description paragraph.
    block: list[str] = []
    while i < n and lines[i].strip() != "" and not lines[i].lstrip().startswith("#"):
        stripped = lines[i].strip()
        if stripped.startswith(">"):
            stripped = stripped.lstrip(">").strip()
        if stripped:
            block.append(stripped)
        i += 1
    return " ".join(block)


def strip_leading_banner(body: str) -> str:
    """Strip a leading provenance banner + blank lines from a captured body.

    Makes re-migration idempotent: after the proof pattern is regenerated
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


def build_pattern_entry(
    md: Path, patterns_dir: Path, *, capture_body: bool
) -> dict:
    """Build one pattern entry from its markdown file."""
    rel_path = md.resolve().relative_to(patterns_dir.resolve().parent).as_posix()
    stem_slug = _SLUG_STRIP_RE.sub("-", md.stem.lower()).strip("-")
    text = md.read_text(encoding="utf-8")
    return {
        "id": stem_slug,
        "title": extract_title(text),
        "description": extract_description(text),
        "triggers": [stem_slug] if stem_slug else [],
        "path": rel_path,
        "body": strip_leading_banner(text) if capture_body else None,
    }


def build_pack(patterns_dir: Path, *, proof_pattern: str) -> dict:
    """Scan the patterns dir and assemble the full pack object."""
    patterns: list[dict] = []
    for md in sorted(patterns_dir.glob("*.md")):
        rel_path = md.resolve().relative_to(patterns_dir.resolve().parent).as_posix()
        patterns.append(
            build_pattern_entry(
                md, patterns_dir, capture_body=(rel_path == proof_pattern)
            )
        )

    return {
        "pack": PACK_ID,
        "version": PACK_VERSION,
        "generated_from": "patterns/*.md",
        "patterns": patterns,
    }


def migrate(patterns_dir: Path, out: Path, *, proof_pattern: str) -> dict:
    """Build the pack from ``patterns_dir`` and write it to ``out``.

    Raises ``FileNotFoundError`` when the dir is missing and ``ValueError`` when
    no patterns are discovered.
    """
    if not patterns_dir.is_dir():
        raise FileNotFoundError(f"patterns directory not found: {patterns_dir}")

    pack = build_pack(patterns_dir, proof_pattern=proof_pattern)
    if not pack["patterns"]:
        raise ValueError(f"no patterns discovered under {patterns_dir}")

    out.parent.mkdir(parents=True, exist_ok=True)
    # ensure_ascii=True: the canonical source is serialized as pure ASCII with
    # \uXXXX escapes (mirrors the other pack migrations). Lossless and keeps the
    # JSON clean against `task verify:encoding` (#798) even when a pattern body
    # carries non-ASCII glyphs (em dashes, RFC2119 symbols, emoji in diagrams).
    out.write_text(
        json.dumps(pack, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    return pack


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pack_migrate_patterns.py",
        description="Migrate patterns/*.md into the patterns-pack-0.1 source.",
    )
    parser.add_argument(
        "--patterns-dir",
        type=Path,
        default=DEFAULT_PATTERNS_DIR,
        help="Directory of pattern docs to scan (default: patterns/).",
    )
    parser.add_argument(
        "--proof-pattern",
        default=DEFAULT_PROOF_PATTERN,
        help="Repo-relative path of the one pattern whose full body is captured.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="Output pack JSON path (default: packs/patterns/patterns-pack-0.1.json).",
    )
    args = parser.parse_args(argv)

    try:
        pack = migrate(
            args.patterns_dir, args.out, proof_pattern=args.proof_pattern
        )
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    bodied = sum(1 for s in pack["patterns"] if s["body"] is not None)
    print(
        f"Migrated {len(pack['patterns'])} patterns ({bodied} with body) "
        f"-> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
