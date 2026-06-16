#!/usr/bin/env python3
"""pack_migrate_strategies.py -- one-shot migration: strategies/*.md -> pack.

Builds the canonical structured source ``packs/strategies/strategies-pack-0.1.json``
(the source of truth per ADR-001) by scanning every ``strategies/*.md``. This is
the #1296 generalization of the #1294 lessons pilot + #1295 skills pack: the same
render/slice machinery, a fourth domain.

What is captured per strategy
-----------------------------
- ``id``          the slugified doc stem (e.g. yolo, bdd, v0-20-contract).
- ``title``       the leading ``# `` heading text, verbatim.
- ``description`` the leading description paragraph after the title, folded to a
  single normalised string (Legend / See-also / HTML-comment / rule chrome
  skipped). Empty when the doc has no leading paragraph.
- ``triggers``    invocation keywords for the strategy. Strategy docs carry no
  frontmatter and there is no strategy-routing table, so the derivable trigger
  is the doc stem itself; the list is otherwise empty (per the #1296 scope:
  "if no trigger metadata exists, use an empty list and rely on list").
- ``path``        the repo-relative ``strategies/<name>.md``.
- ``body``        the full strategy body (banner-stripped). Captured for EVERY
  non-redirect strategy by default (packs:slice v2, #1637) so every
  ``strategies/*.md`` is a drift-checked projection; the back-compat
  ``--proof-strategy`` flag still restricts capture to one strategy.

Pure redirect / deprecation stubs (e.g. ``strategies/brownfield.md`` -> map,
the superseded ``strategies/roadmap.md``) keep a metadata-only entry with
``body`` null and are NOT rendered as projections.

Usage::

    uv run python scripts/pack_migrate_strategies.py \\
        [--strategies-dir strategies] [--proof-strategy strategies/yolo.md] \\
        [--out packs/strategies/strategies-pack-0.1.json]

Exit codes:
    0 -- migrated successfully
    1 -- strategies dir missing, or no strategies discovered
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

DEFAULT_STRATEGIES_DIR = REPO_ROOT / "strategies"
DEFAULT_OUT = REPO_ROOT / "packs" / "strategies" / "strategies-pack-0.1.json"

PACK_ID = "strategies-pack-0.1"
PACK_VERSION = "0.1"

_H1_RE = re.compile(r"^#\s+(.+?)\s*$")
_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")

# Lines that open the description-paragraph scan but are document chrome, not a
# description: the RFC2119 legend, "See also" pointers, HTML comments, and
# horizontal rules.
_CHROME_PREFIXES = ("legend ", "legend(", "**legend", "**⚠️", "**see also", "<!--")

# Deprecation / redirect marker phrases that flag a pure pointer stub. A doc
# whose leading content (after the title) is a blockquote carrying one of these
# markers (e.g. strategies/brownfield.md "legacy alias", strategies/roadmap.md
# "superseded") is NOT given a captured body and is NOT rendered as a
# projection -- only non-redirect strategies become drift-checked projections.
_REDIRECT_MARKERS = (
    "legacy alias",
    "superseded",
    "has been renamed",
    "has moved",
    "deprecated",
)


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


def is_redirect_stub(md_text: str) -> bool:
    """Return True when a strategy doc is a pure redirect/deprecation pointer.

    A stub opens (after its ``# `` title, past blank/chrome lines) with a
    blockquote admonition that carries a deprecation marker (``legacy alias``,
    ``superseded``, ``has been renamed``, ...). The strategies dir carries no
    YAML frontmatter, so unlike the skills pack (which keys off missing
    frontmatter) the structural redirect signal is this leading-blockquote +
    marker pair. Such files (e.g. brownfield -> map, the superseded roadmap
    strategy) keep a metadata-only pack entry (``body`` null) and are NOT
    rendered as projections.
    """
    lines = md_text.splitlines()
    i = 0
    n = len(lines)
    while i < n and not _H1_RE.match(lines[i]):
        i += 1
    if i < n:
        i += 1  # skip the title line itself
    while i < n and (lines[i].strip() == "" or _is_chrome(lines[i])):
        i += 1
    # The leading content after the title must be a blockquote pointer.
    if i >= n or not lines[i].lstrip().startswith(">"):
        return False
    block: list[str] = []
    while i < n and lines[i].lstrip().startswith(">"):
        block.append(lines[i].lstrip().lstrip(">").strip())
        i += 1
    quote = " ".join(block).lower()
    return any(marker in quote for marker in _REDIRECT_MARKERS)


def strip_leading_banner(body: str) -> str:
    """Strip a leading provenance banner + blank lines from a captured body.

    Makes re-migration idempotent: after the proof strategy is regenerated
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


def build_strategy_entry(
    md: Path, strategies_dir: Path, *, capture_body: bool
) -> dict:
    """Build one strategy entry from its markdown file."""
    rel_path = md.resolve().relative_to(strategies_dir.resolve().parent).as_posix()
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


def build_pack(strategies_dir: Path, *, proof_strategy: str | None) -> dict:
    """Scan the strategies dir and assemble the full pack object.

    ``proof_strategy`` is the back-compat single-strategy restrictor: when
    ``None`` (the default, packs:slice v2 / #1637) the body is captured for
    EVERY non-redirect strategy; when set, only that one strategy's body is
    captured (the #1296 proof shape). Pure redirect/deprecation stubs never
    carry a captured body regardless.
    """
    capture_all = proof_strategy is None
    strategies: list[dict] = []
    for md in sorted(strategies_dir.glob("*.md")):
        rel_path = md.resolve().relative_to(strategies_dir.resolve().parent).as_posix()
        if capture_all:
            capture_body = not is_redirect_stub(md.read_text(encoding="utf-8"))
        else:
            capture_body = rel_path == proof_strategy
        strategies.append(
            build_strategy_entry(md, strategies_dir, capture_body=capture_body)
        )

    return {
        "pack": PACK_ID,
        "version": PACK_VERSION,
        "generated_from": "strategies/*.md",
        "strategies": strategies,
    }


def migrate(strategies_dir: Path, out: Path, *, proof_strategy: str | None) -> dict:
    """Build the pack from ``strategies_dir`` and write it to ``out``.

    Raises ``FileNotFoundError`` when the dir is missing and ``ValueError`` when
    no strategies are discovered.
    """
    if not strategies_dir.is_dir():
        raise FileNotFoundError(f"strategies directory not found: {strategies_dir}")

    pack = build_pack(strategies_dir, proof_strategy=proof_strategy)
    if not pack["strategies"]:
        raise ValueError(f"no strategies discovered under {strategies_dir}")

    out.parent.mkdir(parents=True, exist_ok=True)
    # ensure_ascii=True: the canonical source is serialized as pure ASCII with
    # \uXXXX escapes (mirrors the other pack migrations). Lossless and keeps the
    # JSON clean against `task verify:encoding` (#798) even when a strategy body
    # carries non-ASCII glyphs (em dashes, RFC2119 symbols, emoji in diagrams).
    out.write_text(
        json.dumps(pack, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    return pack


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pack_migrate_strategies.py",
        description="Migrate strategies/*.md into the strategies-pack-0.1 source.",
    )
    parser.add_argument(
        "--strategies-dir",
        type=Path,
        default=DEFAULT_STRATEGIES_DIR,
        help="Directory of strategy docs to scan (default: strategies/).",
    )
    parser.add_argument(
        "--proof-strategy",
        default=None,
        help="Back-compat: restrict body capture to ONE strategy's repo-relative "
        "path (e.g. strategies/yolo.md). Default: capture every non-redirect "
        "strategy's body (#1637).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="Output pack JSON path (default: packs/strategies/strategies-pack-0.1.json).",
    )
    args = parser.parse_args(argv)

    try:
        pack = migrate(
            args.strategies_dir, args.out, proof_strategy=args.proof_strategy
        )
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    bodied = sum(1 for s in pack["strategies"] if s["body"] is not None)
    print(
        f"Migrated {len(pack['strategies'])} strategies ({bodied} with body) "
        f"-> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
