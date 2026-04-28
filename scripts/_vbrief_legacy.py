"""_vbrief_legacy.py -- LegacyArtifacts mechanism for migrate:vbrief (#505).

Shared known-mappings list + normalization for both canonical extraction
(#495, consumed by ``_vbrief_fidelity``) and non-canonical capture (#505,
consumed by ``migrate_vbrief``).  Hard-coded for v0.20 per #506 D5;
config-driven extensibility is a v0.21+ feature request.

Exports
-------
SPEC_KNOWN_MAPPINGS, PROJECT_KNOWN_MAPPINGS
    Normalized-heading -> canonical-narrative-key dicts covering the locked
    v0.20 aliases per #506 D5.
normalize_title(title)
    Four-rule normalization: case-insensitive + whitespace-collapsed +
    punctuation-stripped + word-separator-tolerant.
lookup_canonical(title, mapping)
    Return the canonical key for a heading, or None if unknown (legacy).
parse_top_level_sections(content)
    Split markdown content at top-level ``## `` boundaries; returns a list
    of ``(title, body, start_line, end_line)`` tuples.  Substructure (H3
    etc.) is preserved verbatim inside each body.
partition_sections(sections, mapping)
    Split parsed sections into canonical (matches known-mappings) and
    legacy (no match) buckets.
emit_legacy_artifacts(legacy_sections, source_file, project_root, *, slugify_fn,
                       warning_prefix=None, event_emitter=None)
    Build the LegacyArtifacts narrative string for one vBRIEF file, write
    any >6 KB sidecars under ``vbrief/legacy/``, and return
    ``(narrative_str, sidecar_paths, stats)``.  When ``event_emitter`` is
    supplied, also emits one ``legacy:detected`` framework event per
    captured section via the callback (#635 events behavioral wiring).
emit_legacy_report(project_root, captures)
    Write ``vbrief/migration/LEGACY-REPORT.md`` per #505 Section 6.
detect_prd_legacy(prd_content, canonical_specification_keys, *, source_name)
    PRD.md section-name diff (OQ3-b): sections whose normalized title does
    NOT match a canonical spec narrative key are captured with the
    hand-edit warning prefix.

Issue: #505, #506 D5.  Shared with #495 via ``_vbrief_fidelity``.
"""

from __future__ import annotations

import contextlib
import re
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# 6 KB inline threshold per #506 D5. Sections whose preserved text exceeds
# this limit overflow to ``vbrief/legacy/{stem}-{slug}.md``.
INLINE_THRESHOLD_BYTES: int = 6 * 1024

# Hand-edit warning prefix for PRD.md captured content (#505 Section 5).
PRD_HAND_EDIT_WARNING: str = (
    "> WARNING: PRD.md was edited manually in this project. PRD.md is "
    "framework-defined\n"
    "> as a rendered export from specification.vbrief.json. Manual edits "
    "here are\n"
    "> against framework guidance; review whether this content should be "
    "migrated\n"
    "> into a specification.vbrief.json narrative."
)


# ---------------------------------------------------------------------------
# Normalization (four rules per #506 D5)
# ---------------------------------------------------------------------------


def normalize_title(title: str) -> str:
    """Apply the four normalization rules from #506 D5 (+ CamelCase split).

    1. Case-insensitive (lowercase)
    2. Punctuation stripped (keep alphanumerics, spaces, hyphens, underscores)
    3. Word-separator tolerant (``-`` / ``_`` / CamelCase / space equivalent)
    4. Whitespace collapsed (runs of spaces -> single space; trim)

    CamelCase splitting is treated as a word-separator equivalence so
    ``ProblemStatement`` and ``Problem Statement`` both normalize to
    ``problem statement`` (see #495/#506 D5 comment thread: word-separator
    tolerance covers the prd_render.py no-space output).
    """
    raw = title or ""
    # Split CamelCase word boundaries BEFORE lowercasing so we can use
    # ``[A-Z]`` detection: ``ProblemStatement`` -> ``Problem Statement``.
    split = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", raw)
    low = split.lower().strip()
    low = re.sub(r"[^a-z0-9\s_\-]", " ", low)
    low = re.sub(r"[-_]+", " ", low)
    return re.sub(r"\s+", " ", low).strip()


# ---------------------------------------------------------------------------
# Known mappings (hard-coded v0.20 per #506 D5)
# ---------------------------------------------------------------------------

# Canonical narrative keys per #506 D3.
CANONICAL_SPEC_KEYS: tuple[str, ...] = (
    "Overview",
    "Architecture",
    "ProblemStatement",
    "Goals",
    "UserStories",
    "Requirements",
    "NonFunctionalRequirements",
    "SuccessMetrics",
    "TestingStrategy",
    "Deployment",
)

CANONICAL_PROJECT_KEYS: tuple[str, ...] = (
    "TechStack",
    "Strategy",
    "Quality",
    "ProjectRules",
    "Branching",
    "DeftVersion",
)

# specification.vbrief.json aliases. Keys are normalized per
# normalize_title(); values are canonical PascalCase narrative keys.
SPEC_KNOWN_MAPPINGS: dict[str, str] = {
    "overview": "Overview",
    "summary": "Overview",
    "architecture": "Architecture",
    "system design": "Architecture",
    "technical architecture": "Architecture",
    "problem statement": "ProblemStatement",
    "problem": "ProblemStatement",
    "background": "ProblemStatement",
    "goals": "Goals",
    "objectives": "Goals",
    "user stories": "UserStories",
    "use cases": "UserStories",
    "requirements": "Requirements",
    "functional requirements": "Requirements",
    "non functional requirements": "NonFunctionalRequirements",
    "nfrs": "NonFunctionalRequirements",
    "success metrics": "SuccessMetrics",
    "acceptance criteria": "SuccessMetrics",
    "acceptance criteria project level": "SuccessMetrics",
    "testing strategy": "TestingStrategy",
    "test plan": "TestingStrategy",
    "testing": "TestingStrategy",
    "deployment": "Deployment",
    "deployment plan": "Deployment",
}

# PROJECT-DEFINITION.vbrief.json aliases.
PROJECT_KNOWN_MAPPINGS: dict[str, str] = {
    "tech stack": "TechStack",
    "technology stack": "TechStack",
    "stack": "TechStack",
    "project configuration": "TechStack",
    "strategy": "Strategy",
    "quality": "Quality",
    "standards": "Quality",
    "quality standards": "Quality",
    "project specific rules": "ProjectRules",
    "project rules": "ProjectRules",
    "custom rules": "ProjectRules",
    "branching": "Branching",
    "branching strategy": "Branching",
    "git workflow": "Branching",
}


def lookup_canonical(title: str, mapping: dict[str, str]) -> str | None:
    """Return the canonical key for ``title`` or None if not a known alias."""
    return mapping.get(normalize_title(title))


# ---------------------------------------------------------------------------
# Section parsing (top-level ## only per #506 D5)
# ---------------------------------------------------------------------------


def parse_top_level_sections(
    content: str,
) -> list[tuple[str, str, int, int]]:
    """Split markdown at top-level ``## `` boundaries.

    Returns a list of ``(title, body, start_line, end_line)`` tuples where
    lines are 1-indexed.  Substructure (``###`` and below) is preserved
    verbatim inside each body -- the migrator MUST NOT attempt to re-parse
    it (per #506 D5 / #505 Section 2).

    Fenced code blocks are respected so that ``## ``-prefixed lines inside
    a fence are not misread as section boundaries.
    """
    if not content:
        return []

    lines = content.splitlines()
    sections: list[tuple[str, str, int, int]] = []
    in_fence = False
    current_title: str | None = None
    current_start = 0
    current_body: list[str] = []

    def _flush(end_line: int) -> None:
        if current_title is None:
            return
        body = "\n".join(current_body).rstrip()
        sections.append((current_title, body, current_start, end_line))

    for idx, line in enumerate(lines, start=1):
        stripped = line.lstrip()
        # Track fences so we don't misinterpret ## inside code blocks.
        if stripped.startswith("```"):
            in_fence = not in_fence
            if current_title is not None:
                current_body.append(line)
            continue

        if not in_fence:
            match = re.match(r"^##\s+(.+?)\s*$", line)
            if match:
                # Close previous section.
                _flush(idx - 1)
                current_title = match.group(1).strip()
                current_start = idx
                current_body = []
                continue

        if current_title is not None:
            current_body.append(line)

    # Flush trailing section.
    _flush(len(lines))
    return sections


def partition_sections(
    sections: list[tuple[str, str, int, int]],
    mapping: dict[str, str],
) -> tuple[dict[str, str], list[tuple[str, str, int, int]]]:
    """Split parsed sections into canonical vs legacy buckets.

    Returns ``(canonical, legacy)`` where ``canonical`` is a dict of
    ``canonical_key -> body`` and ``legacy`` is the list of unmatched
    ``(title, body, start, end)`` tuples in source order.

    When multiple aliases collapse onto the same canonical key, bodies are
    joined with a blank line so no content is lost.
    """
    canonical: dict[str, str] = {}
    legacy: list[tuple[str, str, int, int]] = []
    for title, body, start, end in sections:
        key = lookup_canonical(title, mapping)
        if key is None:
            legacy.append((title, body, start, end))
            continue
        if not body.strip():
            # Skip empty canonical sections (see existing
            # _parse_prd_narratives behaviour).
            continue
        if key in canonical:
            canonical[key] = canonical[key].rstrip() + "\n\n" + body.strip()
        else:
            canonical[key] = body.strip()
    return canonical, legacy


# ---------------------------------------------------------------------------
# LegacyArtifacts narrative construction + sidecar overflow
# ---------------------------------------------------------------------------


def _format_line_range(start: int, end: int) -> str:
    """Format a line-range for provenance headers."""
    if end <= start:
        return f"{start}"
    return f"{start}-{end}"


def emit_legacy_artifacts(
    legacy_sections: list[tuple[str, str, int, int]],
    source_file: str,
    project_root: Path,
    *,
    slugify_fn: Callable[[str], str],
    warning_prefix: str | None = None,
    event_emitter: Callable[[str, dict], None] | None = None,
    flagged: bool = False,
) -> tuple[str, list[Path], list[dict]]:
    """Build the LegacyArtifacts narrative for one vBRIEF file.

    ``source_file`` is the display name used in provenance headers (e.g.
    ``SPECIFICATION.md``).  The basename-without-extension (lowercased) is
    used as the sidecar ``{stem}`` (#506 D5 / #505 Section 4).

    ``slugify_fn`` converts section titles to lowercase-kebab-case
    filenames; Agent D's slug-safe ID generator (#498) is preferred once
    available, otherwise the repo's historic ``slugify`` works.

    ``warning_prefix`` optionally injects a warning block under each
    section header -- used for PRD.md hand-edit captures (#505 Section 5).

    ``event_emitter`` is an optional ``(event_name, payload)`` callback
    invoked once per captured section with ``event_name='legacy:detected'``
    and the per-section stat dict as payload (#635 behavioral events
    wiring).  Defaulting to ``None`` keeps the existing API surface
    bit-for-bit identical when callers do not opt in -- existing tests
    and consumers continue to behave exactly as before.

    ``flagged`` (default ``False``) marks every captured section's stat
    dict with ``"flagged": True`` BEFORE the event is emitted so the
    ``legacy:detected`` event payload accurately reflects the PRD.md
    hand-edit provenance contract documented in
    ``events/behavioral.yaml`` (Greptile #706 P1).  Callers that pass
    ``warning_prefix`` for PRD.md hand-edit captures SHOULD also pass
    ``flagged=True`` so the structural emission matches the warning
    prefix in the narrative.

    Returns ``(narrative_str, sidecar_paths, stats)`` where ``stats`` is a
    list of per-section dicts with keys: ``title``, ``source``, ``range``,
    ``size_bytes``, ``inline`` (bool), ``sidecar`` (str | None),
    ``flagged`` (bool, when ``flagged=True`` was passed),
    ``canonical_suggestion`` (str | None).
    """
    if not legacy_sections:
        return "", [], []

    stem = Path(source_file).stem.lower()
    legacy_dir = project_root / "vbrief" / "legacy"
    narrative_parts: list[str] = []
    sidecar_paths: list[Path] = []
    stats: list[dict] = []

    for title, body, start, end in legacy_sections:
        header = (
            f"### {title} (from {source_file}:"
            f"{_format_line_range(start, end)})"
        )
        body_stripped = body.strip()
        size = len(body_stripped.encode("utf-8"))
        if size > INLINE_THRESHOLD_BYTES:
            slug = slugify_fn(title) or slugify_fn(f"section-{start}")
            sidecar_name = f"{stem}-{slug}.md"
            sidecar = legacy_dir / sidecar_name
            legacy_dir.mkdir(parents=True, exist_ok=True)
            sidecar_content = (
                f"# {title}\n\n"
                f"> Captured from {source_file}:"
                f"{_format_line_range(start, end)} during "
                f"`task migrate:vbrief` (#505)\n\n"
                f"{body_stripped}\n"
            )
            sidecar.write_text(sidecar_content, encoding="utf-8")
            sidecar_paths.append(sidecar)
            pointer = (
                f"[Content exceeds inline threshold — "
                f"see vbrief/legacy/{sidecar_name}]"
            )
            section_block = f"{header}\n{pointer}"
            stats.append({
                "title": title,
                "source": source_file,
                "range": _format_line_range(start, end),
                "size_bytes": size,
                "inline": False,
                "sidecar": f"vbrief/legacy/{sidecar_name}",
            })
        else:
            if warning_prefix:
                section_block = (
                    f"{header}\n{warning_prefix}\n\n{body_stripped}"
                )
            else:
                section_block = f"{header}\n\n{body_stripped}"
            stats.append({
                "title": title,
                "source": source_file,
                "range": _format_line_range(start, end),
                "size_bytes": size,
                "inline": True,
                "sidecar": None,
            })
        # Apply the ``flagged`` annotation BEFORE emitting the event so
        # the ``legacy:detected`` payload contract documented in
        # ``events/behavioral.yaml`` is honoured for PRD.md hand-edit
        # captures (Greptile #706 P1). Previously the migrator patched
        # this field on the returned stats AFTER the function had
        # already emitted, leaving every PRD.md event missing the
        # ``flagged`` field.
        if flagged:
            stats[-1]["flagged"] = True
        narrative_parts.append(section_block)
        if event_emitter is not None:
            # Emit a structural ``legacy:detected`` framework event per
            # captured section (#635 behavioral events wiring).  Failures
            # in the emitter MUST NOT break the migrator -- legacy
            # capture is the primary contract here, the event stream is
            # an additive observability layer.
            with contextlib.suppress(Exception):
                event_emitter("legacy:detected", dict(stats[-1]))

    narrative = "\n\n".join(narrative_parts).rstrip() + "\n"
    return narrative, sidecar_paths, stats


# ---------------------------------------------------------------------------
# LEGACY-REPORT.md emission (#505 Section 6)
# ---------------------------------------------------------------------------


def _render_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    return f"{size_bytes / 1024:.1f} KB"


def emit_legacy_report(
    project_root: Path,
    captures: dict[str, list[dict]],
    *,
    migrator_version: str,
    sources: list[str],
    timestamp: str | None = None,
) -> Path | None:
    """Write ``vbrief/migration/LEGACY-REPORT.md``.

    ``captures`` keys are report section labels (e.g.
    ``"specification.vbrief.json -> LegacyArtifacts"``) mapping to the
    per-section stat dicts produced by :func:`emit_legacy_artifacts`.

    ``timestamp`` is an ISO-8601 ``YYYY-MM-DDTHH:MM:SSZ`` string; when
    ``None`` (default) the current UTC wall clock is used. Tests inject
    a frozen value so the golden fixture can diff byte-for-byte without
    a clock-freezing library (Greptile #525 P1).

    Returns the path to the written file, or ``None`` if there is
    nothing to report (all buckets empty).
    """
    if not any(captures.values()):
        return None

    report_dir = project_root / "vbrief" / "migration"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "LEGACY-REPORT.md"

    now = timestamp or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines: list[str] = [
        "# Legacy content captured during migration",
        "",
        f"Generated: {now}",
        f"Migrator version: {migrator_version}",
        f"Sources: {', '.join(sources)}",
        "",
    ]

    for label, items in captures.items():
        lines.append(f"## {label}")
        lines.append("")
        if not items:
            lines.append("(none)")
            lines.append("")
            continue
        for item in items:
            rng = item.get("range", "?")
            src = item.get("source", "?")
            title = item.get("title", "Untitled")
            inline = item.get("inline", True)
            size = _render_size(int(item.get("size_bytes", 0)))
            sidecar = item.get("sidecar")
            flagged = bool(item.get("flagged"))

            lines.append(f"### {title} ({src}:{rng})")
            disposition = "inline" if inline else f"sidecar: {sidecar}"
            lines.append(f"- Size: {size} ({disposition})")
            reason = item.get("reason") or (
                "No canonical narrative match; captured verbatim to preserve "
                "intent."
            )
            lines.append(f"- Reason: {reason}")
            lines.append(
                "- Suggested disposition: review during "
                "`deft-directive-sync` Phase 6c Legacy Artifact Review."
            )
            lines.append("- Action options:")
            lines.append("  - Keep as LegacyArtifacts (no action)")
            lines.append("  - Fold into an existing canonical narrative")
            lines.append("  - Drop (confirm nothing important is lost)")
            if flagged:
                lines.append(
                    "- Flag: PRD.md was hand-edited -- content does not "
                    "match any canonical specification narrative name."
                )
            lines.append("")

    report_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return report_path


# ---------------------------------------------------------------------------
# PRD.md section-name diff (OQ3-b per #505 Section 5)
# ---------------------------------------------------------------------------


def detect_prd_legacy(
    prd_content: str,
    canonical_keys_present: set[str],
    *,
    source_name: str = "PRD.md",
) -> list[tuple[str, str, int, int]]:
    """Return PRD.md sections that are not render output of canonical keys.

    Per #506 D5 / #505 Section 5 (OQ3-b): section-title diff only.  A
    section whose normalized title maps to a canonical spec narrative key
    that IS present in the post-migration spec vBRIEF is treated as
    expected render output and NOT captured.  Everything else is treated
    as hand-edited content and returned for legacy capture.

    ``canonical_keys_present`` is the set of canonical narrative keys that
    actually exist on the spec vBRIEF after migration (e.g.
    ``{"Overview", "Goals"}``) -- the caller computes this.
    """
    sections = parse_top_level_sections(prd_content or "")
    legacy: list[tuple[str, str, int, int]] = []
    for title, body, start, end in sections:
        canonical = lookup_canonical(title, SPEC_KNOWN_MAPPINGS)
        if canonical and canonical in canonical_keys_present:
            continue
        legacy.append((title, body, start, end))
    return legacy


# ---------------------------------------------------------------------------
# Stdout summary (#505 Section 8)
# ---------------------------------------------------------------------------


def summarize_captures(captures: dict[str, list[dict]]) -> list[str]:
    """Return stdout-summary lines for the end-of-run migrator output."""
    if not any(captures.values()):
        return []
    lines = ["", "LEGACY CONTENT CAPTURED:"]
    total_sidecars = 0
    for label, items in captures.items():
        inline_size = sum(
            int(i.get("size_bytes", 0)) for i in items if i.get("inline")
        )
        total_sidecars += sum(1 for i in items if not i.get("inline"))
        flagged = " (flagged: hand-edited)" if any(
            i.get("flagged") for i in items
        ) else ""
        lines.append(
            f"  {label}: {len(items)} section(s) "
            f"({_render_size(inline_size)} inline){flagged}"
        )
    lines.append(f"  Sidecar files: {total_sidecars}")
    lines.append("")
    lines.append(
        "  Full list and suggested dispositions: "
        "vbrief/migration/LEGACY-REPORT.md"
    )
    lines.append(
        "  Review with: `task sync` (or any session-start sync) -- "
        "agent will walk you through each item."
    )
    return lines


__all__ = [
    "CANONICAL_PROJECT_KEYS",
    "CANONICAL_SPEC_KEYS",
    "INLINE_THRESHOLD_BYTES",
    "PRD_HAND_EDIT_WARNING",
    "PROJECT_KNOWN_MAPPINGS",
    "SPEC_KNOWN_MAPPINGS",
    "detect_prd_legacy",
    "emit_legacy_artifacts",
    "emit_legacy_report",
    "lookup_canonical",
    "normalize_title",
    "parse_top_level_sections",
    "partition_sections",
    "summarize_captures",
]
