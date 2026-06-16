#!/usr/bin/env python3
"""packs_slice.py -- named, structured slice access to a content pack (#1283, #1294).

Implements ``task packs:slice <pack> <name> [-- <filters>]``: the agent-facing
Layer-B slice surface from ADR-001 / the #1283 converged design.

Design contract (#1283):
- The agent-facing API is the slice NAME only (``recent``, ``by-tag``). The
  dotted path + filter dialect are pack-author implementation detail declared
  in the pack's JSON Schema ``x-sliceRegistry`` block -- NOT JSONPath, NOT a
  query language exposed to consumers.
- Slices read the CANONICAL pack source (JSON) directly, NEVER the rendered
  ``.md`` projection. Reading source guarantees byte-stable, drift-free slices.
- Output is ``text`` by default (cheapest for the read-into-context path the
  ADR optimises) with ``--json`` / ``--format json`` for harness consumers.
- Every result carries provenance: ``pack``, ``slice``, ``source`` (path),
  ``source_sha`` (sha256 of the source file).
- ``--list`` discovers slice names + one-liners; an unknown slice exits 2 with
  a did-you-mean suggestion. Three-state exit: 0 ok / 2 usage error.
- ``--list-packs`` discovers the available packs (short-name + version +
  one-liner) by scanning the on-disk pack registry (``packs/*/`` sources +
  ``vbrief/schemas/*-pack.schema.json``). It is registry-driven / self-
  extending: a new pack appears with no code change here (#1637).

Exit codes:
    0 -- ok
    2 -- usage error (unknown pack/slice, bad filter, malformed --since, ...)
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

# Repo root resolved from this file's location (scripts/ -> repo root) so pack
# source / schema paths are CWD-independent.
REPO_ROOT = Path(__file__).resolve().parent.parent

# Pack short-name -> on-disk source + schema. The slice surface resolves the
# canonical source (never the rendered .md) and the schema-declared registry.
PACK_REGISTRY: dict[str, dict[str, Path]] = {
    "lessons": {
        "source": REPO_ROOT / "packs" / "lessons" / "lessons-pack-0.1.json",
        "schema": REPO_ROOT / "vbrief" / "schemas" / "lessons-pack.schema.json",
    },
}

# Pack-LEVEL discovery (``--list-packs``, #1637) scans the on-disk pack
# registry rather than the hardcoded ``PACK_REGISTRY`` above so a new pack
# (e.g. a future skills-pack / rules-pack) appears WITHOUT any code change
# here: drop ``packs/<name>/<name>-pack-*.json`` + its
# ``vbrief/schemas/<name>-pack.schema.json`` and ``--list-packs`` lists it.
PACKS_DIR = REPO_ROOT / "packs"
SCHEMAS_DIR = REPO_ROOT / "vbrief" / "schemas"

_SINCE_RE = re.compile(r"^\d{4}-\d{2}(-\d{2})?$")

# Fallback display spec used when a pack schema declares no ``x-display`` block
# (and when ``format_slice_text`` is called without one). Mirrors the lessons
# pack's render shape so the legacy single-arg call sites stay byte-stable.
_DEFAULT_DISPLAY: dict[str, Any] = {
    "heading": "title",
    "fields": [],
    "body": "body",
    "noun": "lessons",
}


class UsageError(Exception):
    """A recoverable usage error -- mapped to exit code 2 in ``main``."""

    def __init__(self, message: str, suggestion: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.suggestion = suggestion


def sha256_file(path: Path) -> str:
    """Return the hex sha256 of a file's bytes."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _rel_to_repo(path: Path) -> str:
    """Return a repo-relative POSIX path string for provenance, or the name."""
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.name


def resolve_pack(pack_name: str) -> tuple[Path, Path]:
    """Resolve a pack short-name to its (source, schema) paths.

    Resolution is self-extending (#1295): the hardcoded ``PACK_REGISTRY`` is an
    override / fast-path (it is also the monkeypatch seam the tests use), but any
    pack that ships ``packs/<name>/<name>-pack-*.json`` plus a companion
    ``vbrief/schemas/<name>-pack.schema.json`` resolves with NO code change here
    -- the same registry-driven contract ``--list-packs`` already honours. Raises
    ``UsageError`` (with a did-you-mean suggestion) for an unknown pack.
    """
    if pack_name in PACK_REGISTRY:
        entry = PACK_REGISTRY[pack_name]
        return entry["source"], entry["schema"]

    pack_dir = PACKS_DIR / pack_name
    sources = sorted(pack_dir.glob("*.json")) if pack_dir.is_dir() else []
    schema_path = SCHEMAS_DIR / f"{pack_name}-pack.schema.json"
    if sources and schema_path.is_file():
        return sources[0], schema_path

    known = sorted({*PACK_REGISTRY, *(p["name"] for p in discover_packs())})
    suggestions = difflib.get_close_matches(pack_name, known, n=1)
    raise UsageError(
        f"unknown pack '{pack_name}'",
        suggestion=suggestions[0] if suggestions else None,
    )


def load_display(schema_path: Path) -> dict[str, Any]:
    """Load the schema-declared ``x-display`` block (slice text-render hints).

    Falls back to the lessons-shaped ``_DEFAULT_DISPLAY`` when a pack schema
    omits the block, so the slice formatter is pack-agnostic without requiring
    every pack to declare it.
    """
    if not schema_path.is_file():
        raise UsageError(f"pack schema not found: {schema_path}")
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    display = schema.get("x-display")
    if not isinstance(display, dict):
        return dict(_DEFAULT_DISPLAY)
    return display


def load_registry(schema_path: Path) -> dict[str, dict[str, Any]]:
    """Load the schema-declared ``x-sliceRegistry`` map from a pack schema."""
    if not schema_path.is_file():
        raise UsageError(f"pack schema not found: {schema_path}")
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    registry = schema.get("x-sliceRegistry")
    if not isinstance(registry, dict):
        raise UsageError(f"pack schema has no x-sliceRegistry: {schema_path}")
    return registry


def load_source(source_path: Path) -> dict[str, Any]:
    """Load the canonical pack source JSON (never the rendered .md)."""
    if not source_path.is_file():
        raise UsageError(f"pack source not found: {source_path}")
    data: dict[str, Any] = json.loads(source_path.read_text(encoding="utf-8"))
    return data


def resolve_dotted_path(data: Any, dotted: str) -> Any:
    """Walk a constrained dotted path into ``data`` with ``.get()`` guards.

    Each segment indexes a mapping; a missing / non-mapping step yields ``None``.
    This is the constrained dotted-path dialect from #1283 -- NOT JSONPath.
    """
    current = data
    for segment in dotted.split("."):
        if isinstance(current, dict):
            current = current.get(segment)
        else:
            return None
    return current


def apply_since(entries: list[dict], since: str) -> list[dict]:
    """Filter entries to those dated on or after ``since`` (year-month grain).

    ``since`` may be ``YYYY-MM`` or ``YYYY-MM-DD``; comparison is at month
    granularity (the entries' date grain). Null-dated entries are excluded.
    """
    since_ym = since[:7]
    return [e for e in entries if e.get("date") and e["date"] >= since_ym]


def apply_tags(entries: list[dict], tags: list[str]) -> list[dict]:
    """Filter entries to those carrying any of the requested ``tags``."""
    wanted = set(tags)
    return [e for e in entries if wanted & set(e.get("tags", []))]


def apply_triggers(entries: list[dict], triggers: list[str]) -> list[dict]:
    """Filter entries to those whose ``triggers`` include any requested value.

    Matching is case-insensitive exact membership: the agent passes a routing
    keyword from the AGENTS.md Skill Routing table and gets back the skill(s)
    that keyword routes to.
    """
    wanted = {t.lower() for t in triggers}
    return [
        e
        for e in entries
        if wanted & {str(t).lower() for t in e.get("triggers", [])}
    ]


def apply_scalar(entries: list[dict], field: str, values: list[str]) -> list[dict]:
    """Filter entries whose scalar ``field`` matches any requested value.

    Case-insensitive exact match on a single-valued field (e.g. the rules pack's
    ``tier`` and ``domain``), as opposed to the list-membership filters above.
    """
    wanted = {v.lower() for v in values}
    return [e for e in entries if str(e.get(field, "")).lower() in wanted]


def _normalize_issue(value: str) -> str:
    """Normalise an issue reference for comparison (strip leading '#', lower)."""
    return str(value).lstrip("#").strip().lower()


def apply_issue_refs(entries: list[dict], issues: list[str]) -> list[dict]:
    """Filter entries whose ``issue_refs`` include any requested issue number.

    The lessons pack stores issue refs as ``"#754"`` strings; the agent passes a
    bare or hashed number (``754`` / ``#754``) and both sides are normalised so
    ``--issue 754`` matches ``"#754"``. List-membership semantics (#1637).
    """
    wanted = {_normalize_issue(i) for i in issues}
    return [
        e
        for e in entries
        if wanted & {_normalize_issue(r) for r in e.get("issue_refs", [])}
    ]


def apply_select(entries: list[dict], select: dict[str, Any]) -> list[dict]:
    """Apply a slice's fixed (argument-less) predicate from its registry spec.

    Some deeper slices (#1637) subset WITHOUT an agent-supplied filter -- the
    predicate is baked into the slice name. ``select`` declares it in the pack
    schema's ``x-sliceRegistry`` entry. Supported keys:

    - ``tier_in``: keep entries whose ``tier`` is in the listed values
      (case-insensitive). Powers the rules pack ``must`` / ``prohibitions``.
    - ``body_contains_any``: keep entries whose ``body`` (case-insensitive)
      contains any listed substring. Powers the lessons pack ``anti-patterns``.

    The agent-facing contract stays the slice NAME only -- ``select`` is a
    pack-author authoring detail, never exposed as a query language (ADR-001).
    """
    result = entries
    tier_in = select.get("tier_in")
    if isinstance(tier_in, list) and tier_in:
        wanted = {str(t).lower() for t in tier_in}
        result = [e for e in result if str(e.get("tier", "")).lower() in wanted]
    needles = select.get("body_contains_any")
    if isinstance(needles, list) and needles:
        lowered = [str(n).lower() for n in needles]
        result = [
            e
            for e in result
            if any(n in str(e.get("body") or "").lower() for n in lowered)
        ]
    return result


def _validate_filters(
    slice_name: str,
    allowed: list[str],
    *,
    since: str | None,
    tags: list[str] | None,
    triggers: list[str] | None,
    tiers: list[str] | None,
    domains: list[str] | None,
    issues: list[str] | None,
    ids: list[str] | None,
) -> None:
    """Reject filters not declared for this slice in the registry."""
    provided: list[str] = []
    if since is not None:
        provided.append("since")
    if tags:
        provided.append("tag")
    if triggers:
        provided.append("trigger")
    if tiers:
        provided.append("tier")
    if domains:
        provided.append("domain")
    if issues:
        provided.append("issue")
    if ids:
        provided.append("id")
    for filt in provided:
        if filt not in allowed:
            raise UsageError(
                f"slice '{slice_name}' does not support the --{filt} filter "
                f"(allowed: {', '.join(allowed) or 'none'})"
            )


def slice_pack(
    pack_id: str,
    slice_name: str,
    registry: dict[str, dict[str, Any]],
    source_data: dict[str, Any],
    source_path: Path,
    *,
    since: str | None = None,
    tags: list[str] | None = None,
    triggers: list[str] | None = None,
    tiers: list[str] | None = None,
    domains: list[str] | None = None,
    issues: list[str] | None = None,
    ids: list[str] | None = None,
) -> dict[str, Any]:
    """Resolve and execute a named slice, returning a provenance-tagged result.

    Raises ``UsageError`` for an unknown slice (with did-you-mean), an
    unsupported filter, or a malformed ``--since`` value.
    """
    if slice_name not in registry:
        suggestions = difflib.get_close_matches(slice_name, registry, n=1)
        raise UsageError(
            f"unknown slice '{slice_name}' for pack {pack_id}",
            suggestion=suggestions[0] if suggestions else None,
        )

    spec = registry[slice_name]
    allowed = spec.get("filters", [])
    _validate_filters(
        slice_name,
        allowed,
        since=since,
        tags=tags,
        triggers=triggers,
        tiers=tiers,
        domains=domains,
        issues=issues,
        ids=ids,
    )

    if since is not None and not _SINCE_RE.match(since):
        raise UsageError(f"--since must be YYYY-MM or YYYY-MM-DD, got '{since}'")

    resolved = resolve_dotted_path(source_data, spec["path"])
    entries: list[dict] = list(resolved) if isinstance(resolved, list) else []

    # Fixed (argument-less) predicate baked into the slice name (#1637): applied
    # before the agent-supplied filters so a `must` / `anti-patterns` slice
    # subsets with no flags.
    select = spec.get("select")
    if isinstance(select, dict):
        entries = apply_select(entries, select)

    if since is not None:
        entries = apply_since(entries, since)
    if tags:
        entries = apply_tags(entries, tags)
    if triggers:
        entries = apply_triggers(entries, triggers)
    if tiers:
        entries = apply_scalar(entries, "tier", tiers)
    if domains:
        entries = apply_scalar(entries, "domain", domains)
    if issues:
        entries = apply_issue_refs(entries, issues)
    if ids:
        entries = apply_scalar(entries, "id", ids)

    return {
        "pack": pack_id,
        "slice": slice_name,
        "source": _rel_to_repo(source_path),
        "source_sha": sha256_file(source_path),
        "count": len(entries),
        "results": entries,
    }


def list_slices(
    pack_id: str,
    registry: dict[str, dict[str, Any]],
    source_path: Path,
) -> dict[str, Any]:
    """Build the ``--list`` discovery payload for a pack."""
    slices = [
        {
            "name": name,
            "description": spec.get("description", ""),
            "filters": spec.get("filters", []),
        }
        for name, spec in sorted(registry.items())
    ]
    return {
        "pack": pack_id,
        "source": _rel_to_repo(source_path),
        "source_sha": sha256_file(source_path),
        "slices": slices,
    }


def _one_line(text: str) -> str:
    """Collapse whitespace and return the first sentence of ``text``.

    Pack descriptions in the schemas are multi-paragraph; ``--list-packs``
    wants a single token-cheap one-liner, so take the leading sentence (up to
    the first period-space) of the whitespace-folded text.
    """
    folded = " ".join(text.split())
    head = folded.split(". ", 1)[0]
    return head.rstrip(".") if head else ""


def discover_packs(
    packs_dir: Path = PACKS_DIR,
    schemas_dir: Path = SCHEMAS_DIR,
) -> list[dict[str, Any]]:
    """Scan the on-disk pack registry and return sorted pack descriptors.

    Registry-driven / self-extending (#1637): each ``packs/<name>/`` directory
    holding a canonical ``*.json`` source is a pack. The short-name is the
    directory name, the version comes from the source's ``version`` field, and
    the one-line description is read from the companion
    ``vbrief/schemas/<name>-pack.schema.json`` (its ``description`` / ``title``).
    A pack added later appears here with NO code change.
    """
    packs: list[dict[str, Any]] = []
    if not packs_dir.is_dir():
        return packs
    for pack_dir in sorted(packs_dir.iterdir()):
        if not pack_dir.is_dir():
            continue
        short_name = pack_dir.name
        sources = sorted(pack_dir.glob("*.json"))
        if not sources:
            continue
        source_path = sources[0]
        try:
            source_data = json.loads(source_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        pack_id = source_data.get("pack", short_name)
        version = str(source_data.get("version", ""))

        description = ""
        schema_path = schemas_dir / f"{short_name}-pack.schema.json"
        if schema_path.is_file():
            try:
                schema = json.loads(schema_path.read_text(encoding="utf-8"))
                description = _one_line(
                    schema.get("description") or schema.get("title") or ""
                )
            except (OSError, ValueError):
                description = ""

        packs.append(
            {
                "name": short_name,
                "pack": pack_id,
                "version": version,
                "description": description,
                "source": _rel_to_repo(source_path),
            }
        )
    return packs


def list_packs(
    packs_dir: Path = PACKS_DIR,
    schemas_dir: Path = SCHEMAS_DIR,
) -> dict[str, Any]:
    """Build the ``--list-packs`` discovery payload (registry-driven)."""
    return {"packs": discover_packs(packs_dir, schemas_dir)}


def format_list_packs_text(payload: dict[str, Any]) -> str:
    """Render the ``--list-packs`` discovery payload as text."""
    packs = payload["packs"]
    if not packs:
        return "No content packs found.\n"
    lines = ["Available content packs:"]
    name_w = max(len(p["name"]) for p in packs)
    ver_w = max(len(p["version"]) for p in packs)
    for p in packs:
        lines.append(
            f"  {p['name']:<{name_w}}  {p['version']:<{ver_w}}  {p['description']}"
        )
    return "\n".join(lines) + "\n"


def format_slice_text(
    result: dict[str, Any], display: dict[str, Any] | None = None
) -> str:
    """Render a slice result as token-efficient text with a provenance header.

    The entry shape is driven by the pack schema's ``x-display`` block
    (``heading`` field, optional labelled ``fields``, optional ``body`` field,
    and the ``noun`` used in the empty-result line) so the formatter is
    pack-agnostic. When ``display`` is omitted it falls back to the
    lessons-shaped default, keeping legacy call sites byte-stable.
    """
    display = display or _DEFAULT_DISPLAY
    header = (
        f"# pack: {result['pack']} | slice: {result['slice']} | "
        f"source: {result['source']} | source_sha: {result['source_sha']} | "
        f"{result['count']} result(s)"
    )
    noun = display.get("noun", "entries")
    if not result["results"]:
        return f"{header}\n\n(no matching {noun})"

    heading_field = display.get("heading", "title")
    field_specs: list[str] = display.get("fields", [])
    body_field = display.get("body")

    parts = [header]
    for entry in result["results"]:
        block = f"\n## {entry.get(heading_field)}\n"
        field_lines: list[str] = []
        for field in field_specs:
            value = entry.get(field)
            if value in (None, "", []):
                continue
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value)
            field_lines.append(f"- {field}: {value}")
        if field_lines:
            block += "\n" + "\n".join(field_lines) + "\n"
        if body_field:
            body = entry.get(body_field)
            if body:
                block += f"\n{body}\n"
        parts.append(block)
    return "".join(parts)


def format_list_text(payload: dict[str, Any]) -> str:
    """Render the ``--list`` discovery payload as text."""
    lines = [f"Slices for pack {payload['pack']} (source: {payload['source']}):"]
    width = max((len(s["name"]) for s in payload["slices"]), default=0)
    for s in payload["slices"]:
        filters = ", ".join(s["filters"]) or "none"
        lines.append(f"  {s['name']:<{width}}  {s['description']}  [filters: {filters}]")
    return "\n".join(lines) + "\n"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="packs_slice.py",
        description="Named, structured slice access to a content pack (#1283).",
    )
    parser.add_argument(
        "pack",
        nargs="?",
        help="Pack short-name (e.g. 'lessons'). Omit with --list-packs.",
    )
    parser.add_argument(
        "name",
        nargs="?",
        help="Slice name (e.g. 'recent', 'by-tag'). Omit with --list.",
    )
    parser.add_argument("--since", help="recent filter: YYYY-MM or YYYY-MM-DD.")
    parser.add_argument(
        "--tag",
        action="append",
        default=[],
        help="by-tag filter: tag value (repeatable or comma-listed).",
    )
    parser.add_argument(
        "--trigger",
        action="append",
        default=[],
        help="by-trigger filter: routing keyword (repeatable or comma-listed).",
    )
    parser.add_argument(
        "--tier",
        action="append",
        default=[],
        help="by-tier filter: RFC2119 tier (e.g. MUST; repeatable or comma-listed).",
    )
    parser.add_argument(
        "--domain",
        action="append",
        default=[],
        help="by-domain filter: source doc stem (e.g. testing; repeatable or comma-listed).",
    )
    parser.add_argument(
        "--issue",
        action="append",
        default=[],
        help="by-issue filter: issue number, bare or hashed (e.g. 754; repeatable/comma).",
    )
    parser.add_argument(
        "--id",
        action="append",
        default=[],
        dest="ids",
        help="by-id filter: entry id (e.g. deft-directive-cost; repeatable or comma-listed).",
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="Output format (default: text).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Alias for --format json.",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        dest="list_slices",
        help="List the pack's slice names + descriptions, then exit.",
    )
    parser.add_argument(
        "--list-packs",
        action="store_true",
        dest="list_packs",
        help="List the available packs (name + version + one-liner), then exit.",
    )
    return parser


def _collect_tags(raw: list[str]) -> list[str]:
    """Flatten repeated / comma-listed --tag values into a normalised list."""
    out: list[str] = []
    for item in raw:
        out.extend(t.strip().lower() for t in item.split(",") if t.strip())
    return out


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    fmt = "json" if args.json else args.format
    tags = _collect_tags(args.tag)
    triggers = _collect_tags(args.trigger)
    tiers = _collect_tags(args.tier)
    domains = _collect_tags(args.domain)
    issues = _collect_tags(args.issue)
    ids = _collect_tags(args.ids)

    try:
        if args.list_packs:
            payload = list_packs()
            if fmt == "json":
                print(json.dumps(payload, indent=2, ensure_ascii=False))
            else:
                print(format_list_packs_text(payload), end="")
            return 0

        if not args.pack:
            raise UsageError("a pack name is required (or pass --list-packs)")

        source_path, schema_path = resolve_pack(args.pack)
        registry = load_registry(schema_path)
        display = load_display(schema_path)
        source_data = load_source(source_path)
        pack_id = source_data.get("pack", args.pack)

        if args.list_slices:
            payload = list_slices(pack_id, registry, source_path)
            if fmt == "json":
                print(json.dumps(payload, indent=2, ensure_ascii=False))
            else:
                print(format_list_text(payload), end="")
            return 0

        if not args.name:
            raise UsageError("a slice name is required (or pass --list)")

        result = slice_pack(
            pack_id,
            args.name,
            registry,
            source_data,
            source_path,
            since=args.since,
            tags=tags,
            triggers=triggers,
            tiers=tiers,
            domains=domains,
            issues=issues,
            ids=ids,
        )
        if fmt == "json":
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(format_slice_text(result, display))
        return 0
    except UsageError as exc:
        msg = f"error: {exc.message}"
        if exc.suggestion:
            msg += f". Did you mean '{exc.suggestion}'?"
        print(msg, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
