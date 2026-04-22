#!/usr/bin/env python3
"""
spec_render.py — Render a vbrief specification JSON file to SPECIFICATION.md.

Usage:
    uv run python scripts/spec_render.py <spec_file> [out_file] [--include-scopes=on|off]

    spec_file — path to vbrief/specification.vbrief.json
    out_file  — output path (default: <spec_file's grandparent>/SPECIFICATION.md)
    --include-scopes=on|off
              — include (default) or exclude the Implementation Plan section
                aggregated from vbrief/{pending,active,completed} scope vBRIEFs (#435)

Exit codes:
    0 — rendered successfully
    1 — validation failed or status not in ('approved', 'running', 'completed')
    2 — usage error (no argument provided)

Implementation: IMPLEMENTATION.md Phase 5.2; lifecycle aggregator per #435.
"""

import json
import sys
from pathlib import Path

# Allow co-located import of spec_validate when run as a script
sys.path.insert(0, str(Path(__file__).parent))
from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from spec_validate import validate_spec  # noqa: E402

# UTF-8 stdout guard (#540).
reconfigure_stdio()

# Declared narrative ordering for SPECIFICATION.md. Covers both the
# interview/light key set (Overview, ProblemStatement, Goals, UserStories,
# Requirements, SuccessMetrics, Architecture) and the speckit Phase 2/3 key
# set (EdgeCases, TechDecisions, ImplementationPhases, PreImplementationGates).
# Narratives present on the spec render in this declared order; any other
# narrative keys render after these, sorted alphabetically. See #434.
SPECIFICATION_NARRATIVE_KEY_ORDER = [
    "Overview",
    "ProblemStatement",
    "Goals",
    "UserStories",
    "Requirements",
    "SuccessMetrics",
    "EdgeCases",
    "Architecture",
    "TechDecisions",
    "ImplementationPhases",
    "PreImplementationGates",
]

# Lifecycle folders walked by the scope aggregator, in render order (#435).
LIFECYCLE_BUCKETS: tuple[tuple[str, str], ...] = (
    ("pending", "Pending"),
    ("active", "Active"),
    ("completed", "Completed"),
)

# Narrative key resolution order used when rendering a scope's summary line.
_SCOPE_SUMMARY_NARRATIVES = (
    "Overview",
    "Summary",
    "Description",
    "ProblemStatement",
    "Problem",
    "Outcome",
)


def _read_edge_endpoints(edge: dict) -> tuple[str, str]:
    """Bilingual edge reader: prefer ``{from, to}``, fall back to ``{source, target}``.

    Mirrors the reader in ``roadmap_render._read_edge_endpoints`` per #458 --
    when both conventions are present on a single edge, canonical ``from``/``to``
    wins. Replicated here rather than imported to keep the lifecycle aggregator
    decoupled from roadmap rendering.
    """
    if not isinstance(edge, dict):
        return "", ""
    frm = edge.get("from") or edge.get("source", "") or ""
    to = edge.get("to") or edge.get("target", "") or ""
    return frm, to


def _load_scope_vbriefs(folder: Path) -> list[tuple[str, dict]]:
    """Load ``*.vbrief.json`` files from a lifecycle folder.

    Returns a list of ``(filename_stem, vbrief_data)`` tuples, sorted by
    filename. Missing / non-directory / malformed files are skipped silently
    so the aggregator never prevents a successful render.
    """
    if not folder.is_dir():
        return []
    out: list[tuple[str, dict]] = []
    for path in sorted(folder.glob("*.vbrief.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        stem = path.name
        if stem.endswith(".vbrief.json"):
            stem = stem[: -len(".vbrief.json")]
        out.append((stem, data))
    return out


def _scope_id(stem: str, vbrief: dict) -> str:
    """Resolve a stable identifier for a scope used in cross-scope edge lookup."""
    plan = vbrief.get("plan", {})
    if isinstance(plan, dict):
        plan_id = plan.get("id", "")
        if isinstance(plan_id, str) and plan_id:
            return plan_id
    return stem


def _cross_scope_dep_map(scopes: list[tuple[str, dict]]) -> dict[str, list[str]]:
    """Build a cross-scope dep map using the bilingual edge reader (#458).

    Only edges whose endpoints match scope IDs present in ``scopes`` contribute
    to ordering; out-of-scope endpoints are ignored silently so a scope cannot
    silently pin the whole render to an unresolved id.
    """
    scope_ids = {_scope_id(stem, vb) for stem, vb in scopes}
    dep_map: dict[str, list[str]] = {}
    for _stem, vbrief in scopes:
        plan = vbrief.get("plan", {})
        if not isinstance(plan, dict):
            continue
        edges = plan.get("edges", [])
        if not isinstance(edges, list):
            continue
        for edge in edges:
            frm, to = _read_edge_endpoints(edge)
            if frm in scope_ids and to in scope_ids and frm and to:
                dep_map.setdefault(to, []).append(frm)
    return dep_map


def _topo_sort_scopes(
    scopes: list[tuple[str, dict]],
    dep_map: dict[str, list[str]],
) -> list[tuple[str, dict]]:
    """Order scopes by longest dependency chain depth; fall back to filename order."""
    if not scopes:
        return []
    id_by_index = [_scope_id(stem, vb) for stem, vb in scopes]
    id_to_index = {sid: i for i, sid in enumerate(id_by_index)}
    depths: dict[str, int] = {}

    def _depth(sid: str, visited: set[str] | None = None) -> int:
        if sid in depths:
            return depths[sid]
        if visited is None:
            visited = set()
        if sid in visited:
            return 0
        visited.add(sid)
        deps = [d for d in dep_map.get(sid, []) if d in id_to_index]
        if not deps:
            depths[sid] = 0
            return 0
        result = max(_depth(d, visited) for d in deps) + 1
        depths[sid] = result
        return result

    for sid in id_by_index:
        _depth(sid)

    ordered_indices = sorted(
        range(len(scopes)),
        key=lambda i: (depths.get(id_by_index[i], 0), i),
    )
    return [scopes[i] for i in ordered_indices]


def _scope_summary_narrative(plan: dict) -> str:
    """Pick the most informative narrative string for a scope summary line."""
    if not isinstance(plan, dict):
        return ""
    narratives = plan.get("narratives", {})
    if not isinstance(narratives, dict):
        return ""
    for key in _SCOPE_SUMMARY_NARRATIVES:
        val = narratives.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    # Fallback: first non-empty string narrative in insertion order.
    for val in narratives.values():
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _render_scope_block(stem: str, vbrief: dict) -> list[str]:
    """Render a single scope vBRIEF as a markdown block inside Implementation Plan."""
    plan = vbrief.get("plan", {})
    if not isinstance(plan, dict):
        return []
    title = plan.get("title", stem)
    status = plan.get("status", "")
    heading_parts = [f"### {stem}: {title}"]
    if status:
        heading_parts[0] += f"  `[{status}]`"
    lines: list[str] = [heading_parts[0] + "\n"]

    summary = _scope_summary_narrative(plan)
    if summary:
        lines.append(f"{summary}\n")

    # Acceptance items -- each plan.items entry rendered as a bullet with status.
    items = plan.get("items", [])
    if isinstance(items, list) and items:
        lines.append("**Acceptance**:\n")
        for item in items:
            if not isinstance(item, dict):
                continue
            item_title = item.get("title", "Untitled")
            item_status = item.get("status", "")
            bullet = f"- {item_title}"
            if item_status:
                bullet += f" `[{item_status}]`"
            lines.append(bullet)
        lines.append("")
    return lines


def _aggregate_scope_section(vbrief_dir: Path) -> list[str]:
    """Build the Implementation Plan section from vbrief/{pending,active,completed}.

    Returns an empty list if no scope vBRIEFs exist in any lifecycle folder.
    """
    buckets: list[tuple[str, str, list[tuple[str, dict]]]] = []
    for folder_name, heading in LIFECYCLE_BUCKETS:
        scopes = _load_scope_vbriefs(vbrief_dir / folder_name)
        if folder_name == "completed":
            # Status pin: only completed scopes rendered under Completed.
            scopes = [
                (stem, vb)
                for stem, vb in scopes
                if isinstance(vb.get("plan"), dict)
                and vb["plan"].get("status") == "completed"
            ]
        if scopes:
            buckets.append((folder_name, heading, scopes))

    if not buckets:
        return []

    lines: list[str] = ["## Implementation Plan\n"]
    for _folder, heading, scopes in buckets:
        dep_map = _cross_scope_dep_map(scopes)
        ordered = _topo_sort_scopes(scopes, dep_map)
        lines.append(f"### {heading}\n")
        for stem, vbrief in ordered:
            lines.extend(_render_scope_block(stem, vbrief))
    return lines


def render_spec(
    spec_path: str,
    out_path: str,
    include_scopes: bool = True,
) -> tuple[bool, str]:
    """
    Render the approved spec at *spec_path* to markdown at *out_path*.

    Returns:
        (True, success_message) on success.
        (False, error_message)  on failure.
    """
    # Validate first
    ok, msg = validate_spec(spec_path)
    if not ok:
        return False, msg

    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)

    # Support vBRIEF v0.5 envelope structure
    plan = spec.get("plan", {})
    status = plan.get("status", "") if isinstance(plan, dict) else spec.get("status", "")

    renderable_statuses = ("approved", "running", "completed")
    if status not in renderable_statuses:
        return (
            False,
            f"⚠ specification.vbrief.json status is '{status}' "
            f"(expected one of {renderable_statuses})\n"
            "  Have the user review and set status to one of the"
            " renderable statuses before rendering.",
        )

    lines: list[str] = []

    if isinstance(plan, dict):
        title = plan.get("title", "Specification")
    else:
        title = plan or spec.get("title", "Specification")
    lines.append(f"# {title}\n")

    # Render narratives in declared order, then remaining keys alphabetically.
    # Mirrors prd_render.py behavior -- speckit-shaped specs (ProblemStatement,
    # Goals, Requirements, etc.) must not be silently dropped (#434).
    if isinstance(plan, dict):
        narratives = plan.get("narratives", {})
        if not isinstance(narratives, dict):
            narratives = {}
    else:
        # Legacy flat-format specs may carry overview/description at top level.
        legacy_overview = spec.get("overview") or spec.get("description") or ""
        narratives = {"Overview": legacy_overview} if legacy_overview else {}

    rendered_keys: set[str] = set()
    for key in SPECIFICATION_NARRATIVE_KEY_ORDER:
        if key in narratives and narratives[key]:
            lines.append(f"## {key}\n")
            lines.append(f"{narratives[key]}\n")
            rendered_keys.add(key)

    for key in sorted(narratives.keys()):
        if key in rendered_keys or not narratives.get(key):
            continue
        lines.append(f"## {key}\n")
        lines.append(f"{narratives[key]}\n")

    # Extract items from plan.items (v0.5) or spec.tasks (legacy). Items render
    # after narratives so hybrid/legacy specs (items + narratives) still produce
    # complete output.
    items = plan.get("items", []) if isinstance(plan, dict) else spec.get("tasks", [])
    for item in items:
        item_id = item.get("id", "")
        title_text = item.get("title", "")
        item_status = item.get("status", "")
        lines.append(f"## {item_id}: {title_text}  `[{item_status}]`\n")

        # Dependencies from metadata (v0.5) or inline (legacy)
        deps = None
        if metadata := item.get("metadata"):
            deps = metadata.get("dependencies")
        if not deps:
            deps = item.get("dependencies")
        if deps:
            dep_list = ", ".join(deps)
            lines.append(f"**Depends on**: {dep_list}\n")

        # Narrative is an object in v0.5, string/list in legacy
        narrative = item.get("narrative")
        if isinstance(narrative, dict):
            for key, val in narrative.items():
                if key == "Traces":
                    lines.append(f"**Traces**: {val}\n")
                elif key == "Acceptance":
                    if isinstance(val, list):
                        criteria = val
                    else:
                        criteria = [c for c in str(val).split("; ") if c]
                    for criterion in criteria:
                        lines.append(f"- {criterion}")
                    lines.append("")
                else:
                    lines.append(f"{val}\n")
        elif isinstance(narrative, list):
            for entry in narrative:
                lines.append(f"- {entry}")
            lines.append("")
        elif narrative:
            lines.append(f"{narrative}\n")

    # Aggregator: append Implementation Plan from lifecycle folders (#435).
    if include_scopes:
        vbrief_dir = Path(spec_path).resolve().parent
        scope_lines = _aggregate_scope_section(vbrief_dir)
        if scope_lines:
            lines.extend(scope_lines)

    Path(out_path).write_text("\n".join(lines), encoding="utf-8")
    return True, f"✓ Rendered to {out_path}"


def _parse_include_scopes_flag(argv: list[str]) -> tuple[bool, list[str]]:
    """Extract ``--include-scopes[=on|off]`` from argv.

    Returns ``(include_scopes, remaining_argv)``. Defaults to True (#435).
    Accepts ``--include-scopes``, ``--include-scopes=on``, ``--include-scopes=off``,
    ``--include-scopes=true``, ``--include-scopes=false`` (case-insensitive on value).
    """
    include = True
    remaining: list[str] = []
    for arg in argv:
        if arg == "--include-scopes":
            include = True
            continue
        if arg.startswith("--include-scopes="):
            value = arg.split("=", 1)[1].lower()
            include = value in ("on", "true", "1", "yes")
            continue
        remaining.append(arg)
    return include, remaining


def main() -> int:
    include_scopes, positional = _parse_include_scopes_flag(sys.argv[1:])
    if not positional:
        print(
            "Usage: spec_render.py <spec_file> [out_file] [--include-scopes=on|off]",
            file=sys.stderr,
        )
        return 2

    spec_path = positional[0]
    if len(positional) >= 2:
        out_path = positional[1]
    else:
        # Default: place SPECIFICATION.md at the grandparent of the spec file
        # e.g. vbrief/specification.vbrief.json → SPECIFICATION.md
        out_path = str(Path(spec_path).resolve().parent.parent / "SPECIFICATION.md")

    ok, message = render_spec(spec_path, out_path, include_scopes=include_scopes)
    print(message)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
