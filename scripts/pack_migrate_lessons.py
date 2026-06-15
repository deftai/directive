#!/usr/bin/env python3
"""pack_migrate_lessons.py -- one-shot migration: meta/lessons.md -> structured pack.

Parses the hand-authored ``meta/lessons.md`` into the canonical structured
source ``packs/lessons/lessons-pack-0.1.json`` (the source of truth per
ADR-001; ``meta/lessons.md`` then becomes a regenerated projection via
``scripts/pack_render.py``).

Parsing model
-------------
The document is split on top-level ``## `` headings. Everything before the
first ``## `` heading (the ``# Lessons Learned`` title + any authoring
comment) is document chrome owned by the renderer and is discarded here.
For each section:

- ``title`` is the full heading text (verbatim, so the projection round-trips).
- ``date`` is the ``YYYY-MM`` extracted from the heading parenthetical, or null.
- ``issue_refs`` is every ``#NNN`` reference in the heading, in order.
- ``source`` is the text of the body's ``**Source:**`` line, or null.
- ``tags`` is 1-3 tags from the controlled vocabulary, scored from keywords.
- ``body`` is the full section body verbatim (lossless blob).

Usage::

    uv run python scripts/pack_migrate_lessons.py [--source meta/lessons.md] \\
        [--out packs/lessons/lessons-pack-0.1.json]

Exit codes:
    0 -- migrated successfully
    1 -- source markdown missing or empty
    2 -- usage error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Repo root resolved from this file's location (scripts/ -> repo root). Used to
# anchor the default source / output paths so the migration is CWD-independent.
REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_SOURCE = REPO_ROOT / "meta" / "lessons.md"
DEFAULT_OUT = REPO_ROOT / "packs" / "lessons" / "lessons-pack-0.1.json"

PACK_ID = "lessons-pack-0.1"
PACK_VERSION = "0.1"

# Controlled tag vocabulary. MUST stay in lockstep with the `enum` and
# `x-tagVocabulary` in vbrief/schemas/lessons-pack.schema.json.
TAG_VOCABULARY: tuple[str, ...] = (
    "windows",
    "encoding",
    "review-cycle",
    "swarm",
    "release",
    "github",
    "context",
    "debugging",
    "lifecycle",
    "powershell",
    "ci",
    "agent-orchestration",
)

# Keyword -> tag scoring table. Matches are lowercase substring tests against
# the title (weighted heavily) and body (weighted lightly). The tokens are
# deliberately specific to keep the controlled vocabulary discriminating.
TAG_KEYWORDS: dict[str, tuple[str, ...]] = {
    "windows": ("windows", "cp1252", "cp437", "charmap", "win32", "winerror"),
    "encoding": (
        "encoding",
        "utf-8",
        "utf8",
        "mojibake",
        "non-ascii",
        "u+fffd",
        " bom",
        "unicodedecode",
        "unicodeencode",
    ),
    "review-cycle": (
        "review cycle",
        "review-cycle",
        "greptile",
        "review bot",
        "checkrun",
        "check run",
    ),
    "swarm": ("swarm", "parallel agent", "worktree", "cohort", "cascade"),
    "release": ("release", "changelog", "publish", "v0.", "tag time", "cut session"),
    "github": (
        "github",
        "gh api",
        "gh cli",
        "gh issue",
        "gh pr",
        "graphql",
        "rest",
        "pull request",
        "closingissues",
    ),
    "context": ("context engineering", "context rot", "context window", "token", "low-signal"),
    "debugging": (
        "debug",
        "root cause",
        "root-cause",
        "investigation",
        "forensic",
        "blind spot",
    ),
    "lifecycle": (
        "lifecycle",
        "vbrief",
        "scope:",
        "promote",
        "activate",
        "reconcile",
    ),
    "powershell": (
        "powershell",
        "pwsh",
        "ps 5.1",
        "ps5.1",
        "get-content",
        "set-content",
        "here-string",
    ),
    "ci": ("pre-commit", "task check", "deterministic gate", " gate ", "pipeline", "self-test"),
    "agent-orchestration": (
        "orchestrat",
        "poller",
        "dispatch",
        "sub-agent",
        "subagent",
        "agent run",
        "spawn",
        "monitor agent",
    ),
}

# Fallback tag when no keyword scores -- every entry must carry >= 1 tag.
FALLBACK_TAG = "agent-orchestration"

_HEADING_RE = re.compile(r"^## (.+)$")
_DATE_RE = re.compile(r"(\d{4}-\d{2})(?:-\d{2})?")
_ISSUE_RE = re.compile(r"#(\d+)")
_SOURCE_RE = re.compile(r"^\*\*Source:\*\*\s*(.+?)\s*$")
_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")


def extract_date(title: str) -> str | None:
    """Return the YYYY-MM date from a heading, or None when absent."""
    match = _DATE_RE.search(title)
    return match.group(1) if match else None


def extract_issue_refs(title: str) -> list[str]:
    """Return all ``#NNN`` references in a heading, in order of appearance."""
    return [f"#{n}" for n in _ISSUE_RE.findall(title)]


def extract_source(body: str) -> str | None:
    """Return the text of the first ``**Source:**`` line in the body, or None."""
    for line in body.splitlines():
        match = _SOURCE_RE.match(line.strip())
        if match:
            return match.group(1)
    return None


def slugify(title: str, existing: set[str]) -> str:
    """Derive a stable, unique, lowercase slug from a title.

    Strips a trailing parenthetical date / issue ref before slugifying so the
    id stays readable, then de-duplicates against ``existing`` by appending a
    numeric suffix.
    """
    base = _SLUG_STRIP_RE.sub("-", title.lower()).strip("-")
    if not base:
        base = "lesson"
    slug = base
    counter = 2
    while slug in existing:
        slug = f"{base}-{counter}"
        counter += 1
    existing.add(slug)
    return slug


def assign_tags(title: str, body: str) -> list[str]:
    """Assign 1-3 controlled-vocabulary tags by keyword scoring.

    Title matches weigh 5x body matches. The top-scoring tags (score > 0) are
    returned, capped at 3, ordered by score desc then by vocabulary order for
    determinism. Falls back to a single default tag when nothing scores.
    """
    title_l = title.lower()
    body_l = body.lower()
    scores: dict[str, int] = {}
    for tag in TAG_VOCABULARY:
        score = 0
        for kw in TAG_KEYWORDS[tag]:
            if kw in title_l:
                score += 5
            score += body_l.count(kw)
        if score > 0:
            scores[tag] = score

    if not scores:
        return [FALLBACK_TAG]

    vocab_order = {tag: i for i, tag in enumerate(TAG_VOCABULARY)}
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], vocab_order[kv[0]]))
    return [tag for tag, _ in ranked[:3]]


def parse_lessons(md_text: str) -> list[dict]:
    """Parse lessons markdown into structured lesson entries.

    Splits on top-level ``## `` headings; content before the first heading is
    discarded (renderer-owned chrome). Returns entries in document order.
    """
    lines = md_text.splitlines()
    # Collect (heading_text, start_line_index_of_body) for each section.
    sections: list[tuple[str, int]] = []
    for idx, line in enumerate(lines):
        match = _HEADING_RE.match(line)
        if match:
            sections.append((match.group(1).strip(), idx))

    entries: list[dict] = []
    existing_ids: set[str] = set()
    for s_idx, (title, head_line) in enumerate(sections):
        end_line = sections[s_idx + 1][1] if s_idx + 1 < len(sections) else len(lines)
        body = "\n".join(lines[head_line + 1 : end_line]).strip()
        entries.append(
            {
                "id": slugify(title, existing_ids),
                "title": title,
                "date": extract_date(title),
                "issue_refs": extract_issue_refs(title),
                "tags": assign_tags(title, body),
                "source": extract_source(body),
                "body": body,
            }
        )
    return entries


def build_pack(md_text: str, generated_from: str) -> dict:
    """Build the full pack object from the source markdown text."""
    return {
        "pack": PACK_ID,
        "version": PACK_VERSION,
        "generated_from": generated_from,
        "lessons": parse_lessons(md_text),
    }


def migrate(source: Path, out: Path) -> dict:
    """Read ``source`` markdown, build the pack, and write it to ``out``.

    Returns the in-memory pack object. Raises ``FileNotFoundError`` when the
    source is missing and ``ValueError`` when it is empty.
    """
    if not source.is_file():
        raise FileNotFoundError(f"source markdown not found: {source}")
    md_text = source.read_text(encoding="utf-8")
    if not md_text.strip():
        raise ValueError(f"source markdown is empty: {source}")

    # Record provenance as a repo-relative path when possible.
    try:
        generated_from = source.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        generated_from = source.name

    pack = build_pack(md_text, generated_from)
    out.parent.mkdir(parents=True, exist_ok=True)
    # ensure_ascii=True: the canonical source is serialized as pure ASCII with
    # \uXXXX escapes. This is lossless (json.loads reconstructs the exact same
    # strings, so the rendered projection and slice output are byte-identical),
    # and it keeps the source clean against `task verify:encoding` (#798): the
    # lessons content legitimately documents cp1252/cp437 mojibake example
    # tokens (e.g. the corrupted form of the U+2297 glyph), which the encoding
    # gate's markdown inline-code stripping exempts in meta/lessons.md but
    # would flag as a raw bigram in the JSON. Escaping sidesteps that without
    # mutating the preserved content.
    out.write_text(json.dumps(pack, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    return pack


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pack_migrate_lessons.py",
        description="Migrate meta/lessons.md into the structured lessons-pack-0.1 source.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help="Source markdown to parse (default: meta/lessons.md).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="Output pack JSON path (default: packs/lessons/lessons-pack-0.1.json).",
    )
    args = parser.parse_args(argv)

    try:
        pack = migrate(args.source, args.out)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"Migrated {len(pack['lessons'])} lessons -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
