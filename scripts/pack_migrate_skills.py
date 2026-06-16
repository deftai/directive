#!/usr/bin/env python3
"""pack_migrate_skills.py -- one-shot migration: skills/ + routing -> structured pack.

Builds the canonical structured source ``packs/skills/skills-pack-0.1.json`` (the
source of truth per ADR-001) by scanning every ``skills/*/SKILL.md`` and the
AGENTS.md Skill Routing table. This is the #1295 generalization of the #1294
lessons pilot: the same render/slice machinery, a second domain.

What is captured per skill
--------------------------
- ``id``       the YAML frontmatter ``name`` (e.g. deft-directive-cost).
- ``description`` the frontmatter ``description``, folded to one normalised
  string.
- ``triggers``    the routing keywords mapped to this skill's path in the
  AGENTS.md Skill Routing table (in table order; empty when unrouted). Triggers
  are NOT read from frontmatter -- the routing table is the single source so the
  pack cannot drift from routing.
- ``path``        the repo-relative ``skills/<name>/SKILL.md``.
- ``version``     a frontmatter ``version:`` when present, else ``0.1``.
- ``body``        the full SKILL.md body (frontmatter stripped, any prior
  provenance banner stripped). Captured for EVERY skill by default (packs:slice
  v2, #1637) so every ``skills/*/SKILL.md`` is a drift-checked projection; the
  back-compat ``--proof-skill`` flag still restricts capture to one skill.
- ``frontmatter_extra``  the verbatim frontmatter lines that are NOT ``name`` or
  ``description`` (e.g. ``triggers:``, ``metadata:``, ``os:``). The renderer
  reconstructs ``name`` + a folded ``description`` itself and re-emits this block
  verbatim, so regenerating a projection is LOSSLESS -- no hand-authored
  frontmatter key is dropped. ``null`` when a skill carries only name +
  description (the proof-skill shape).

SKILL.md files without YAML frontmatter (deprecated redirect stubs) are skipped.

Usage::

    uv run python scripts/pack_migrate_skills.py \\
        [--skills-dir skills] [--agents-md AGENTS.md] \\
        [--proof-skill deft-directive-cost] \\
        [--out packs/skills/skills-pack-0.1.json]

Exit codes:
    0 -- migrated successfully
    1 -- skills dir / AGENTS.md missing, or no skills discovered
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

DEFAULT_SKILLS_DIR = REPO_ROOT / "skills"
DEFAULT_AGENTS_MD = REPO_ROOT / "AGENTS.md"
DEFAULT_OUT = REPO_ROOT / "packs" / "skills" / "skills-pack-0.1.json"

PACK_ID = "skills-pack-0.1"
PACK_VERSION = "0.1"
DEFAULT_SKILL_VERSION = "0.1"

_ROUTING_HEADING = "## Skill Routing"
_QUOTED_RE = re.compile(r'"([^"]+)"')
_PATH_RE = re.compile(r"`(skills/[^`]+/SKILL\.md)`")
_ARROW_SPLIT_RE = re.compile(r"\u2192|->")
_FRONTMATTER_RE = re.compile(r"^---\n(.*?\n)---\n?(.*)$", re.DOTALL)
_KEY_RE = re.compile(r"^([A-Za-z_][\w-]*):(.*)$")
_BLOCK_INDICATORS = {">", ">-", ">+", "|", "|-", "|+"}


def parse_routing(agents_md_text: str) -> dict[str, list[str]]:
    """Parse the AGENTS.md Skill Routing table into a path -> triggers map.

    Reads the FIRST ``## Skill Routing`` section (the maintainer table whose
    paths are repo-relative ``skills/...``), up to the next ``## `` heading. For
    each bullet, the double-quoted keywords BEFORE the arrow are the triggers and
    the backticked ``skills/.../SKILL.md`` token is the path. Bullets that route
    to a task (no SKILL.md path) are skipped. Multiple bullets mapping to the
    same path accumulate (deduped, order-preserving).
    """
    start = agents_md_text.find(_ROUTING_HEADING)
    if start == -1:
        return {}
    rest = agents_md_text[start + len(_ROUTING_HEADING):]
    end = rest.find("\n## ")
    section = rest[:end] if end != -1 else rest

    mapping: dict[str, list[str]] = {}
    for raw in section.splitlines():
        line = raw.strip()
        if not line.startswith("- "):
            continue
        path_match = _PATH_RE.search(line)
        if not path_match:
            continue
        path = path_match.group(1)
        head = _ARROW_SPLIT_RE.split(line, maxsplit=1)[0]
        keywords = _QUOTED_RE.findall(head)
        bucket = mapping.setdefault(path, [])
        for kw in keywords:
            if kw not in bucket:
                bucket.append(kw)
    return mapping


def split_frontmatter(text: str) -> tuple[str | None, str]:
    """Split a SKILL.md into (frontmatter_block, body).

    Returns ``(None, text)`` when the document has no leading ``---`` YAML
    frontmatter (e.g. a deprecated redirect stub). ``frontmatter_block`` is the
    text between the fences; ``body`` is everything after the closing fence.
    """
    if not text.startswith("---\n"):
        return None, text
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return None, text
    return match.group(1), match.group(2)


def _fold_block(block_lines: list[str]) -> str:
    """Fold a YAML folded block scalar's lines into a single normalised string.

    Non-empty lines within a paragraph join with single spaces; blank lines
    separate paragraphs (joined with a newline). Sufficient for the single-
    paragraph skill descriptions in this repo.
    """
    paragraphs: list[str] = []
    current: list[str] = []
    for line in block_lines:
        if line.strip() == "":
            if current:
                paragraphs.append(" ".join(current))
                current = []
        else:
            current.append(line.strip())
    if current:
        paragraphs.append(" ".join(current))
    return "\n".join(paragraphs)


def parse_frontmatter_fields(frontmatter: str) -> dict[str, str]:
    """Extract scalar / folded fields (name, description, version, ...).

    Handles inline scalars (``name: foo``), folded / literal block scalars
    (``description: >``), and skips list values (``triggers:`` + ``- item``).
    Only top-level (zero-indent) keys are recognised.
    """
    lines = frontmatter.split("\n")
    fields: dict[str, str] = {}
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        match = _KEY_RE.match(line)
        if not match or line.startswith((" ", "\t")):
            i += 1
            continue
        key = match.group(1)
        value = match.group(2).strip()
        if value in _BLOCK_INDICATORS:
            block: list[str] = []
            i += 1
            while i < n:
                nxt = lines[i]
                if nxt.strip() == "":
                    block.append("")
                    i += 1
                    continue
                if nxt.startswith((" ", "\t")):
                    block.append(nxt)
                    i += 1
                    continue
                break
            fields[key] = _fold_block(block)
            continue
        if value == "" or value.startswith("- "):
            # Likely a block sequence (e.g. triggers:). Consume its `- ` items
            # so they are not mis-parsed as top-level keys; value is not needed.
            i += 1
            while i < n and (
                lines[i].lstrip().startswith("- ") or lines[i].startswith((" ", "\t"))
            ):
                i += 1
            fields.setdefault(key, "")
            continue
        fields[key] = value.strip().strip('"').strip("'")
        i += 1
    return fields


def extract_extra_frontmatter(frontmatter: str) -> str | None:
    """Return the verbatim frontmatter lines that are NOT ``name``/``description``.

    The renderer reconstructs ``name`` + a folded ``description`` from the
    structured fields, but every OTHER top-level key a skill declares
    (``triggers:``, ``metadata:``, ``os:``, ``version:``, ...) must survive the
    round-trip so regenerating a projection is LOSSLESS -- the migration would
    otherwise silently drop e.g. ``metadata.clawdbot.requires.bins`` (#1637).

    Each top-level key (and its block-scalar / block-sequence / nested
    continuation lines) is preserved verbatim. Returns ``None`` when only
    ``name`` + ``description`` are present (the proof-skill shape), so the
    renderer emits exactly the name + description frontmatter.
    """
    lines = frontmatter.split("\n")
    extra: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        match = _KEY_RE.match(line)
        if not match or line.startswith((" ", "\t")):
            i += 1
            continue
        key = match.group(1)
        value = match.group(2).strip()
        block = [line]
        i += 1
        if value in _BLOCK_INDICATORS:
            while i < n and (lines[i].strip() == "" or lines[i].startswith((" ", "\t"))):
                block.append(lines[i])
                i += 1
        elif value == "" or value.startswith("- "):
            while i < n and (
                lines[i].lstrip().startswith("- ") or lines[i].startswith((" ", "\t"))
            ):
                block.append(lines[i])
                i += 1
        if key not in ("name", "description"):
            extra.extend(block)
    while extra and extra[-1].strip() == "":
        extra.pop()
    return "\n".join(extra) if extra else None


def strip_leading_banner(body: str) -> str:
    """Strip a leading provenance banner + blank lines from a captured body.

    Makes re-migration idempotent: after the proof skill's SKILL.md is
    regenerated (frontmatter + banner + body), re-running the migration must
    recover the same body. Only strips a banner block that opens with the
    renderer's first banner line, so unrelated leading HTML comments survive.
    """
    lines = body.split("\n")
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    if i < len(lines) and lines[i].startswith("<!-- AUTO-GENERATED by task packs:render"):
        while i < len(lines) and lines[i].lstrip().startswith("<!--"):
            i += 1
        while i < len(lines) and lines[i].strip() == "":
            i += 1
    return "\n".join(lines[i:])


def build_skill_entry(
    skill_md: Path,
    skills_dir: Path,
    routing: dict[str, list[str]],
    *,
    capture_body: bool,
) -> dict | None:
    """Build one skill entry, or None when the file has no YAML frontmatter."""
    text = skill_md.read_text(encoding="utf-8")
    frontmatter, body = split_frontmatter(text)
    if frontmatter is None:
        return None
    fields = parse_frontmatter_fields(frontmatter)
    name = fields.get("name", "").strip()
    if not name:
        return None

    rel_path = skill_md.resolve().relative_to(skills_dir.resolve().parent).as_posix()
    triggers = routing.get(rel_path, [])
    version = fields.get("version", "").strip() or DEFAULT_SKILL_VERSION
    captured = strip_leading_banner(body) if capture_body else None

    return {
        "id": name,
        "description": fields.get("description", "").strip(),
        "triggers": triggers,
        "path": rel_path,
        "version": version,
        "body": captured,
        "frontmatter_extra": extract_extra_frontmatter(frontmatter),
    }


def build_pack(
    skills_dir: Path,
    agents_md: Path,
    *,
    proof_skill: str | None,
) -> dict:
    """Scan the skills dir + routing table and assemble the full pack object.

    ``proof_skill`` is the back-compat single-skill restrictor: when ``None``
    (the default, packs:slice v2 / #1637) the body is captured for EVERY skill;
    when set, only that one skill's body is captured (the #1295 proof shape).
    """
    routing = parse_routing(agents_md.read_text(encoding="utf-8"))
    capture_all = proof_skill is None
    proof_path = f"skills/{proof_skill}/SKILL.md" if proof_skill else None

    skills: list[dict] = []
    for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
        rel_path = skill_md.resolve().relative_to(skills_dir.resolve().parent).as_posix()
        entry = build_skill_entry(
            skill_md,
            skills_dir,
            routing,
            capture_body=(capture_all or rel_path == proof_path),
        )
        if entry is not None:
            skills.append(entry)

    return {
        "pack": PACK_ID,
        "version": PACK_VERSION,
        "generated_from": "skills/*/SKILL.md + AGENTS.md (Skill Routing)",
        "skills": skills,
    }


def migrate(
    skills_dir: Path,
    agents_md: Path,
    out: Path,
    *,
    proof_skill: str | None,
) -> dict:
    """Build the pack from ``skills_dir`` + ``agents_md`` and write it to ``out``.

    Raises ``FileNotFoundError`` when an input is missing and ``ValueError`` when
    no frontmatter-bearing skills are discovered.
    """
    if not skills_dir.is_dir():
        raise FileNotFoundError(f"skills directory not found: {skills_dir}")
    if not agents_md.is_file():
        raise FileNotFoundError(f"AGENTS.md not found: {agents_md}")

    pack = build_pack(skills_dir, agents_md, proof_skill=proof_skill)
    if not pack["skills"]:
        raise ValueError(f"no skills with frontmatter discovered under {skills_dir}")

    out.parent.mkdir(parents=True, exist_ok=True)
    # ensure_ascii=True: the canonical source is serialized as pure ASCII with
    # \uXXXX escapes (mirrors pack_migrate_lessons). Lossless and keeps the JSON
    # clean against `task verify:encoding` (#798) even when a skill body carries
    # non-ASCII glyphs (em dashes, RFC2119 symbols).
    out.write_text(json.dumps(pack, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    return pack


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pack_migrate_skills.py",
        description="Migrate skills/ + AGENTS.md routing into the skills-pack-0.1 source.",
    )
    parser.add_argument(
        "--skills-dir",
        type=Path,
        default=DEFAULT_SKILLS_DIR,
        help="Directory of skill folders to scan (default: skills/).",
    )
    parser.add_argument(
        "--agents-md",
        type=Path,
        default=DEFAULT_AGENTS_MD,
        help="AGENTS.md whose Skill Routing table maps keywords -> paths.",
    )
    parser.add_argument(
        "--proof-skill",
        default=None,
        help="Back-compat: restrict body capture to ONE skill's directory name "
        "(e.g. deft-directive-cost). Default: capture every skill's body (#1637).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="Output pack JSON path (default: packs/skills/skills-pack-0.1.json).",
    )
    args = parser.parse_args(argv)

    try:
        pack = migrate(
            args.skills_dir,
            args.agents_md,
            args.out,
            proof_skill=args.proof_skill,
        )
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    bodied = sum(1 for s in pack["skills"] if s["body"] is not None)
    print(
        f"Migrated {len(pack['skills'])} skills ({bodied} with body) -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
