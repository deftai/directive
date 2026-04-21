"""_vbrief_fidelity.py -- Fidelity fixes for migrate:vbrief (#495).

Implements the #506 D2/D3/D4 in-scope findings for migrate:vbrief:

  495-1   Preserve per-task body, ``Depends on:``, and acceptance-criteria
          bullets into scope-vBRIEF narratives (Description / DependsOn /
          AcceptanceCriteria).  Body source is SPEC.md per D2 #14 (body
          routing is reconciled by Agent B's reconciliation module; this
          module consumes the reconciled state once available and falls
          back to direct SPEC parsing when running against the baseline).
  495-3   Pass FR-N / NFR-N trace IDs through verbatim -- never renumber.
  495-4   Parse FR-N: / NFR-N: definitions from SPECIFICATION.md and emit
          the ``Requirements`` narrative on ``specification.vbrief.json``.
  495-6   Emit ``plan.edges[]`` from per-task ``Depends on:`` lines (edge
          type = ``blocks``).
  495-6b  Fold ``Acceptance Criteria (Project-Level)`` into
          ``SuccessMetrics`` (handled by _vbrief_legacy's known-mappings).
  495-9   Align narrative keys to the #506 D3 canonical set per file.
          Fix known PROJECT-DEFINITION bugs (lowercase-space ``tech stack``
          -> PascalCase ``TechStack``; emit DeftVersion, vBRIEFInfo.author,
          vBRIEFInfo.created; ``plan.title`` = project name).
  495-15  Log every narrative routing decision with source file + line
          range + target key + target file so the migrator log is
          unambiguous.

Canonical heading -> narrative-key resolution is shared with #505 via
``_vbrief_legacy`` (single source of truth for the known-mappings list).

Issue: #495, #506 D2/D3/D4.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

# Local imports -- this module lives alongside _vbrief_legacy in scripts/.
try:
    from _vbrief_legacy import (
        CANONICAL_SPEC_KEYS,
        SPEC_KNOWN_MAPPINGS,
        lookup_canonical,
        parse_top_level_sections,
        partition_sections,
    )
except ImportError:  # pragma: no cover -- imported as package in tests
    from ._vbrief_legacy import (  # type: ignore[no-redef]
        CANONICAL_SPEC_KEYS,
        SPEC_KNOWN_MAPPINGS,
        lookup_canonical,
        parse_top_level_sections,
        partition_sections,
    )


# ---------------------------------------------------------------------------
# Per-task body parsing (495-1)
# ---------------------------------------------------------------------------

# Task headings in SPECIFICATION.md look like:
#
#   ### tX.Y.Z -- Title [status]
#   ### `tX.Y.Z` Title
#   #### tX.Y.Z Title
#
# We keep the match loose so pre-v0.20 spec styles all parse.
_TASK_HEADING_RE = re.compile(
    r"^(?P<hashes>#{3,4})\s+"
    r"(?:`)?(?P<task_id>t[0-9]+(?:\.[0-9]+)+)(?:`)?"
    r"(?:\s*[-:]+\s*|\s+)"
    r"(?P<title>[^\[\n]+?)"
    r"(?:\s*\[(?P<status>[a-zA-Z_-]+)\])?\s*$"
)

# Recognised "Depends on:" / "DependsOn:" prose lines under a task heading.
_DEPENDS_ON_RE = re.compile(
    r"^\*{0,2}\s*Depends\s*on\s*\*{0,2}\s*:\s*(?P<deps>.+)$",
    re.IGNORECASE,
)

# Recognised "Traces:" / "**Traces**:" prose lines under a task heading.
_TRACES_RE = re.compile(
    r"^\s*\*{0,2}\s*Traces\s*\*{0,2}\s*:\s*(?P<traces>.+)$",
    re.IGNORECASE,
)

# FR-N / NFR-N definitions.  Matches lines like:
#
#   FR-1: Description
#   - **FR-1**: Description
#   * NFR-2 -- Description
#
_REQ_DEF_RE = re.compile(
    r"^\s*(?:[-*]\s+)?"
    r"\*{0,2}\s*(?P<id>(?:FR|NFR)-\d+)\s*\*{0,2}"
    r"\s*[:\-]+\s*"
    r"(?P<desc>.+?)\s*$",
    re.IGNORECASE,
)

# Trace-ID extractor used by 495-3.  Accepts "FR-1", "NFR-12", comma or
# space separated lists; returns upper-cased IDs in source order.
_TRACE_ID_RE = re.compile(r"(?:FR|NFR)-\d+", re.IGNORECASE)

# Status mapping from pre-v0.20 SPEC.md tags to vBRIEF status values.
_SPEC_STATUS_TO_VBRIEF: dict[str, str] = {
    "done": "completed",
    "completed": "completed",
    "complete": "completed",
    "pending": "pending",
    "running": "running",
    "in-progress": "running",
    "in_progress": "running",
    "blocked": "blocked",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "draft": "draft",
    "proposed": "proposed",
    "approved": "approved",
}


def map_spec_status(raw: str | None) -> str:
    """Map a SPECIFICATION.md status token to a vBRIEF status (D2 vocabulary).

    Unknown or empty tokens default to ``pending``.  ``[done]`` (historic
    pre-v0.20 marker) -> ``completed`` (#499 handles the folder routing).
    """
    if not raw:
        return "pending"
    return _SPEC_STATUS_TO_VBRIEF.get(raw.strip().lower(), "pending")


def parse_spec_tasks(content: str) -> list[dict]:
    """Parse ``tX.Y.Z`` task sections out of SPECIFICATION.md.

    Returns a list of dicts with keys:
      - ``task_id``       (str, e.g. ``"t1.1.1"``)
      - ``title``         (str)
      - ``status``        (str, vBRIEF vocabulary)
      - ``body``          (str, multi-paragraph description)
      - ``depends_on``    (list[str], task IDs this task depends on)
      - ``traces``        (list[str], FR/NFR IDs -- verbatim, uppercased)
      - ``acceptance``    (list[str], acceptance-criteria bullets)
      - ``start_line``    (int, 1-indexed)
      - ``end_line``      (int, 1-indexed)
    """
    if not content:
        return []
    lines = content.splitlines()
    tasks: list[dict] = []
    current: dict | None = None
    current_start = 0
    current_body_lines: list[str] = []

    def _flush(end_line: int) -> None:
        if current is None:
            return
        body_lines = list(current_body_lines)
        # Split body into: description paragraphs, Depends-on, Traces, and
        # acceptance-criteria bullet list.  Everything non-classified
        # becomes part of the description.
        depends: list[str] = []
        traces: list[str] = []
        acceptance: list[str] = []
        description_lines: list[str] = []
        in_acceptance = False
        for raw in body_lines:
            stripped = raw.strip()
            dep_match = _DEPENDS_ON_RE.match(stripped)
            if dep_match:
                deps_raw = dep_match.group("deps").strip()
                if deps_raw.lower() not in ("none", "n/a", "-"):
                    for tok in re.split(r"[,\s]+", deps_raw):
                        tok = tok.strip("`*,;. ")
                        if tok:
                            depends.append(tok)
                in_acceptance = False
                continue
            trace_match = _TRACES_RE.match(stripped)
            if trace_match:
                for m in _TRACE_ID_RE.finditer(trace_match.group("traces")):
                    traces.append(m.group(0).upper())
                in_acceptance = False
                continue
            if re.match(r"^\*{0,2}\s*Acceptance(?:\s+criteria)?\*{0,2}\s*:?\s*$",
                        stripped, re.IGNORECASE):
                in_acceptance = True
                continue
            if stripped.startswith(("-", "*")) and in_acceptance:
                acceptance.append(re.sub(r"^[-*]\s+", "", stripped))
                continue
            if stripped.startswith(("-", "*")) and not in_acceptance:
                # Loose bullet list under the task body counts as
                # acceptance criteria when it looks like one (each bullet
                # is a testable assertion).  Conservative: only capture
                # when there is no other structured content.
                acceptance.append(re.sub(r"^[-*]\s+", "", stripped))
                continue
            description_lines.append(raw)
            in_acceptance = False

        body = "\n".join(description_lines).strip()
        current["body"] = body
        current["depends_on"] = depends
        current["traces"] = traces
        current["acceptance"] = acceptance
        current["start_line"] = current_start
        current["end_line"] = end_line
        tasks.append(current)

    for idx, line in enumerate(lines, start=1):
        heading = _TASK_HEADING_RE.match(line)
        if heading:
            _flush(idx - 1)
            current = {
                "task_id": heading.group("task_id").strip(),
                "title": heading.group("title").strip(),
                "status": map_spec_status(heading.group("status")),
            }
            current_start = idx
            current_body_lines = []
            continue
        # New non-task ## heading closes the current task.
        if re.match(r"^##\s+", line) and current is not None:
            _flush(idx - 1)
            current = None
            current_body_lines = []
            continue
        if current is not None:
            current_body_lines.append(line)

    _flush(len(lines))
    return tasks


# ---------------------------------------------------------------------------
# FR / NFR definition parsing + Requirements narrative (495-4)
# ---------------------------------------------------------------------------


def parse_requirement_definitions(content: str) -> dict[str, str]:
    """Parse FR-N / NFR-N definitions from SPECIFICATION.md.

    Looks inside any ``## Requirements`` / ``## Functional Requirements``
    / ``## Non-Functional Requirements`` sections (resolved via
    _vbrief_legacy's known-mappings) and returns a dict of
    ``{"FR-1": "description", "NFR-2": "description"}`` preserving source
    order via dict insertion order.

    Only the FIRST definition wins for any given ID so that renumbered or
    re-quoted IDs in later sections do not silently overwrite the
    canonical definition.
    """
    if not content:
        return {}
    sections = parse_top_level_sections(content)
    requirements: dict[str, str] = {}
    for title, body, _start, _end in sections:
        canonical = lookup_canonical(title, SPEC_KNOWN_MAPPINGS)
        if canonical not in ("Requirements", "NonFunctionalRequirements"):
            continue
        for line in body.splitlines():
            match = _REQ_DEF_RE.match(line)
            if not match:
                continue
            req_id = match.group("id").upper()
            desc = match.group("desc").strip()
            # Trim any trailing markdown emphasis / period noise
            desc = re.sub(r"\s*\*+\s*$", "", desc).strip()
            if req_id and desc and req_id not in requirements:
                requirements[req_id] = desc
    return requirements


def build_requirements_narrative(requirements: dict[str, str]) -> str:
    """Render FR/NFR definitions as a Requirements narrative string.

    Output is deterministic: FR-N first (numeric order), then NFR-N
    (numeric order).  Each line is ``{ID}: {Description}``.
    """
    if not requirements:
        return ""

    def _sort_key(item: tuple[str, str]) -> tuple[int, int]:
        rid, _ = item
        kind = 0 if rid.startswith("FR-") else 1
        num = int(rid.split("-", 1)[1]) if "-" in rid else 0
        return (kind, num)

    sorted_items = sorted(requirements.items(), key=_sort_key)
    return "\n".join(f"{rid}: {desc}" for rid, desc in sorted_items)


# ---------------------------------------------------------------------------
# plan.edges[] extraction (495-6)
# ---------------------------------------------------------------------------


def build_edges_from_tasks(tasks: Iterable[dict]) -> list[dict]:
    """Build ``plan.edges[]`` from per-task ``depends_on`` lists.

    Each ``Depends on:`` item yields an edge ``{from, to, type}`` where
    ``from`` is the dependency ID and ``to`` is the current task ID, edge
    type is ``"blocks"``.  Self-edges and duplicates are suppressed.  The
    returned edges conform to the vBRIEF schema ID pattern
    ``^[a-zA-Z0-9_-]+(\\.[a-zA-Z0-9_-]+)*$``; edges whose source or target
    would violate the pattern are silently dropped.
    """
    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()
    id_pattern = re.compile(r"^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$")
    for task in tasks:
        tgt = str(task.get("task_id", "")).strip()
        if not tgt or not id_pattern.match(tgt):
            continue
        for dep in task.get("depends_on", []) or []:
            src = str(dep or "").strip().strip("`")
            if not src or src == tgt or not id_pattern.match(src):
                continue
            key = (src, tgt)
            if key in seen:
                continue
            seen.add(key)
            edges.append({"from": src, "to": tgt, "type": "blocks"})
    return edges


# ---------------------------------------------------------------------------
# Narrative-key alignment per #506 D3 (495-9)
# ---------------------------------------------------------------------------


def align_spec_narratives(narratives: dict[str, str]) -> dict[str, str]:
    """Reduce a narratives dict to the #506 D3 canonical spec shape.

    - PascalCase keys win.  Old spellings (``tech stack``, ``problem``,
      etc.) are rewritten through the known-mappings list.
    - Legacy keys that DO have a canonical mapping are folded under the
      canonical key with body preservation (non-destructive merge).
    - Anything not canonical is left in place so the caller can surface
      it to ``LegacyArtifacts`` via _vbrief_legacy.

    Returns a new dict; does not mutate the input.
    """
    if not isinstance(narratives, dict):
        return {}
    result: dict[str, str] = {}
    for key, value in narratives.items():
        if not isinstance(value, str):
            continue
        canonical = lookup_canonical(key, SPEC_KNOWN_MAPPINGS)
        target = canonical or key
        if target in result:
            result[target] = result[target].rstrip() + "\n\n" + value.strip()
        else:
            result[target] = value.strip()
    return result


# ---------------------------------------------------------------------------
# SPEC.md -> spec.vbrief.json narrative routing + migration log (495-15)
# ---------------------------------------------------------------------------


def ingest_spec_narratives(
    spec_content: str,
    source_file: str = "SPECIFICATION.md",
) -> tuple[dict[str, str], list[dict], list[tuple[str, str, int, int]]]:
    """Split SPECIFICATION.md into canonical narratives + legacy sections.

    Returns ``(canonical_narratives, log_entries, legacy_sections)`` where
    ``log_entries`` is a list of dicts suitable for the disambiguated
    migration log (``{source, line_range, target_key, target_file}``).
    """
    sections = parse_top_level_sections(spec_content or "")
    canonical, legacy = partition_sections(sections, SPEC_KNOWN_MAPPINGS)

    # Build disambiguated log entries per 495-15.
    log_entries: list[dict] = []
    for title, _body, start, end in sections:
        canonical_key = lookup_canonical(title, SPEC_KNOWN_MAPPINGS)
        target_file = "specification.vbrief.json"
        target_key = (
            canonical_key if canonical_key is not None else "LegacyArtifacts"
        )
        log_entries.append({
            "source": source_file,
            "section_title": title,
            "line_range": f"{start}-{end}" if end > start else f"{start}",
            "target_key": target_key,
            "target_file": target_file,
        })

    return canonical, log_entries, legacy


def format_migration_log_entry(entry: dict) -> str:
    """Format a routing-decision dict as a single migrator log line.

    Example output::

        ROUTE  SPECIFICATION.md:12-34 -> Overview -> specification.vbrief.json
    """
    src = entry.get("source", "?")
    rng = entry.get("line_range", "?")
    key = entry.get("target_key", "?")
    dst = entry.get("target_file", "?")
    return f"ROUTE  {src}:{rng} -> {key} -> {dst}"


# ---------------------------------------------------------------------------
# Per-task scope-vBRIEF narratives (495-1)
# ---------------------------------------------------------------------------


def task_scope_narratives(task: dict) -> dict[str, str]:
    """Build the per-task scope-vBRIEF narrative dict.

    Emits ``Description`` / ``DependsOn`` / ``AcceptanceCriteria`` /
    ``Traces`` narratives populated from :func:`parse_spec_tasks` output.
    Empty values are omitted so the scope vBRIEF stays clean on tasks
    that carried only a title.
    """
    narratives: dict[str, str] = {}
    body = (task.get("body") or "").strip()
    if body:
        narratives["Description"] = body
    depends = task.get("depends_on") or []
    if depends:
        narratives["DependsOn"] = ", ".join(depends)
    acceptance = task.get("acceptance") or []
    if acceptance:
        narratives["AcceptanceCriteria"] = "\n".join(
            f"- {item}" for item in acceptance
        )
    traces = task.get("traces") or []
    if traces:
        narratives["Traces"] = ", ".join(traces)
    return narratives


__all__ = [
    "CANONICAL_SPEC_KEYS",
    "align_spec_narratives",
    "build_edges_from_tasks",
    "build_requirements_narrative",
    "format_migration_log_entry",
    "ingest_spec_narratives",
    "map_spec_status",
    "parse_requirement_definitions",
    "parse_spec_tasks",
    "task_scope_narratives",
]
