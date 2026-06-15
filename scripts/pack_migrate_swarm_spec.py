#!/usr/bin/env python3
"""pack_migrate_swarm_spec.py -- one-shot migration: swarm/*.md -> pack.

Builds the canonical structured source
``packs/swarm-spec/swarm-spec-pack-0.1.json`` (the source of truth per ADR-001)
by scanning every ``swarm/*.md``. This is the #1637 generalization of the #1294
lessons pilot + #1295 skills pack + #1296 rules/strategies packs + the patterns
pack: the same render/slice machinery, applied to the swarm specification. The
``swarm-spec`` pack was a candidate on the #1283 Q-list, landed in packs:slice
v2 (#1637).

What is captured per entry
--------------------------
- ``id``          the slugified doc stem (e.g. swarm).
- ``title``       the leading ``# `` heading text, verbatim.
- ``description`` the leading description paragraph after the title, folded to a
  single normalised string (Legend / See-also / HTML-comment / rule chrome
  skipped). Empty when the doc has no leading paragraph.
- ``triggers``    invocation keywords for the entry. Swarm-spec docs carry no
  frontmatter and there is no routing table, so the derivable trigger is the
  doc stem itself; the list is otherwise empty (mirrors the #1296 strategies
  scope).
- ``path``        the repo-relative ``swarm/<name>.md``.
- ``body``        the full body (banner-stripped) for each proof entry. The
  swarm spec is a single canonical document today, so its lone entry IS the
  proof and carries its body; ``--proof-entry`` can override the captured set.

Usage::

    uv run python scripts/pack_migrate_swarm_spec.py \\
        [--swarm-dir swarm] [--proof-entry swarm/swarm.md] \\
        [--out packs/swarm-spec/swarm-spec-pack-0.1.json]

Exit codes:
    0 -- migrated successfully
    1 -- swarm dir missing, or no entries discovered
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

DEFAULT_SWARM_DIR = REPO_ROOT / "swarm"
DEFAULT_OUT = REPO_ROOT / "packs" / "swarm-spec" / "swarm-spec-pack-0.1.json"

PACK_ID = "swarm-spec-pack-0.1"
PACK_VERSION = "0.1"

# The single proof ENTRY whose full body is captured + regenerated as a
# banner-marked, drift-checked projection. The swarm spec is one doc today.
DEFAULT_PROOF_ENTRY = "swarm/swarm.md"

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

    Makes re-migration idempotent: after the proof entry is regenerated
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


def build_entry(md: Path, swarm_dir: Path, *, capture_body: bool) -> dict:
    """Build one swarm-spec entry from its markdown file."""
    rel_path = md.resolve().relative_to(swarm_dir.resolve().parent).as_posix()
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


def build_pack(swarm_dir: Path, *, proof_entry: str) -> dict:
    """Scan the swarm dir and assemble the full pack object."""
    entries: list[dict] = []
    for md in sorted(swarm_dir.glob("*.md")):
        rel_path = md.resolve().relative_to(swarm_dir.resolve().parent).as_posix()
        entries.append(
            build_entry(md, swarm_dir, capture_body=(rel_path == proof_entry))
        )

    return {
        "pack": PACK_ID,
        "version": PACK_VERSION,
        "generated_from": "swarm/*.md",
        "entries": entries,
    }


def migrate(swarm_dir: Path, out: Path, *, proof_entry: str) -> dict:
    """Build the pack from ``swarm_dir`` and write it to ``out``.

    Raises ``FileNotFoundError`` when the dir is missing and ``ValueError`` when
    no entries are discovered.
    """
    if not swarm_dir.is_dir():
        raise FileNotFoundError(f"swarm directory not found: {swarm_dir}")

    pack = build_pack(swarm_dir, proof_entry=proof_entry)
    if not pack["entries"]:
        raise ValueError(f"no swarm-spec docs discovered under {swarm_dir}")

    out.parent.mkdir(parents=True, exist_ok=True)
    # ensure_ascii=True: the canonical source is serialized as pure ASCII with
    # \uXXXX escapes (mirrors the other pack migrations). Lossless and keeps the
    # JSON clean against `task verify:encoding` (#798) even when a body carries
    # non-ASCII glyphs (em dashes, RFC2119 symbols, emoji in diagrams).
    out.write_text(
        json.dumps(pack, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    return pack


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pack_migrate_swarm_spec.py",
        description="Migrate swarm/*.md into the swarm-spec-pack-0.1 source.",
    )
    parser.add_argument(
        "--swarm-dir",
        type=Path,
        default=DEFAULT_SWARM_DIR,
        help="Directory of swarm-spec docs to scan (default: swarm/).",
    )
    parser.add_argument(
        "--proof-entry",
        default=DEFAULT_PROOF_ENTRY,
        help="Repo-relative path of the entry whose full body is captured.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="Output pack JSON path (default: packs/swarm-spec/swarm-spec-pack-0.1.json).",
    )
    args = parser.parse_args(argv)

    try:
        pack = migrate(args.swarm_dir, args.out, proof_entry=args.proof_entry)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    bodied = sum(1 for e in pack["entries"] if e["body"] is not None)
    print(
        f"Migrated {len(pack['entries'])} swarm-spec entries ({bodied} with body) "
        f"-> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
