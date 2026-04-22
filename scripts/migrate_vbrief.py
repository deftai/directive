#!/usr/bin/env python3
"""
migrate_vbrief.py -- Migrate a Deft project to the vBRIEF-centric document model.

Converts existing SPECIFICATION.md + specification.vbrief.json + PROJECT.md +
ROADMAP.md into the new lifecycle folder structure defined by RFC #309.

Usage:
    uv run python scripts/migrate_vbrief.py [project_root]

    project_root -- path to the project root (default: current working directory)

Exit codes:
    0 -- migration completed successfully
    1 -- migration failed (errors printed to stderr)

Story: #312 (Phase 2 vBRIEF Architecture Cutover)
"""

from __future__ import annotations

import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

# Ensure the ``scripts/`` directory is on sys.path so sibling module
# ``_vbrief_build`` is importable whether this file is run as __main__ or
# imported from a test harness that appends the ``scripts/`` path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _vbrief_build import (
    create_scope_vbrief as _create_scope_vbrief_shared,  # noqa: E402
    slugify as _slugify_shared,  # noqa: E402
)
from _vbrief_validation import (  # noqa: E402
    finalize_migration,
    slug_fallback_id,
    slugify_id,
)

# Re-export slug-safe sanitiser under the migrator's underscore-prefixed
# convention so test harnesses and other migrator-adjacent tooling can import
# it from ``migrate_vbrief`` alongside the existing ``_slugify`` shim (#498).
_slugify_id = slugify_id
_slug_fallback_id = slug_fallback_id

# --- safety (Agent C, #497) ---
# Safety affordances for `task migrate:vbrief` live in `_vbrief_safety`:
# .premigrate.* backups, --dry-run preview, dirty-tree guard, --rollback.
# See `scripts/_vbrief_safety.py` and tracking issue #506 (D7) for the
# authoritative decisions this code implements.
# --- end safety ---
# --- reconciliation (Agent B, #496) ---
# Role-based SPEC/ROADMAP reconciliation per #506 D3 + overrides loader +
# RECONCILIATION.md emitter live in ``_vbrief_reconciliation``.
# --- end lifecycle-routing ---
# --- fidelity (Agent A, #495) ---
# Per-task body / FR-NFR definition parsing, Requirements narrative, plan.edges[]
# extraction, and the disambiguated ROUTE migration log live in
# ``_vbrief_fidelity``.  Per #506 D2 #14 body routing is reconciled by Agent B;
# this module FEEDS reconciliation by enriching spec_vbrief.plan.items with
# the narratives parsed from raw SPECIFICATION.md content.
from _vbrief_fidelity import (  # noqa: E402
    build_edges_from_tasks as _build_edges_from_tasks,
    build_requirements_narrative as _build_requirements_narrative,
    format_migration_log_entry as _format_migration_log_entry,
    ingest_spec_narratives as _ingest_spec_narratives,
    parse_requirement_definitions as _parse_requirement_definitions,
    parse_spec_tasks as _parse_spec_tasks,
    task_scope_narratives as _task_scope_narratives,
)

# --- legacy-artifacts (Agent A, #505) ---
# LegacyArtifacts narrative emission + 6KB sidecar overflow + LEGACY-REPORT.md
# + stdout summary live in ``_vbrief_legacy``.  The known-mappings list is
# shared with #495's canonical extraction path so both agree on what is
# canonical vs non-canonical (#506 D5).
from _vbrief_legacy import (  # noqa: E402
    CANONICAL_SPEC_KEYS as _CANONICAL_SPEC_KEYS,
    PRD_HAND_EDIT_WARNING as _PRD_HAND_EDIT_WARNING,
    PROJECT_KNOWN_MAPPINGS as _PROJECT_KNOWN_MAPPINGS,
    detect_prd_legacy as _detect_prd_legacy,
    emit_legacy_artifacts as _emit_legacy_artifacts,
    emit_legacy_report as _emit_legacy_report,
    parse_top_level_sections as _parse_top_level_sections,
    partition_sections as _partition_sections,
    summarize_captures as _summarize_captures,
)
from _vbrief_reconciliation import (  # noqa: E402
    load_overrides as _load_overrides,
    reconcile_scope_items as _reconcile_scope_items,
    write_reconciliation_report as _write_reconciliation_report,
)

# --- end reconciliation ---
# --- lifecycle-routing (Agent B, #499) ---
# Lifecycle folder <-> status mapping + scope vBRIEF builder per #506 shared
# conventions. Schema vocabulary only -- ``active/`` uses ``running``, NEVER
# ``in_progress`` (the critical #499 correction comment).
from _vbrief_routing import (  # noqa: E402
    build_scope_vbrief_from_reconciled as _build_reconciled_scope_vbrief,
)
from _vbrief_safety import (  # noqa: E402
    SafetyManifest,
    dirty_tree_refusal_message,
    is_tree_dirty,
    load_safety_manifest,
    now_utc_iso,
    plan_backups,
    rollback as safety_rollback,  # noqa: E402
    sha256_of,
    write_backups,
    write_safety_manifest,
)
from slug_normalize import (  # noqa: E402
    DEFAULT_MAX_LEN as _SLUG_MAX_LEN,
    disambiguate_slug as _disambiguate_slug,
    normalize_slug as _normalize_slug,
)

MIGRATOR_VERSION = "0.20.0"

# --- vbrief version (#533) ---
# Canonical ``vBRIEFInfo.version`` string the migrator emits on every file it
# writes. Bumped from ``"0.5"`` to ``"0.6"`` as part of the Agent 2 schema
# vendor transition (#533). During the transition the validator accepts both
# values; the migrator only emits the newer string.
EMITTED_VBRIEF_VERSION = "0.6"
# --- end vbrief version ---

# --- gitignore (#530) ---
# Canonical comment block + patterns appended to a consumer project's
# ``.gitignore`` by the migrator on its first run so ``.premigrate.*`` backup
# files do not leak into commits. Idempotent -- the migrator only appends
# patterns that are not already matched by an existing .gitignore rule.
_GITIGNORE_MARKER_LINE = (
    "# Migration backups (created by `task migrate:vbrief`) -- do NOT commit."
)
_GITIGNORE_COMMENT_BLOCK: tuple[str, ...] = (
    _GITIGNORE_MARKER_LINE,
    "# Post-commit, pre-migration state is recoverable via git history; see",
    "# deft/main.md \u00a7 Safety flags for the post-commit recovery path.",
)
_GITIGNORE_PATTERNS: tuple[str, ...] = (
    "*.premigrate.md",
    "*.premigrate.vbrief.json",
)
# --- end gitignore ---

# --- traces strip (#529) ---
# Regex matching a ``**Traces**: ...`` line inside a LegacyArtifacts task block.
# ``items[].subItems[].narrative.Traces`` is the single source of truth; the
# duplicated line inside ``LegacyArtifacts`` is stripped during migration to
# prevent downstream drift between the two copies. Applied with ``.match()``
# against each individual line in ``_strip_traces_from_narrative`` so the
# ``re.MULTILINE`` flag is not needed (Greptile #561 P2).
_TRACES_LINE_RE = re.compile(r"^\s*\*\*Traces\*\*\s*:.*$")
# Regex matching a LegacyArtifacts task header: e.g. ``### t2.1.2: ...`` or
# ``### t2.1.2 -- ...``. Used to attribute the stripped line to a task id for
# the RECONCILIATION.md audit trail. Applied with ``.match()`` against each
# individual line so ``re.MULTILINE`` is likewise unnecessary.
_TASK_HEADER_RE = re.compile(
    r"^###\s+(?P<task_id>[A-Za-z]?\d+(?:\.\d+)+)\b",
)
# Marker used to guard RECONCILIATION.md against duplicate Traces-stripped
# sections on migrator re-runs (Greptile #561 P2). Must match the section
# header emitted by :func:`_write_traces_stripped_note` exactly.
_TRACES_SECTION_HEADER = "## Traces lines stripped from LegacyArtifacts (#529)"
# --- end traces strip ---

# --- end fidelity + legacy-artifacts ---

# Lifecycle folders per RFC #309 D13
LIFECYCLE_FOLDERS = ("proposed", "pending", "active", "completed", "cancelled")

# Migrator-managed subdirectories under ``vbrief/`` that are created lazily by
# sidecar emission (``vbrief/legacy/``, #505) and reporting (``vbrief/migration/``)
# paths. Tracked in the safety manifest's ``created_dirs`` when the migrator
# creates them for the first time so ``--rollback`` can RMDIR them consistently
# with the lifecycle folders (issues #527, #528).
_MANAGED_SUBDIRS: tuple[str, ...] = ("legacy", "migration")

# Deprecation redirect sentinel per Story S (#334)
DEPRECATION_SENTINEL = "<!-- deft:deprecated-redirect -->"

# Known auto-generated markers for detecting user customization
_SPEC_AUTO_MARKERS = (
    "Generated by",
    "deft-setup skill",
    "spec_render.py",
)
_PROJECT_AUTO_MARKERS = (
    "Generated by",
    "deft-setup skill",
)

# Date for migration-created vBRIEF filenames (D7: creation date)
_TODAY = datetime.now(UTC).strftime("%Y-%m-%d")

# Mapping of markdown heading text (lowercased) to canonical narrative key names.
# Covers both CamelCase keys (from prd_render.py output) and space-separated
# forms (from hand-written PRDs/specs).  Keys must match prd_render.py.
_HEADING_TO_NARRATIVE_KEY: dict[str, str] = {
    "overview": "Overview",
    "problemstatement": "ProblemStatement",
    "problem statement": "ProblemStatement",
    "goals": "Goals",
    "userstories": "UserStories",
    "user stories": "UserStories",
    "requirements": "Requirements",
    "successmetrics": "SuccessMetrics",
    "success metrics": "SuccessMetrics",
    "architecture": "Architecture",
    "nonfunctionalrequirements": "NonFunctionalRequirements",
    "non-functional requirements": "NonFunctionalRequirements",
    "non functional requirements": "NonFunctionalRequirements",
    "openquestions": "OpenQuestions",
    "open questions": "OpenQuestions",
}


def _is_user_customized(content: str, auto_markers: tuple[str, ...]) -> bool:
    """Check if file content has been customized beyond auto-generated content.

    Returns True if the content does NOT contain any of the known auto-generation
    markers, suggesting the user has substantially rewritten the file.
    """
    return not any(marker in content for marker in auto_markers)


# Legacy underscore-prefixed alias -- extraction of the shared helper into
# ``_vbrief_build`` (#454) preserves the public surface tests import today.
_slugify = _slugify_shared


def _parse_prd_narratives(content: str) -> dict[str, str]:
    """Parse structured ## sections from PRD/SPECIFICATION markdown into narrative keys.

    Recognizes known PRD headings (both CamelCase and space-separated forms)
    and maps them to canonical narrative key names matching prd_render.py
    NARRATIVE_KEY_ORDER.

    Returns a dict of narrative_key -> section_body for recognized sections.
    """
    narratives: dict[str, str] = {}
    parts = re.split(r"^##\s+", content, flags=re.MULTILINE)

    for part in parts[1:]:  # skip preamble before first ##
        heading, _, body = part.partition("\n")
        heading = heading.strip()
        # Strip trailing auto-generated footer (--- followed by italicized note)
        body = re.sub(r"\n---\s*\n\*{1,2}[^*]+\*{1,2}\s*$", "", body)
        body = body.strip()

        if not body:
            continue

        key = _HEADING_TO_NARRATIVE_KEY.get(heading.lower())
        if key:
            narratives[key] = body

    return narratives


def _parse_roadmap_items(roadmap_path: Path) -> tuple[list[dict], dict[str, str], list[dict]]:
    """Parse ROADMAP.md and extract items as structured data.

    Returns a tuple of:
      - active items: list of dicts with keys: number, title, phase, tier.
      - phase_descriptions: dict mapping phase heading -> description text.
      - completed items: list of dicts with keys: number, title (from Completed section).
    """
    if not roadmap_path.exists():
        return [], {}, []

    content = roadmap_path.read_text(encoding="utf-8")
    items: list[dict] = []
    completed_items: list[dict] = []
    phase_descriptions: dict[str, str] = {}
    current_phase = ""
    current_tier = ""
    in_completed = False
    # Accumulate description lines between heading and first list item
    desc_lines: list[str] = []
    capturing_desc = False
    _synthetic_counter = 0

    for line in content.splitlines():
        # Detect phase headings (## Level)
        phase_match = re.match(r"^##\s+(.+)", line)
        if phase_match:
            # Save previous phase description
            if current_phase and desc_lines:
                phase_descriptions[current_phase] = "\n".join(desc_lines).strip()
            desc_lines = []

            current_phase = phase_match.group(1).strip()
            current_tier = ""
            if "completed" in current_phase.lower():
                in_completed = True
                capturing_desc = False
            else:
                in_completed = False
                capturing_desc = True
            continue

        # Detect tier subheadings (### Level)
        tier_match = re.match(r"^###\s+(.+)", line)
        if tier_match:
            if current_phase and desc_lines and capturing_desc:
                phase_descriptions[current_phase] = "\n".join(desc_lines).strip()
                desc_lines = []
                capturing_desc = False
            current_tier = tier_match.group(1).strip()
            continue

        # Accumulate phase description text (non-empty, non-list lines)
        if capturing_desc and not in_completed:
            stripped = line.strip()
            if stripped and not stripped.startswith("-"):
                desc_lines.append(stripped)
                continue
            if stripped.startswith("-"):
                # First list item ends description capture
                if desc_lines:
                    phase_descriptions[current_phase] = "\n".join(desc_lines).strip()
                    desc_lines = []
                capturing_desc = False
                # Fall through to item parsing below
            else:
                # Empty line during desc capture
                if desc_lines:
                    desc_lines.append("")
                continue

        if not current_phase:
            continue

        # --- Completed section items ---
        if in_completed:
            # Match: - ~~#NNN -- Title~~ or - ~~Title~~
            comp_match = re.match(r"^-\s+~~(?:#?(\d+)\s*--?\s*)?(.+?)~~", line)
            if comp_match:
                comp_number = comp_match.group(1) or ""
                comp_title = comp_match.group(2).strip()
                completed_items.append({
                    "number": comp_number,
                    "title": comp_title,
                    "phase": current_phase,
                })
            continue

        # --- Active section items ---
        # Match GitHub issue format: - **#NNN** -- Title
        item_match = re.match(r"^-\s+\*\*#(\d+)\*\*\s+--\s+(.+)", line)
        if item_match:
            items.append({
                "number": item_match.group(1),
                "title": item_match.group(2).strip(),
                "phase": current_phase,
                "tier": current_tier,
            })
            continue

        # Match task-based format: - **`X.Y.Z`** Title  or  - `X.Y.Z` Title
        task_match = re.match(
            r"^-\s+(?:\*\*)?`([^`]+)`(?:\*\*)?\s+(.+)", line
        )
        if task_match:
            task_id = task_match.group(1).strip()
            title = task_match.group(2).strip()
            items.append({
                "number": "",
                "title": title,
                "phase": current_phase,
                "tier": current_tier,
                "task_id": task_id,
            })
            continue

        # Generic fallback: - Title (any list item under a ## heading)
        generic_match = re.match(r"^-\s+(.+)", line)
        if generic_match:
            title = generic_match.group(1).strip()
            # Skip items that look like sub-bullets or empty
            if not title:
                continue
            _synthetic_counter += 1
            items.append({
                "number": "",
                "title": title,
                "phase": current_phase,
                "tier": current_tier,
                "synthetic_id": f"roadmap-{_synthetic_counter}",
            })
            continue

    # Save final phase description
    if current_phase and desc_lines and not in_completed:
        phase_descriptions[current_phase] = "\n".join(desc_lines).strip()

    return items, phase_descriptions, completed_items


def _resolve_repo_url(spec_vbrief: dict | None) -> str:
    """Resolve the GitHub repository URL from spec_vbrief or git remote.

    Falls back to a generic issue: prefix if no repository can be determined.
    """
    # Try spec_vbrief metadata first
    if spec_vbrief:
        repo = spec_vbrief.get("vBRIEFInfo", {}).get("repository", "")
        if repo:
            return f"https://github.com/{repo}"
        # Check references for a GitHub URL pattern
        refs = spec_vbrief.get("plan", {}).get("references", [])
        for ref in refs:
            uri = ref.get("uri", "")
            if urlparse(uri).netloc in ("github.com", "www.github.com"):
                # Extract owner/repo from URL
                parts = uri.split("github.com/")[-1].split("/")
                if len(parts) >= 2:
                    return f"https://github.com/{parts[0]}/{parts[1]}"
    return ""


def _extract_tech_stack(project_content: str) -> str:
    """Extract tech stack information from PROJECT.md content.

    Looks for common patterns:
      - **Tech Stack**: value
      - ## Tech Stack\n content
      - Tech Stack: value
    Returns extracted tech stack string, or empty string if not found.
    """
    # Pattern 1: **Tech Stack**: value (bold label on a single line)
    match = re.search(
        r"\*\*Tech\s+Stack\*\*\s*:\s*(.+)", project_content, re.IGNORECASE
    )
    if match:
        return match.group(1).strip()

    # Pattern 2: ## Tech Stack section (grab lines until next ## or EOF)
    section_match = re.search(
        r"##\s+Tech\s+Stack\s*\n(.*?)(?=\n##\s|\Z)",
        project_content,
        re.IGNORECASE | re.DOTALL,
    )
    if section_match:
        section = section_match.group(1).strip()
        if section:
            return section

    # Pattern 3: plain Tech Stack: value
    plain_match = re.search(
        r"Tech\s+Stack\s*:\s*(.+)", project_content, re.IGNORECASE
    )
    if plain_match:
        return plain_match.group(1).strip()

    return ""


def _first_prose_paragraph(content: str) -> str:
    """Return the first non-empty prose paragraph from markdown content.

    Skips fenced code blocks, blank lines, markdown heading lines, and list
    items; returns the first plain paragraph it finds.  Falls back to the
    first H1 (`# Title`) heading text if no prose paragraph exists.  Returns
    the empty string if nothing usable is found.
    """
    if not content:
        return ""
    first_h1 = ""
    in_code_block = False
    paragraph_lines: list[str] = []

    def _flush() -> str:
        if paragraph_lines:
            return " ".join(paragraph_lines).strip()
        return ""

    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        # First H1 title (# Title). Ignore H2/H3 etc.
        if re.match(r"^#\s+", stripped) and not first_h1:
            first_h1 = re.sub(r"^#\s+", "", stripped).strip()
            continue
        # Skip other headings -- also flush any accumulated paragraph first
        if stripped.startswith("#"):
            para = _flush()
            if para:
                return para
            paragraph_lines.clear()
            continue
        # List items (unordered and ordered), blockquotes, and tables are not
        # prose paragraphs for Overview purposes.  Ordered list detection uses
        # the standard markdown pattern "N.\s" at the line start.
        if stripped.startswith(("-", "*", ">", "|")) or re.match(r"^\d+\.\s", stripped):
            para = _flush()
            if para:
                return para
            paragraph_lines.clear()
            continue
        # Empty line ends paragraph
        if not stripped:
            para = _flush()
            if para:
                return para
            paragraph_lines.clear()
            continue
        paragraph_lines.append(stripped)

    # Final paragraph at EOF
    para = _flush()
    if para:
        return para
    # Fallback to H1 title text
    return first_h1


def _derive_overview_narrative(
    spec_vbrief: dict | None,
    spec_md_content: str | None,
    project_content: str | None,
    scope_item_count: int,
) -> str:
    """Derive an Overview narrative for PROJECT-DEFINITION.vbrief.json (#417).

    D3 requires the `Overview` narrative key (after case-folding) to be
    present on `vbrief/PROJECT-DEFINITION.vbrief.json`.  Resolution order:

    1. `spec_vbrief.plan.narratives['Overview']` if present and non-empty.
    2. First prose paragraph / H1 title of `SPECIFICATION.md` (pre-sentinel).
    3. First prose paragraph / H1 title of `PROJECT.md` (pre-sentinel).
    4. Synthesized placeholder naming the scope count, telling the user how
       to fill it in.  Always non-empty so `vbrief:validate` passes D3.
    """
    # 1. spec_vbrief narratives (set by step 2b PRD/SPEC ingestion, or by the
    # caller if there was a pre-existing specification.vbrief.json).
    if spec_vbrief:
        narratives = spec_vbrief.get("plan", {}).get("narratives", {})
        if isinstance(narratives, dict):
            ov = narratives.get("Overview")
            if isinstance(ov, str) and ov.strip():
                return ov.strip()

    # 2. SPECIFICATION.md prose / title -- but only if not already a sentinel
    # stub (would happen on re-run after migration).
    if spec_md_content and DEPRECATION_SENTINEL not in spec_md_content:
        derived = _first_prose_paragraph(spec_md_content)
        if derived:
            return derived

    # 3. PROJECT.md prose / title -- same sentinel guard.
    if project_content and DEPRECATION_SENTINEL not in project_content:
        derived = _first_prose_paragraph(project_content)
        if derived:
            return derived

    # 4. Synthesized fallback.  Always non-empty so the D3 validator passes.
    if scope_item_count > 0:
        return (
            f"Project overview was not auto-derived during migration. "
            f"{scope_item_count} scope item(s) were created in vbrief/pending/. "
            f"Update vbrief/PROJECT-DEFINITION.vbrief.json narratives['Overview'] "
            f"manually to describe your project."
        )
    return (
        "Project overview was not auto-derived during migration. "
        "Update vbrief/PROJECT-DEFINITION.vbrief.json narratives['Overview'] "
        "manually to describe your project."
    )


def _build_project_definition(
    spec_vbrief: dict | None,
    project_content: str | None,
    scope_items: list[dict],
    repo_url: str = "",
    spec_md_content: str | None = None,
) -> dict:
    """Build PROJECT-DEFINITION.vbrief.json from existing sources.

    Per RFC #309 D3:
    - narratives holds project identity (overview, tech stack, architecture, risks, config)
    - items acts as a scope registry referencing individual vBRIEF files

    ``spec_md_content`` is the raw SPECIFICATION.md text (pre-sentinel) for
    Overview-narrative derivation on canonical v0.19 consumer projects that
    have no pre-existing ``specification.vbrief.json`` (#417).

    Per #498: every ``plan.items[*].id`` is routed through
    :func:`_vbrief_validation.slugify_id` so the scope-registry id conforms
    to the schema-locked ID regex ``^[a-zA-Z0-9_-]+(\\.[a-zA-Z0-9_-]+)*$``
    and matches the slug used for the scope vBRIEF filename.
    """
    narratives: dict[str, str] = {}

    # Extract from specification.vbrief.json
    if spec_vbrief:
        plan = spec_vbrief.get("plan", {})
        if isinstance(plan, dict):
            spec_narratives = plan.get("narratives", {})
            if isinstance(spec_narratives, dict):
                for key, value in spec_narratives.items():
                    if isinstance(value, str):
                        narratives[key] = value

    # Extract from PROJECT.md
    if project_content:
        narratives["ProjectConfig"] = project_content
        # Extract tech stack into its own narrative key (D3 requirement)
        tech_stack = _extract_tech_stack(project_content)
        if tech_stack:
            narratives["tech stack"] = tech_stack

    # Ensure Overview narrative is present AND non-empty so the generated
    # PROJECT-DEFINITION passes `scripts/vbrief_validate.py::
    # validate_project_definition` D3 out of the box (#417).  Case-insensitive
    # check because D3 lowers() keys before comparing to
    # PROJECT_DEF_EXPECTED_NARRATIVES = {"overview", "tech stack"}.  The
    # value-awareness matters because a pre-existing specification.vbrief.json
    # may carry an empty / whitespace-only `Overview` -- without this check,
    # that blank value would round-trip into PROJECT-DEFINITION unchanged
    # (D3 only asserts key presence, so we surface a useful narrative instead).
    overview_key = next(
        (k for k in narratives if k.lower() == "overview"), None
    )
    overview_value = narratives.get(overview_key, "") if overview_key else ""
    if not isinstance(overview_value, str) or not overview_value.strip():
        derived = _derive_overview_narrative(
            spec_vbrief, spec_md_content, project_content, len(scope_items)
        )
        if derived:
            # Keep the existing key spelling (e.g. "overview" vs "Overview")
            # if one is present so we do not create a second key that differs
            # only in case.  Default to CamelCase "Overview" for new entries.
            narratives[overview_key or "Overview"] = derived

    # Per #498 D8 / validator D3: PROJECT_DEF_EXPECTED_NARRATIVES requires
    # `tech stack` (lowercase, space-separated) alongside `overview`. When
    # no PROJECT.md was present we never populated it above, which the
    # self-validation hook surfaces as a hard-block schema error. Synthesize
    # a placeholder -- the same pattern #417 established for Overview -- so
    # minimal fixtures round-trip cleanly and operators see a visible
    # "fill-me-in" hint rather than a silent regression.
    tech_stack_key = next((k for k in narratives if k.lower() == "tech stack"), None)
    tech_stack_value = narratives.get(tech_stack_key, "") if tech_stack_key else ""
    if not isinstance(tech_stack_value, str) or not tech_stack_value.strip():
        narratives[tech_stack_key or "tech stack"] = (
            "Tech stack was not auto-derived during migration. "
            "Update vbrief/PROJECT-DEFINITION.vbrief.json narratives['tech stack'] "
            "with your language, framework, and runtime versions."
        )

    items: list[dict] = []
    # Per #498: use slug-safe ids, disambiguating collisions within a single
    # registry build so every emitted id is unique and passes the schema's
    # ID regex out of the box.
    emitted_scope_ids: set[str] = set()
    for scope in scope_items:
        number = scope.get("number", "")
        id_source = slug_fallback_id(scope)
        scope_id = f"scope-{slugify_id(id_source, emitted_scope_ids)}"
        # #499-registry: registry status mirrors the scope's reconciled
        # status when the caller provides it (the migrator passes
        # reconciled items whose status already reflects the #506
        # lifecycle<->status mapping). Falls back to the phase-based
        # heuristic for unstructured callers (e.g. direct test callers
        # that pass raw ROADMAP items without reconciliation).
        scope_status = scope.get("status")
        if not isinstance(scope_status, str) or not scope_status:
            phase = str(scope.get("phase", "") or "")
            scope_status = (
                "completed" if "completed" in phase.lower() else "pending"
            )
        item: dict = {
            "id": scope_id,
            "title": scope.get("title", "Untitled"),
            "status": scope_status,
        }
        # Origin provenance per D11
        if number:
            ref: dict = {
                "type": "github-issue",
                "id": f"#{number}",
            }
            if repo_url:
                ref["url"] = f"{repo_url}/issues/{number}"
            item["references"] = [ref]
        items.append(item)

    return {
        "vBRIEFInfo": {
            "version": EMITTED_VBRIEF_VERSION,
            "description": "Project definition -- synthesized gestalt of the project.",
        },
        "plan": {
            "title": "PROJECT-DEFINITION",
            "status": "running",
            "narratives": narratives,
            "items": items,
        },
    }


# Legacy underscore-prefixed alias -- the shared helper lives in
# ``_vbrief_build`` (#454). Tests and callers continue to import
# ``_create_scope_vbrief`` from this module.
_create_scope_vbrief = _create_scope_vbrief_shared


def _deprecation_redirect(
    original_name: str,
    pointer_target: str,
    scope_note: str,
) -> str:
    """Generate deprecation redirect content for a replaced file."""
    return (
        f"{DEPRECATION_SENTINEL}\n"
        f"# {original_name} -- DEPRECATED\n"
        f"\n"
        f"This file has been replaced by the vBRIEF-centric document model.\n"
        f"\n"
        f"**See instead:**\n"
        f"- `{pointer_target}` -- project definition and scope registry\n"
        f"- `vbrief/pending/` -- individual scope vBRIEFs (backlog)\n"
        f"- `vbrief/active/` -- in-progress scope vBRIEFs\n"
        f"\n"
        f"{scope_note}\n"
        f"\n"
        f"Migrated on {_TODAY} by `task migrate:vbrief` (RFC #309, Story #312).\n"
    )


# --- gitignore helper (#530) ---
def _ensure_gitignore_patterns(
    project_root: Path, *, dry_run: bool
) -> str | None:
    """Append migration-backup gitignore patterns to ``.gitignore`` idempotently.

    Per issue #530 Option A: the migrator writes the two ``.premigrate.*``
    glob patterns under a comment block so the backups do not leak into
    commits on greenfield consumer projects. Idempotent -- checks whether
    each pattern is already present as a standalone rule before appending.
    If ``.gitignore`` is absent, it is created.

    Returns a human-readable log line describing the action taken (or
    ``None`` when no change was needed). ``dry_run`` short-circuits all
    filesystem writes but still returns a ``DRYRUN`` log line describing
    what would have happened.
    """
    gitignore = project_root / ".gitignore"
    existing: list[str]
    if gitignore.is_file():
        try:
            existing_text = gitignore.read_text(encoding="utf-8")
        except OSError:
            return None
        existing = existing_text.splitlines()
    else:
        existing_text = ""
        existing = []

    # A pattern is considered "present" if it appears verbatim on any
    # non-comment line. This matches git's own loose interpretation: a
    # project-level override that negates the pattern (``!*.premigrate.md``)
    # still counts as "gitignore is aware of it" for our purposes.
    existing_patterns = {
        line.strip()
        for line in existing
        if line.strip() and not line.strip().startswith("#")
    }
    missing = [p for p in _GITIGNORE_PATTERNS if p not in existing_patterns]
    if not missing:
        return None

    # Build the new block. When any patterns are missing we always include
    # the full comment block for the first append so operators see the
    # rationale. If the marker line is already present (partial prior
    # append), skip re-emitting the comment block and just append the
    # missing patterns under a short note.
    block_lines: list[str] = []
    if _GITIGNORE_MARKER_LINE in existing:
        block_lines.append(
            "# Additional migration backup patterns appended by "
            "`task migrate:vbrief`."
        )
    else:
        block_lines.extend(_GITIGNORE_COMMENT_BLOCK)
    block_lines.extend(missing)
    # Ensure the file ends with a newline before appending so we do not
    # merge our comment onto a previous pattern line.
    separator = ""
    if existing_text and not existing_text.endswith("\n"):
        separator = "\n"
    addition = separator + ("\n" if existing_text else "") + "\n".join(block_lines) + "\n"

    rel = ".gitignore"
    verb = "CREATE" if not gitignore.is_file() else "UPDATE"
    if dry_run:
        return (
            f"DRYRUN {verb} {rel} (append {len(missing)} migration-backup "
            f"pattern(s): {', '.join(missing)})"
        )
    new_text = existing_text + addition if existing_text else "\n".join(block_lines) + "\n"
    gitignore.write_text(new_text, encoding="utf-8")
    return (
        f"{verb} {rel} (append {len(missing)} migration-backup "
        f"pattern(s): {', '.join(missing)})"
    )
# --- end gitignore helper ---


# --- traces strip helpers (#529) ---
def _strip_traces_from_narrative(narrative: str) -> tuple[str, list[str]]:
    """Strip ``**Traces**: ...`` lines from a LegacyArtifacts narrative.

    ``plan.items[].subItems[].narrative.Traces`` is the single source of
    truth (see issue #529 for the 25/36 drift inventory). The duplicated
    ``**Traces**: ...`` line inside each LegacyArtifacts task block is
    stripped during migration so downstream tooling cannot pick a stale
    second copy.

    Returns ``(cleaned_narrative, stripped_task_ids)``. The cleaned
    narrative preserves every other line verbatim; stripped task ids are
    attributed to the preceding ``### tX.Y.Z`` header when available, or
    recorded as ``<unattributed>`` when a ``**Traces**:`` line appears
    outside any recognised task block.
    """
    if not narrative or "**Traces**" not in narrative:
        return narrative, []

    stripped_ids: list[str] = []
    lines = narrative.splitlines()
    current_task_id = ""
    cleaned: list[str] = []
    for line in lines:
        header_match = _TASK_HEADER_RE.match(line)
        if header_match:
            current_task_id = header_match.group("task_id")
        if _TRACES_LINE_RE.match(line):
            attribution = current_task_id or "<unattributed>"
            if attribution not in stripped_ids:
                stripped_ids.append(attribution)
            continue
        cleaned.append(line)
    # Preserve the trailing newline shape of the input (emit_legacy_artifacts
    # emits narratives terminated with ``\n``).
    trailing_newline = "\n" if narrative.endswith("\n") else ""
    return "\n".join(cleaned) + trailing_newline, stripped_ids


def _write_traces_stripped_note(
    project_root: Path,
    stripped_audit: list[dict],
    *,
    dry_run: bool,
) -> tuple[Path | None, str | None]:
    """Append a Traces-stripped section to ``vbrief/migration/RECONCILIATION.md``.

    Creates the file if it doesn't exist. Returns ``(path, log_line)``.
    ``log_line`` is ``None`` when ``stripped_audit`` is empty (nothing to
    emit). Called after :func:`_vbrief_reconciliation.write_reconciliation_report`
    so the Traces-stripped section follows any reconciliation conflicts
    already recorded in the same file.
    """
    if not stripped_audit:
        return None, None
    report_dir = project_root / "vbrief" / "migration"
    target = report_dir / "RECONCILIATION.md"
    total = sum(len(entry.get("task_ids", [])) for entry in stripped_audit)

    section_lines: list[str] = [
        "## Traces lines stripped from LegacyArtifacts (#529)",
        "",
        (
            "Per issue #529 the migrator strips duplicated ``**Traces**: ...`` "
            "lines from LegacyArtifacts task blocks so downstream tooling reads "
            "a single source of truth from ``plan.items[].subItems[].narrative.Traces``."
        ),
        "",
    ]
    for entry in stripped_audit:
        source = entry.get("source", "?")
        task_ids = entry.get("task_ids", []) or ["<none>"]
        section_lines.append(f"- `{source}`: {', '.join(task_ids)}")
    section_lines.append("")

    section = "\n".join(section_lines)
    rel = "vbrief/migration/RECONCILIATION.md"

    if dry_run:
        return None, (
            f"DRYRUN APPEND {rel} (Traces-stripped audit: {total} task(s))"
        )

    report_dir.mkdir(parents=True, exist_ok=True)
    if target.is_file():
        existing = target.read_text(encoding="utf-8")
        # Idempotency guard (Greptile #561 P2): re-running the migrator on
        # a project whose PROJECT.md / PRD.md still carries **Traces**:
        # lines would otherwise append a duplicate section on every pass.
        # Skip when the canonical section header is already present.
        if _TRACES_SECTION_HEADER in existing:
            return target, (
                f"SKIP   {rel} (Traces-stripped section already recorded)"
            )
        if not existing.endswith("\n"):
            existing += "\n"
        separator = "" if existing.endswith("\n\n") else "\n"
        target.write_text(existing + separator + section, encoding="utf-8")
        verb = "APPEND"
    else:
        header = (
            "# Migration reconciliation report\n"
            "\n"
            f"Generated: {now_utc_iso()}\n"
            "\n"
            "Per #496 / #529 this file records SPEC/ROADMAP reconciliation "
            "decisions and LegacyArtifacts traces-line stripping performed "
            "during `task migrate:vbrief`.\n"
            "\n"
        )
        target.write_text(header + section, encoding="utf-8")
        verb = "CREATE"
    return target, f"{verb} {rel} (Traces-stripped audit: {total} task(s))"
# --- end traces strip helpers ---


def _track_managed_subdir(
    project_root: Path,
    subdir_name: str,
    pre_existed: dict[str, bool],
    created_dirs: list[str],
) -> None:
    """Add ``vbrief/{subdir_name}`` to ``created_dirs`` if we created it (#527/#528).

    Uses ``pre_existed`` (captured at migration start) so the decision is
    derived from safety-manifest state, not from scanning the filesystem.
    A repeat call is a no-op, preserving idempotency for callers that may
    invoke this at multiple points in the migration flow.
    """
    rel = f"vbrief/{subdir_name}"
    if pre_existed.get(subdir_name):
        return
    if rel in created_dirs:
        return
    folder = project_root / "vbrief" / subdir_name
    if folder.is_dir():
        created_dirs.append(rel)


def migrate(
    project_root: Path,
    *,
    dry_run: bool = False,
    force: bool = False,
    strict: bool = False,
) -> tuple[bool, list[str]]:
    """Run the full migration on the given project root.

    ``dry_run`` -- when True, produce the full action log without writing any
    file to disk (#497-2).  All backup, manifest, and lifecycle-folder lines
    are prefixed ``DRYRUN`` so the operator can distinguish a plan from a
    real run.

    ``force`` -- when True, bypass the dirty-tree guard (#497-3).  The guard
    refuses to run on a dirty working tree by default to keep migration
    output separable from in-progress edits.

    ``strict`` -- when True (``task migrate:vbrief -- --strict`` per #496),
    exit non-zero if SPEC and ROADMAP disagreed on any dimension or any
    override from ``vbrief/migration-overrides.yaml`` triggered. Scope
    vBRIEFs and ``vbrief/migration/RECONCILIATION.md`` are still written so
    the operator can inspect before re-running without ``--strict``.

    Returns:
        (True, actions) on success -- actions is a list of human-readable lines.
        (False, errors) on failure.
    """
    actions: list[str] = []
    warnings: list[str] = []
    vbrief_dir = project_root / "vbrief"
    created_files: list[str] = []
    created_dirs: list[str] = []

    # #527 / #528: snapshot which migrator-managed subdirs pre-existed so we
    # can record any we create in the safety manifest's ``created_dirs``.
    # Tracking is derived from this captured state -- NOT from post-hoc
    # filesystem scans -- so rollback's RMDIR decision comes straight from
    # the manifest and never clobbers a directory that was already present.
    managed_subdir_pre_existed: dict[str, bool] = {
        name: (vbrief_dir / name).is_dir() for name in _MANAGED_SUBDIRS
    }

    # --- safety (Agent C, #497) ---
    # Dirty-tree guard (#497-3): refuse on a non-clean git status unless the
    # operator passes --force.  Runs BEFORE any filesystem mutation so a
    # dirty-tree refusal leaves the project in its exact pre-run state.
    # --dry-run is explicitly exempt (Greptile #509 P1): dry-run is read-only,
    # cannot corrupt state, and operators are encouraged to preview BEFORE
    # committing any pending edits. Pairing --force with --dry-run to preview
    # on an unfamiliar project would defeat the purpose of dry-run.
    if not force and not dry_run and is_tree_dirty(project_root):
        return False, [dirty_tree_refusal_message()]

    # Always-on backups (#497-1): copy every pre-cutover input to its
    # .premigrate.* sibling BEFORE we touch anything else (the lifecycle
    # folder creation below is technically the first filesystem write, but
    # backups come first so we can surface an actionable error if a backup
    # itself fails before any write lands).
    backup_pairs = plan_backups(project_root)
    backup_records, backup_actions = write_backups(
        project_root, backup_pairs, dry_run=dry_run
    )
    actions.extend(backup_actions)
    # --- end safety ---

    # --- gitignore (#530) ---
    # Append the ``.premigrate.*`` glob patterns to the consumer project's
    # ``.gitignore`` on first migration so backups never leak into commits.
    # Idempotent on subsequent runs.
    gitignore_action = _ensure_gitignore_patterns(project_root, dry_run=dry_run)
    if gitignore_action:
        actions.append(gitignore_action)
    # --- end gitignore ---

    # ---- Step 1: Create lifecycle folders ----
    for folder_name in LIFECYCLE_FOLDERS:
        folder = vbrief_dir / folder_name
        rel = folder.relative_to(project_root).as_posix()
        if folder.exists():
            actions.append(f"SKIP  lifecycle folder already exists: vbrief/{folder_name}/")
        elif dry_run:
            actions.append(f"DRYRUN CREATE lifecycle folder: vbrief/{folder_name}/")
        else:
            folder.mkdir(parents=True, exist_ok=True)
            created_dirs.append(rel)
            actions.append(f"CREATE lifecycle folder: vbrief/{folder_name}/")

    # ---- Step 2: Read existing sources ----
    spec_vbrief_path = vbrief_dir / "specification.vbrief.json"
    spec_vbrief: dict | None = None
    if spec_vbrief_path.exists():
        try:
            spec_vbrief = json.loads(spec_vbrief_path.read_text(encoding="utf-8"))
            actions.append("READ  vbrief/specification.vbrief.json")
        except json.JSONDecodeError as exc:
            return False, [f"ERROR: invalid JSON in specification.vbrief.json: {exc}"]
    else:
        actions.append("SKIP  vbrief/specification.vbrief.json not found")

    spec_md_path = project_root / "SPECIFICATION.md"
    spec_md_content: str | None = None
    if spec_md_path.exists():
        spec_md_content = spec_md_path.read_text(encoding="utf-8")
        actions.append("READ  SPECIFICATION.md")

    project_md_path = project_root / "PROJECT.md"
    project_content: str | None = None
    if project_md_path.exists():
        project_content = project_md_path.read_text(encoding="utf-8")
        actions.append("READ  PROJECT.md")

    roadmap_path = project_root / "ROADMAP.md"
    roadmap_items, phase_descriptions, completed_items = _parse_roadmap_items(roadmap_path)
    total_items = len(roadmap_items) + len(completed_items)
    if total_items:
        actions.append(
            f"READ  ROADMAP.md ({len(roadmap_items)} active, "
            f"{len(completed_items)} completed items parsed)"
        )
    else:
        actions.append("SKIP  ROADMAP.md not found or no items parsed")

    # Resolve repository URL for provenance references
    repo_url = _resolve_repo_url(spec_vbrief)

    # ---- Step 2b: Ingest PRD/SPECIFICATION structured narratives (#397) ----
    prd_path = project_root / "PRD.md"
    ingested_narratives: dict[str, str] = {}

    if prd_path.exists():
        prd_content = prd_path.read_text(encoding="utf-8")
        actions.append("READ  PRD.md")
        ingested_narratives.update(_parse_prd_narratives(prd_content))

    if spec_md_content and DEPRECATION_SENTINEL not in spec_md_content:
        spec_parsed = _parse_prd_narratives(spec_md_content)
        # SPECIFICATION.md sections take priority over PRD.md for overlaps
        ingested_narratives.update(spec_parsed)

    if ingested_narratives:
        # Ensure spec_vbrief structure exists
        if spec_vbrief is None:
            spec_vbrief = {
                "vBRIEFInfo": {
                    "version": EMITTED_VBRIEF_VERSION,
                    "description": "Specification",
                },
                "plan": {
                    "title": "Specification",
                    "status": "approved",
                    "narratives": {},
                    "items": [],
                },
            }

        existing = spec_vbrief.setdefault("plan", {}).setdefault("narratives", {})
        ingested_keys: list[str] = []
        for key, value in ingested_narratives.items():
            if key not in existing:
                existing[key] = value
                ingested_keys.append(key)

        if ingested_keys:
            rel = spec_vbrief_path.relative_to(project_root).as_posix()
            created_new_spec_vbrief = not spec_vbrief_path.exists()
            if dry_run:
                actions.append(
                    f"DRYRUN INGEST narratives into specification.vbrief.json: "
                    f"{', '.join(sorted(ingested_keys))}"
                )
            else:
                spec_vbrief_path.parent.mkdir(parents=True, exist_ok=True)
                spec_vbrief_path.write_text(
                    json.dumps(spec_vbrief, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8",
                )
                if created_new_spec_vbrief:
                    created_files.append(rel)
                actions.append(
                    f"INGEST narratives into specification.vbrief.json: "
                    f"{', '.join(sorted(ingested_keys))}"
                )

    # --- fidelity (Agent A, #495) ---
    # Parse the raw SPECIFICATION.md for per-task bodies (Description /
    # DependsOn / AcceptanceCriteria / Traces) + FR-N / NFR-N definitions
    # + non-canonical ## sections.  Enrich spec_vbrief.plan.items so Agent
    # B's reconciliation picks up the bodies through its "spec owns body"
    # path (#506 D2 #14).  Emit the Requirements narrative (#495-4) and
    # plan.edges[] (#495-6, #506 D4) on the spec vBRIEF.  Collect legacy
    # SPEC sections for #505 capture at the end of the run.
    spec_tasks: list[dict] = []
    requirement_defs: dict[str, str] = {}
    spec_legacy_sections: list[tuple[str, str, int, int]] = []
    fidelity_log: list[dict] = []
    if spec_md_content and DEPRECATION_SENTINEL not in spec_md_content:
        spec_tasks = _parse_spec_tasks(spec_md_content)
        requirement_defs = _parse_requirement_definitions(spec_md_content)
        _canon, fidelity_log, spec_legacy_sections = _ingest_spec_narratives(
            spec_md_content, source_file="SPECIFICATION.md"
        )
        if spec_vbrief is None:
            spec_vbrief = {
                "vBRIEFInfo": {
                    "version": EMITTED_VBRIEF_VERSION,
                    "description": "Specification",
                },
                "plan": {
                    "title": "Specification",
                    "status": "approved",
                    "narratives": {},
                    "items": [],
                },
            }
        spec_plan = spec_vbrief.setdefault("plan", {})
        spec_narratives = spec_plan.setdefault("narratives", {})

        # Requirements narrative (#495-4): FR/NFR defs emitted as a single
        # string. Preserve any pre-existing narrative.
        req_narrative = _build_requirements_narrative(requirement_defs)
        if req_narrative and not spec_narratives.get("Requirements"):
            spec_narratives["Requirements"] = req_narrative
            actions.append(
                "FIDELITY specification.vbrief.json Requirements: "
                f"{len(requirement_defs)} FR/NFR definition(s)"
            )

        # plan.edges[] from per-task Depends-on (#495-6, D4).
        edges = _build_edges_from_tasks(spec_tasks)
        if edges:
            existing_edges = spec_plan.get("edges", [])
            if not isinstance(existing_edges, list):
                existing_edges = []
            seen_keys = {
                (str(e.get("from", "")), str(e.get("to", "")),
                 str(e.get("type", "")))
                for e in existing_edges if isinstance(e, dict)
            }
            new_count = 0
            for edge in edges:
                key = (edge["from"], edge["to"], edge["type"])
                if key not in seen_keys:
                    existing_edges.append(edge)
                    seen_keys.add(key)
                    new_count += 1
            if new_count:
                spec_plan["edges"] = existing_edges
                actions.append(
                    f"FIDELITY specification.vbrief.json plan.edges[]: "
                    f"{new_count} Depends-on edge(s) emitted (#506 D4)"
                )

        # Enrich spec_vbrief.plan.items with per-task narratives so B's
        # reconciliation picks up Description / DependsOn / AcceptanceCriteria
        # / Traces from SPEC.md bodies (#495-1). Match by task_id; when no
        # matching item exists, synthesize a new item so the body is not lost.
        spec_items = spec_plan.setdefault("items", [])
        if not isinstance(spec_items, list):
            spec_items = []
            spec_plan["items"] = spec_items

        def _find_spec_item(task_id: str) -> dict | None:
            for item in spec_items:
                if isinstance(item, dict) and str(item.get("id", "")) == task_id:
                    return item
            return None

        enriched_count = 0
        for task in spec_tasks:
            task_id = task.get("task_id", "")
            if not task_id:
                continue
            task_narr = _task_scope_narratives(task)
            if not task_narr:
                continue
            item = _find_spec_item(task_id)
            if item is None:
                item = {
                    "id": task_id,
                    "title": task.get("title", task_id),
                    "status": task.get("status", "pending"),
                    "narrative": {},
                }
                spec_items.append(item)
            narrative = item.setdefault("narrative", {})
            if not isinstance(narrative, dict):
                narrative = {}
                item["narrative"] = narrative
            for key, value in task_narr.items():
                if not narrative.get(key):
                    narrative[key] = value
                    enriched_count += 1

        if enriched_count:
            actions.append(
                f"FIDELITY specification.vbrief.json items enriched: "
                f"{enriched_count} per-task narrative field(s) (#495-1)"
            )

        # Persist the enriched spec vBRIEF so Agent B's reconciliation
        # reads the enriched state.  Skipped under --dry-run.
        if not dry_run and (req_narrative or edges or enriched_count):
            rel_spec = spec_vbrief_path.relative_to(project_root).as_posix()
            created_new = not spec_vbrief_path.exists()
            spec_vbrief_path.parent.mkdir(parents=True, exist_ok=True)
            spec_vbrief_path.write_text(
                json.dumps(spec_vbrief, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            if created_new and rel_spec not in created_files:
                created_files.append(rel_spec)

    # Disambiguated migration log (#495-15): every section routing decision
    # gets a ROUTE line recording source : line-range -> target-key -> target-file.
    for entry in fidelity_log:
        actions.append(_format_migration_log_entry(entry))
    # --- end fidelity ---

    # --- reconciliation (Agent B, #496) ---
    # Load overrides BEFORE defaults apply, then reconcile SPEC + ROADMAP
    # into a single list of routed scope items. The report captures every
    # resolved disagreement for downstream emission to
    # vbrief/migration/RECONCILIATION.md and for --strict exit-code gating.
    overrides = _load_overrides(vbrief_dir)
    if overrides:
        actions.append(
            f"READ  vbrief/migration-overrides.yaml ({len(overrides)} override(s))"
        )
    reconciled_items, reconciliation_report = _reconcile_scope_items(
        roadmap_active=roadmap_items,
        roadmap_completed=completed_items,
        spec_vbrief=spec_vbrief,
        phase_descriptions=phase_descriptions,
        overrides=overrides,
    )
    # --- end reconciliation ---

    # ---- Step 3: Generate PROJECT-DEFINITION.vbrief.json ----
    proj_def_path = vbrief_dir / "PROJECT-DEFINITION.vbrief.json"
    if proj_def_path.exists():
        actions.append("SKIP  PROJECT-DEFINITION.vbrief.json already exists (idempotent)")
    else:
        # #499-registry: pass reconciled items so PROJECT-DEFINITION
        # plan.items[*].status mirrors each scope's reconciled status. Falls
        # back to raw roadmap_items + completed_items for the degenerate
        # case where no ROADMAP existed (reconciled_items is empty and the
        # registry was historically empty too).
        if reconciled_items:
            registry_items = [
                {
                    "number": r.get("number", ""),
                    "title": r.get("title", "Untitled"),
                    "status": r.get("status", "pending"),
                    "phase": r.get("phase", ""),
                    "task_id": r.get("original_task_id", ""),
                    "synthetic_id": r.get("synthetic_id", ""),
                }
                for r in reconciled_items
            ]
        else:
            registry_items = roadmap_items + completed_items
        proj_def = _build_project_definition(
            spec_vbrief,
            project_content,
            registry_items,
            repo_url=repo_url,
            spec_md_content=spec_md_content,
        )
        if dry_run:
            actions.append("DRYRUN CREATE vbrief/PROJECT-DEFINITION.vbrief.json")
        else:
            proj_def_path.write_text(
                json.dumps(proj_def, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            created_files.append(
                proj_def_path.relative_to(project_root).as_posix()
            )
            actions.append("CREATE vbrief/PROJECT-DEFINITION.vbrief.json")

    # --- lifecycle-routing (Agent B, #499) ---
    # Write each reconciled scope vBRIEF to the lifecycle folder chosen by
    # the reconciler (proposed / pending / active / completed / cancelled
    # per #506). Replaces the old Steps 4 + 4b that dumped everything into
    # pending/ or completed/. Orphan ROADMAP items route to proposed/ with
    # narrative.SourceConflict = "missing-from-spec".
    #
    # #532: filename stem uses ``slug_normalize.normalize_slug`` (Unicode
    # NFKD, checkbox markers stripped, word-boundary truncation at 60 chars,
    # Windows-reserved fallback). The id prefix is still emitted via
    # ``slugify_id`` (#498) because it is ALSO used as an in-JSON
    # ``plan.items[*].id`` value that must match the schema ID regex.
    emitted_stems: set[str] = set()
    for reconciled in reconciled_items:
        folder = reconciled.get("folder", "pending")
        number = reconciled.get("number", "")
        id_source = slug_fallback_id({
            "number": number,
            "task_id": reconciled.get("original_task_id", ""),
            "synthetic_id": reconciled.get("synthetic_id", ""),
            "title": reconciled.get("title", "untitled"),
        })
        id_part = slugify_id(id_source)
        # Compose id + raw title then normalize as a single unit so the
        # word-boundary truncation rule considers the full composed stem.
        raw_title = reconciled.get("title", "untitled") or "untitled"
        composed_raw = f"{id_part}-{raw_title}" if id_part else raw_title
        normalized_stem = _normalize_slug(composed_raw, max_len=_SLUG_MAX_LEN)
        stem = _disambiguate_slug(
            normalized_stem, emitted_stems, max_len=_SLUG_MAX_LEN
        )
        emitted_stems.add(stem)
        # Kept for the human-readable ``label`` fallback below.
        title_slug = _normalize_slug(
            reconciled.get("title", "untitled") or "untitled",
            max_len=_SLUG_MAX_LEN,
        )
        filename = f"{_TODAY}-{stem}.vbrief.json"
        target_folder = vbrief_dir / folder
        if not target_folder.exists() and not dry_run:
            target_folder.mkdir(parents=True, exist_ok=True)
        target_path = target_folder / filename

        if target_path.exists():
            actions.append(
                f"SKIP  {folder}/{filename} already exists (idempotent)"
            )
            continue

        # Check if any existing file references this issue number
        if number:
            existing = _find_existing_scope_vbrief(vbrief_dir, number)
            if existing:
                actions.append(
                    f"SKIP  #{number} already has scope vBRIEF: "
                    f"{existing.relative_to(vbrief_dir)}"
                )
                continue

        scope_vbrief = _build_reconciled_scope_vbrief(
            reconciled, repo_url=repo_url
        )
        label = (
            f"#{number}" if number
            else reconciled.get("task_id") or title_slug
        )
        if dry_run:
            actions.append(f"DRYRUN CREATE {folder}/{filename} ({label})")
        else:
            target_path.write_text(
                json.dumps(scope_vbrief, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            created_files.append(
                target_path.relative_to(project_root).as_posix()
            )
            actions.append(f"CREATE {folder}/{filename} ({label})")
    # --- end lifecycle-routing ---

    # ---- Step 5: Deprecation redirects ----
    # Hashes captured after write (or proposed-write in dry-run) so --rollback
    # can detect whether the operator has edited the stub since migration.
    stub_hashes: dict[str, str] = {}
    if spec_md_path.exists():
        if spec_md_content and DEPRECATION_SENTINEL in spec_md_content:
            actions.append("SKIP  SPECIFICATION.md already has deprecation redirect")
        else:
            # Check for user customization
            if spec_md_content and _is_user_customized(spec_md_content, _SPEC_AUTO_MARKERS):
                # In dry-run the fold target (PROJECT-DEFINITION) may not yet
                # exist -- _fold_custom_content short-circuits gracefully and
                # returns False, which would otherwise abort.  Skip the abort
                # path in dry-run and record the fold as proposed.
                if dry_run:
                    warnings.append(
                        "WARNING: SPECIFICATION.md appears user-customized. "
                        "Original content would be preserved in "
                        "PROJECT-DEFINITION.vbrief.json narratives (dry-run)."
                    )
                else:
                    preserved = _fold_custom_content(
                        proj_def_path, "SpecificationContent", spec_md_content or ""
                    )
                    if preserved:
                        warnings.append(
                            "WARNING: SPECIFICATION.md appears user-customized. "
                            "Original content preserved in "
                            "PROJECT-DEFINITION.vbrief.json narratives."
                        )
                    else:
                        return False, [
                            "ERROR: SPECIFICATION.md appears user-customized but content could not "
                            "be preserved in PROJECT-DEFINITION.vbrief.json. Fix the project "
                            "definition file structure and re-run to prevent data loss."
                        ]

            redirect = _deprecation_redirect(
                "SPECIFICATION.md",
                "vbrief/PROJECT-DEFINITION.vbrief.json",
                "For scope details, see individual vBRIEF files in the lifecycle folders.",
            )
            if dry_run:
                actions.append("DRYRUN REPLACE SPECIFICATION.md with deprecation redirect")
            else:
                spec_md_path.write_text(redirect, encoding="utf-8")
                stub_hashes["SPECIFICATION.md"] = sha256_of(spec_md_path)
                actions.append("REPLACE SPECIFICATION.md with deprecation redirect")

    if project_md_path.exists():
        if project_content and DEPRECATION_SENTINEL in project_content:
            actions.append("SKIP  PROJECT.md already has deprecation redirect")
        else:
            # Check for user customization -- note: PROJECT.md content is already
            # captured in narratives["ProjectConfig"] by _build_project_definition (step 3),
            # so the fold here is a safety net only.
            if project_content and _is_user_customized(project_content, _PROJECT_AUTO_MARKERS):
                warnings.append(
                    "WARNING: PROJECT.md appears user-customized. "
                    "Original content preserved in PROJECT-DEFINITION.vbrief.json narratives."
                )

            redirect = _deprecation_redirect(
                "PROJECT.md",
                "vbrief/PROJECT-DEFINITION.vbrief.json",
                "For project configuration, see the narratives section.",
            )
            if dry_run:
                actions.append("DRYRUN REPLACE PROJECT.md with deprecation redirect")
            else:
                project_md_path.write_text(redirect, encoding="utf-8")
                stub_hashes["PROJECT.md"] = sha256_of(project_md_path)
                actions.append("REPLACE PROJECT.md with deprecation redirect")

    # --- legacy-artifacts (Agent A, #505) ---
    # Capture non-canonical ## sections from SPECIFICATION.md, PROJECT.md,
    # and PRD.md into a ``LegacyArtifacts`` narrative on the matching
    # vBRIEF file (per #506 D5 / #505 Section 1).  Sections >6 KB overflow
    # to ``vbrief/legacy/{stem}-{slug}.md`` sidecars (Section 4).  PRD.md
    # hand-edited sections get the RFC-defined warning prefix (Section 5).
    # Emit ``vbrief/migration/LEGACY-REPORT.md`` when any capture occurs
    # (Section 6) and append a stdout summary (Section 8).
    #
    # Skipped under --dry-run so operators can preview the plan without
    # synthesising sidecar files. The .premigrate.* backups (Agent C)
    # cover rollback; LegacyArtifacts is an additive preservation mechanism.
    captures: dict[str, list[dict]] = {
        "specification.vbrief.json -> LegacyArtifacts": [],
        "PROJECT-DEFINITION.vbrief.json -> LegacyArtifacts": [],
        "PRD.md content (flagged: hand-edited)": [],
    }
    # #529: collect per-source Traces-stripping audit entries. Each entry
    # records the source file name and the list of task ids whose
    # ``**Traces**: ...`` line was stripped from the emitted LegacyArtifacts
    # narrative. The audit is emitted to ``vbrief/migration/RECONCILIATION.md``
    # after reconciliation writes its own conflicts.
    traces_stripped_audit: list[dict] = []
    if not dry_run:
        # SPEC.md legacy sections were collected by the fidelity hook above.
        if spec_legacy_sections:
            narrative, sidecars, stats = _emit_legacy_artifacts(
                spec_legacy_sections,
                "SPECIFICATION.md",
                project_root,
                slugify_fn=_slugify_shared,
            )
            if narrative:
                narrative, stripped_ids = _strip_traces_from_narrative(narrative)
                if stripped_ids:
                    traces_stripped_audit.append({
                        "source": "SPECIFICATION.md",
                        "task_ids": stripped_ids,
                    })
                if not spec_vbrief_path.exists():
                    # Nothing has written spec.vbrief.json yet (e.g. SPEC is
                    # 100% non-canonical) -- synthesize a minimal skeleton
                    # so LegacyArtifacts has a target file.
                    spec_vbrief_path.parent.mkdir(parents=True, exist_ok=True)
                    spec_vbrief_path.write_text(
                        json.dumps(
                            {
                                "vBRIEFInfo": {
                                    "version": EMITTED_VBRIEF_VERSION,
                                    "description": "Specification",
                                },
                                "plan": {
                                    "title": "Specification",
                                    "status": "approved",
                                    "narratives": {},
                                    "items": [],
                                },
                            },
                            indent=2,
                            ensure_ascii=False,
                        )
                        + "\n",
                        encoding="utf-8",
                    )
                    created_files.append(
                        spec_vbrief_path.relative_to(project_root).as_posix()
                    )
                _attach_legacy_narrative(spec_vbrief_path, narrative)
                for sidecar in sidecars:
                    try:
                        rel = sidecar.relative_to(project_root).as_posix()
                    except ValueError:
                        rel = str(sidecar)
                    if rel not in created_files:
                        created_files.append(rel)
                captures[
                    "specification.vbrief.json -> LegacyArtifacts"
                ].extend(stats)
                actions.append(
                    "LEGACY specification.vbrief.json LegacyArtifacts: "
                    f"{len(stats)} section(s)"
                )

        # PROJECT.md non-canonical sections -> PROJECT-DEFINITION.vbrief.json.
        if project_content and DEPRECATION_SENTINEL not in project_content:
            project_sections = _parse_top_level_sections(project_content)
            _project_canonical, project_legacy = _partition_sections(
                project_sections, _PROJECT_KNOWN_MAPPINGS
            )
            if project_legacy:
                narrative, sidecars, stats = _emit_legacy_artifacts(
                    project_legacy,
                    "PROJECT.md",
                    project_root,
                    slugify_fn=_slugify_shared,
                )
                if narrative and proj_def_path.exists():
                    narrative, stripped_ids = _strip_traces_from_narrative(
                        narrative
                    )
                    if stripped_ids:
                        traces_stripped_audit.append({
                            "source": "PROJECT.md",
                            "task_ids": stripped_ids,
                        })
                    _attach_legacy_narrative(proj_def_path, narrative)
                    for sidecar in sidecars:
                        try:
                            rel = sidecar.relative_to(project_root).as_posix()
                        except ValueError:
                            rel = str(sidecar)
                        if rel not in created_files:
                            created_files.append(rel)
                    captures[
                        "PROJECT-DEFINITION.vbrief.json -> LegacyArtifacts"
                    ].extend(stats)
                    actions.append(
                        "LEGACY PROJECT-DEFINITION.vbrief.json LegacyArtifacts: "
                        f"{len(stats)} section(s)"
                    )

        # PRD.md section-name diff (OQ3-b, #505 Section 5). Hand-edited
        # sections whose normalised title is NOT a canonical spec narrative
        # key on the post-migration spec vBRIEF get captured with the
        # warning prefix.
        if prd_path.exists():
            prd_content = prd_path.read_text(encoding="utf-8")
            canonical_present = _canonical_spec_keys_in(spec_vbrief_path)
            prd_legacy = _detect_prd_legacy(
                prd_content, canonical_present, source_name="PRD.md"
            )
            if prd_legacy:
                narrative, sidecars, stats = _emit_legacy_artifacts(
                    prd_legacy,
                    "PRD.md",
                    project_root,
                    slugify_fn=_slugify_shared,
                    warning_prefix=_PRD_HAND_EDIT_WARNING,
                )
                for stat in stats:
                    stat["flagged"] = True
                if narrative and spec_vbrief_path.exists():
                    narrative, stripped_ids = _strip_traces_from_narrative(
                        narrative
                    )
                    if stripped_ids:
                        traces_stripped_audit.append({
                            "source": "PRD.md",
                            "task_ids": stripped_ids,
                        })
                    _attach_legacy_narrative(spec_vbrief_path, narrative)
                    for sidecar in sidecars:
                        try:
                            rel = sidecar.relative_to(project_root).as_posix()
                        except ValueError:
                            rel = str(sidecar)
                        if rel not in created_files:
                            created_files.append(rel)
                    captures[
                        "PRD.md content (flagged: hand-edited)"
                    ].extend(stats)
                    actions.append(
                        "LEGACY PRD.md hand-edit captures: "
                        f"{len(stats)} section(s)"
                    )

        # Emit vbrief/migration/LEGACY-REPORT.md + stdout summary.
        sources_read = [p for p in (
            "SPECIFICATION.md" if spec_md_content else None,
            "PROJECT.md" if project_content else None,
            "ROADMAP.md" if total_items else None,
            "PRD.md" if prd_path.exists() else None,
        ) if p]
        report_path = _emit_legacy_report(
            project_root,
            captures,
            migrator_version=MIGRATOR_VERSION,
            sources=sources_read,
        )
        if report_path is not None:
            try:
                rel_report = report_path.relative_to(project_root).as_posix()
            except ValueError:
                rel_report = str(report_path)
            if rel_report not in created_files:
                created_files.append(rel_report)
            total_captured = sum(len(v) for v in captures.values())
            actions.append(
                f"CREATE {rel_report} ({total_captured} section(s) captured)"
            )
            for line in _summarize_captures(captures):
                actions.append(line)
    elif spec_legacy_sections or project_content:
        actions.append("DRYRUN LEGACY capture (skipped under --dry-run)")
    # --- end legacy-artifacts ---

    # --- reconciliation-report (Agent B, #496) ---
    # Emit vbrief/migration/RECONCILIATION.md when SPEC and ROADMAP
    # disagreed or any override triggered. Runs AFTER scope vBRIEFs are
    # written but BEFORE Agent C's safety manifest so the report is
    # recorded in created_files and removed on --rollback.
    if not dry_run and reconciliation_report.has_disagreement():
        report_path = _write_reconciliation_report(
            reconciliation_report, vbrief_dir
        )
        if report_path is not None:
            try:
                rel = report_path.relative_to(project_root).as_posix()
            except ValueError:
                rel = str(report_path)
            created_files.append(rel)
            actions.append(f"CREATE {rel}")
    elif dry_run and reconciliation_report.has_disagreement():
        actions.append(
            "DRYRUN CREATE vbrief/migration/RECONCILIATION.md"
        )
    # --- end reconciliation-report ---

    # #529: Append the Traces-stripped audit section to RECONCILIATION.md.
    # Runs AFTER the reconciliation report so both live in the same file --
    # the report writer overwrites, so appending last keeps both surfaces.
    # In --dry-run the call short-circuits to a log line.
    traces_report_path, traces_action = _write_traces_stripped_note(
        project_root, traces_stripped_audit, dry_run=dry_run
    )
    if traces_action:
        actions.append(traces_action)
    if traces_report_path is not None:
        try:
            rel = traces_report_path.relative_to(project_root).as_posix()
        except ValueError:
            rel = str(traces_report_path)
        if rel not in created_files:
            created_files.append(rel)

    # #527 / #528: record any migrator-managed subdirs we created (legacy,
    # migration) in the safety manifest's created_dirs so --rollback RMDIRs
    # them consistently with the lifecycle folders. Uses the pre-existed
    # snapshot captured at the top of this function so the decision is
    # driven by manifest state rather than filesystem scan.
    #
    # Pre-create vbrief/migration/ here because the safety manifest is about
    # to be written into it below (via write_safety_manifest) -- by mkdir'ing
    # now we surface its creation to the tracking helper in the same call
    # site as all other managed-subdir tracking.
    migration_dir = vbrief_dir / "migration"
    if not dry_run and not migration_dir.is_dir():
        migration_dir.mkdir(parents=True, exist_ok=True)
    for subdir_name in _MANAGED_SUBDIRS:
        _track_managed_subdir(
            project_root,
            subdir_name,
            managed_subdir_pre_existed,
            created_dirs,
        )

    # --- safety (Agent C, #497) ---
    # Persist a safety manifest for --rollback.  The manifest lives under
    # vbrief/migration/ (#506 shared path convention) and records:
    #   * every .premigrate.* backup we wrote (for restore);
    #   * every file/directory this run created (for removal on rollback);
    #   * post-migration stub hashes (so rollback can detect later edits).
    #
    # Re-run protection (Greptile #509 P1 cascade-3): when the migrator is
    # re-invoked on an already-migrated project, plan_backups correctly
    # returns zero pairs (sources are all stubs), so ``backup_records`` is
    # empty.  Writing a fresh manifest with ``backups=[]`` would overwrite
    # the first run's record, leaving ``--rollback`` unable to restore any
    # originals.  Load any prior manifest and carry its backup records
    # forward so subsequent rollback still works end-to-end.  Stub hashes
    # and created_files are merged the same way so rollback still knows
    # which artefacts to remove.
    prior = load_safety_manifest(project_root) if not dry_run else None
    merged_backups = list(backup_records)
    merged_stub_hashes = dict(stub_hashes)
    merged_created_files = list(created_files)
    merged_created_dirs = list(created_dirs)
    if prior is not None:
        # Re-run on already-migrated project: union the prior manifest's
        # records with this run's so nothing recorded before is dropped.
        # Current-run records take precedence for overlapping sources
        # (fresh digest wins), and prior-run records for sources we did
        # not touch this time (e.g. SPECIFICATION.md / PROJECT.md are
        # stubs on the second pass and get skipped by plan_backups).
        current_sources = {b.source for b in backup_records}
        for prior_record in prior.backups:
            if prior_record.source not in current_sources:
                merged_backups.append(prior_record)
        for rel, digest in prior.post_migration_stub_hashes.items():
            merged_stub_hashes.setdefault(rel, digest)
        for rel in prior.created_files:
            if rel not in merged_created_files:
                merged_created_files.append(rel)
        for rel in prior.created_dirs:
            if rel not in merged_created_dirs:
                merged_created_dirs.append(rel)
    manifest = SafetyManifest(
        version="1",
        migration_timestamp=now_utc_iso(),
        backups=merged_backups,
        created_files=merged_created_files,
        created_dirs=merged_created_dirs,
        post_migration_stub_hashes=merged_stub_hashes,
    )
    manifest_action = write_safety_manifest(
        project_root, manifest, dry_run=dry_run
    )
    actions.append(manifest_action)
    # --- end safety ---

    # ---- Report ----
    for w in warnings:
        actions.append(w)

    # --- strict gate (Agent B, #496) ---
    # ``task migrate:vbrief -- --strict`` must exit non-zero when any
    # SPEC/ROADMAP disagreement was recorded so CI can gate cutover until
    # the operator has reviewed RECONCILIATION.md. Runs BEFORE Agent D's
    # validation gate because a reconciliation conflict is a workflow
    # decision surface -- the scope vBRIEFs themselves are still
    # schema-valid, so the operator would otherwise see a success exit
    # from the validator. Agent C's .premigrate.* backups remain in place
    # for ``task migrate:vbrief -- --rollback`` recovery either way.
    if strict and reconciliation_report.has_disagreement() and not dry_run:
        actions.append(
            "STRICT: reconciliation conflicts detected; see "
            "vbrief/migration/RECONCILIATION.md"
        )
        return False, actions
    # --- end strict gate ---

    # --- validation (Agent D, #498) ---
    # Hard-block on schema-invalid migration output per #506 D8. Runs AFTER
    # Agent C's safety path (#497) so .premigrate.* backups and the safety
    # manifest remain in place on failure for ``task migrate:vbrief --
    # --rollback`` recovery. Skipped under --dry-run so operators can preview
    # the plan without invoking the validator on a non-existent tree. Full
    # implementation lives in scripts/_vbrief_validation.py::
    # finalize_migration to keep migrate_vbrief.py under the 1000-line cap.
    if dry_run:
        return True, actions
    return finalize_migration(project_root, vbrief_dir, actions)


def _edge_nodes(edge: dict) -> tuple[str, str]:
    """Return (from_id, to_id) for a vBRIEF edge, reading both dialects.

    The canonical v0.5 key names are ``from`` / ``to``, but earlier speckit
    drafts used ``source`` / ``target``.  Prefer the canonical keys when they
    are populated and fall back to the legacy keys so a single translator can
    handle both shapes (covers the #458 migrate_vbrief.py touchpoint).
    """
    if not isinstance(edge, dict):
        return "", ""
    src = edge.get("from") or edge.get("source", "")
    tgt = edge.get("to") or edge.get("target", "")
    return str(src or ""), str(tgt or "")


def _dependencies_for_item(item_id: str, edges: list[dict]) -> list[str]:
    """Return the list of item IDs that block ``item_id`` (bilingual reader).

    An edge with ``type == 'blocks'`` and target equal to ``item_id`` means the
    edge's source blocks this item — so the source is a dependency of it.
    """
    deps: list[str] = []
    for edge in edges or []:
        if not isinstance(edge, dict):
            continue
        if edge.get("type", "") != "blocks":
            continue
        src, tgt = _edge_nodes(edge)
        if tgt == item_id and src and src not in deps:
            deps.append(src)
    return deps


def _speckit_ip_slug(title: str, item_id: str) -> str:
    """Return a slug for a speckit IP item filename.

    Strips any leading ``IP-N:`` / ``IP\u00a0N:`` / ``IPN-`` prefix so the slug
    focuses on the descriptive part (e.g. ``IP-3: Implement data layer`` ->
    ``implement-data-layer``).  Falls back to the item_id slug when no title
    is available.
    """
    source = (title or item_id or "").strip()
    # Strip leading IP-N: or IP N: or IPN- prefixes (case-insensitive).
    source = re.sub(r"^\s*IP[\s-]*\d+\s*[:\-]\s*", "", source, flags=re.IGNORECASE)
    slug = _slugify(source)
    return slug or _slugify(item_id) or "ip-phase"


def _speckit_ip_index(item: dict, fallback_index: int) -> int:
    """Derive the numeric IP index for a speckit plan item.

    Resolution order:
    1. Trailing digits on ``item.id`` (e.g. ``ip-3``, ``IP-12``, ``t4`` -> 3/12/4).
    2. Leading digits on ``item.title`` (e.g. ``IP-7: Foo`` -> 7).
    3. ``fallback_index`` (1-based position in the items list).
    """
    item_id = str(item.get("id", "") or "")
    tail = re.search(r"(\d+)\s*$", item_id)
    if tail:
        return int(tail.group(1))
    title = str(item.get("title", "") or "")
    lead = re.search(r"IP[\s-]*(\d+)", title, flags=re.IGNORECASE)
    if lead:
        return int(lead.group(1))
    return fallback_index


def _create_speckit_scope_vbrief(
    item: dict,
    *,
    ip_index: int,
    dependencies: list[str],
    spec_ref: str,
) -> dict:
    """Build a Phase 4 scope vBRIEF dict for a speckit implementation phase.

    Populates the canonical narrative keys (``Description``, ``Acceptance``,
    ``Traces``), writes ``plan.metadata.dependencies`` at the plan level, and
    links back to the parent ``specification.vbrief.json`` via a
    ``x-vbrief/plan`` reference.
    """
    title = str(item.get("title", f"IP-{ip_index}") or f"IP-{ip_index}")
    narrative = item.get("narrative") or {}
    if not isinstance(narrative, dict):
        narrative = {}

    def _pick(*keys: str, default: str = "") -> str:
        for key in keys:
            value = narrative.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return default

    description = _pick("Description", "Summary", default=title)
    acceptance = _pick("Acceptance", "AcceptanceCriteria", default="")
    traces = _pick("Traces", "Trace", "Requirements", default=f"IP-{ip_index}")

    default_acceptance = (
        f"Acceptance criteria for IP-{ip_index} "
        f"(copy from specification.vbrief.json)."
    )
    narratives: dict[str, str] = {
        "Description": description,
        "Acceptance": acceptance or default_acceptance,
        "Traces": traces,
    }
    # Preserve optional canonical-adjacent keys if present.
    for extra in ("Phase", "PhaseDescription", "Tier"):
        value = narrative.get(extra)
        if isinstance(value, str) and value.strip():
            narratives[extra] = value.strip()

    references = [
        {"type": "x-vbrief/plan", "url": spec_ref},
    ]
    # Copy any origin-provenance refs from the item (e.g. github-issue).
    for ref in item.get("references", []) or []:
        if isinstance(ref, dict) and ref.get("type") != "x-vbrief/plan":
            references.append(ref)

    plan: dict = {
        "title": title,
        "status": "pending",
        "narratives": narratives,
        "items": [],
        "references": references,
    }
    if dependencies:
        plan["metadata"] = {"dependencies": list(dependencies)}

    return {
        "vBRIEFInfo": {
            "version": EMITTED_VBRIEF_VERSION,
            "description": f"Scope vBRIEF for speckit IP-{ip_index}",
        },
        "plan": plan,
    }


def migrate_speckit_plan(
    plan_path: Path,
    *,
    pending_dir: Path | None = None,
    date: str | None = None,
    spec_ref: str = "../specification.vbrief.json",
) -> tuple[bool, list[str]]:
    """Translate a speckit-shaped ``plan.vbrief.json`` into scope vBRIEFs.

    Each ``plan.items`` entry becomes a file in ``pending_dir`` named
    ``YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json``.  Dependencies are read from
    ``plan.edges`` with ``type == 'blocks'`` using the bilingual edge reader
    (``from/to`` preferred, ``source/target`` fallback) so both legacy and
    canonical edge shapes translate correctly.  The source ``plan.vbrief.json``
    is rewritten to the canonical session-todo scaffold described in
    ``vbrief/vbrief.md#planvbriefjson`` (empty items, session-level title).

    Returns ``(ok, actions)`` where ``actions`` is a human-readable list.
    """
    actions: list[str] = []
    if not plan_path.is_file():
        return False, [f"ERROR: plan.vbrief.json not found at {plan_path}"]

    try:
        plan_data = json.loads(plan_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return False, [f"ERROR: invalid JSON in {plan_path.name}: {exc}"]

    plan = plan_data.get("plan", {}) if isinstance(plan_data, dict) else {}
    items = plan.get("items", []) if isinstance(plan, dict) else []
    edges = plan.get("edges", []) if isinstance(plan, dict) else []

    if not items:
        return False, [
            "ERROR: plan.vbrief.json has no items to migrate (empty speckit plan?)"
        ]

    pending_dir = pending_dir or (plan_path.parent / "pending")
    pending_dir.mkdir(parents=True, exist_ok=True)
    date = date or _TODAY

    created_paths: list[Path] = []
    for idx, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        ip_index = _speckit_ip_index(item, idx)
        item_id = str(item.get("id", "") or f"ip-{ip_index}")
        dependencies = _dependencies_for_item(item_id, edges)
        slug = _speckit_ip_slug(str(item.get("title", "")), item_id)
        ip_token = f"ip{ip_index:03d}"
        filename = f"{date}-{ip_token}-{slug}.vbrief.json"
        target = pending_dir / filename
        if target.exists():
            actions.append(f"SKIP   pending/{filename} already exists")
            created_paths.append(target)
            continue
        scope = _create_speckit_scope_vbrief(
            item,
            ip_index=ip_index,
            dependencies=dependencies,
            spec_ref=spec_ref,
        )
        target.write_text(
            json.dumps(scope, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        actions.append(f"CREATE pending/{filename} (IP-{ip_index})")
        created_paths.append(target)

    # Rewrite plan.vbrief.json to the session-todo scaffold, preserving the
    # envelope title so context isn't lost.
    envelope = plan_data.get("vBRIEFInfo", {}) if isinstance(plan_data, dict) else {}
    # #533: force the emitted envelope to the current canonical version so a
    # v0.5 speckit plan migrated today produces a v0.6 session scaffold.
    envelope["version"] = EMITTED_VBRIEF_VERSION
    envelope["description"] = (
        "Session-level tactical plan (migrated from speckit plan). "
        "Scope vBRIEFs live in vbrief/pending/."
    )
    session_plan = {
        "vBRIEFInfo": envelope,
        "plan": {
            "title": str(plan.get("title", "Session plan")) or "Session plan",
            "status": "running",
            "items": [],
        },
    }
    plan_path.write_text(
        json.dumps(session_plan, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    actions.append(f"REWRITE {plan_path.name} -> session-todo scaffold")
    return True, actions


def _find_existing_scope_vbrief(vbrief_dir: Path, issue_number: str) -> Path | None:
    """Check if any existing vBRIEF in lifecycle folders references the issue."""
    for folder_name in LIFECYCLE_FOLDERS:
        folder = vbrief_dir / folder_name
        if not folder.exists():
            continue
        for fpath in folder.glob("*.vbrief.json"):
            try:
                data = json.loads(fpath.read_text(encoding="utf-8"))
                refs = data.get("plan", {}).get("references", [])
                for ref in refs:
                    if ref.get("id") == f"#{issue_number}":
                        return fpath
            except (json.JSONDecodeError, AttributeError):
                continue
    return None


def _fold_custom_content(proj_def_path: Path, key: str, content: str) -> bool:
    """Fold custom content into PROJECT-DEFINITION.vbrief.json narratives.

    Returns True if content was successfully preserved, False otherwise.

    Legacy fallback preserved for backward compatibility; the new
    ``LegacyArtifacts`` mechanism (#505) captures non-canonical ## sections
    with full provenance headers and is the preferred preservation surface
    going forward.
    """
    if not proj_def_path.exists():
        return False
    try:
        data = json.loads(proj_def_path.read_text(encoding="utf-8"))
        data.setdefault("plan", {}).setdefault("narratives", {})[key] = content
        proj_def_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return True
    except (json.JSONDecodeError, AttributeError):
        return False


# --- legacy-artifacts (Agent A, #505) ---
def _attach_legacy_narrative(vbrief_path: Path, narrative: str) -> None:
    """Append a ``LegacyArtifacts`` narrative onto an existing vBRIEF file.

    If the file already carries a ``LegacyArtifacts`` narrative, the new
    content is concatenated (blank-line separator) so multiple capture
    passes on one run do not silently overwrite one another.
    """
    if not vbrief_path.exists():
        return
    try:
        data = json.loads(vbrief_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    plan = data.setdefault("plan", {})
    narratives = plan.setdefault("narratives", {})
    existing = narratives.get("LegacyArtifacts", "")
    if isinstance(existing, str) and existing.strip():
        narratives["LegacyArtifacts"] = (
            existing.rstrip() + "\n\n" + narrative.strip() + "\n"
        )
    else:
        narratives["LegacyArtifacts"] = narrative
    vbrief_path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _canonical_spec_keys_in(spec_vbrief_path: Path) -> set[str]:
    """Return the canonical spec narrative keys present on disk.

    Used by the PRD.md section-name diff (OQ3-b, #505 Section 5) to decide
    whether a PRD ## section is expected render output (skip capture) or a
    hand-edited section that should be captured with the warning prefix.
    """
    if not spec_vbrief_path.exists():
        return set()
    try:
        data = json.loads(spec_vbrief_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return set()
    narratives = data.get("plan", {}).get("narratives", {}) or {}
    if not isinstance(narratives, dict):
        return set()
    return {
        k for k, v in narratives.items()
        if k in _CANONICAL_SPEC_KEYS and isinstance(v, str) and v.strip()
    }
# --- end legacy-artifacts ---


def main() -> int:
    """Entry point for the migration script."""
    import argparse

    args = list(sys.argv[1:])

    # --speckit-plan <path> subcommand: convert a speckit-shaped plan.vbrief.json
    # into per-IP scope vBRIEFs in ``<plan dir>/pending/`` (#436, #458).
    # Handled ahead of the main argparse so we keep its positional-path calling
    # convention stable for the test harness that already exercises it.
    if args and args[0] == "--speckit-plan":
        if len(args) < 2:
            print(
                "ERROR: --speckit-plan requires a path argument",
                file=sys.stderr,
            )
            return 2
        plan_path = Path(args[1]).resolve()
        print(f"Migrating speckit plan at: {plan_path}")
        print("=" * 60)
        ok, messages = migrate_speckit_plan(plan_path)
        for msg in messages:
            print(f"  {msg}")
        print("=" * 60)
        if ok:
            print("speckit plan migration completed successfully.")
            return 0
        print("speckit plan migration FAILED.", file=sys.stderr)
        return 1

    # --- safety (Agent C, #497) ---
    # Primary CLI for `task migrate:vbrief` -- positional project_root +
    # --dry-run / --force / --rollback flags per #506 D7.
    parser = argparse.ArgumentParser(
        prog="migrate_vbrief.py",
        description=(
            "Migrate a Deft project to the vBRIEF-centric document model. "
            "Destructive by default; use --dry-run to preview or --rollback "
            "to undo a previous migration."
        ),
    )
    parser.add_argument(
        "project_root",
        nargs="?",
        default=None,
        help="Path to the project root (default: current working directory).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Print the migration plan without writing any files. Exits 0 on "
            "success with every planned action prefixed DRYRUN."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=(
            "Bypass the dirty-tree guard (and the rollback confirmation / "
            "edited-stub guard). Not recommended."
        ),
    )
    parser.add_argument(
        "--rollback",
        action="store_true",
        help=(
            "Restore from .premigrate.* backups and remove the scope "
            "vBRIEFs and migration artefacts a prior run created. Reads "
            "vbrief/migration/safety-manifest.json written by the migrator."
        ),
    )
    # --- strict flag (Agent B, #496) ---
    parser.add_argument(
        "--strict",
        action="store_true",
        help=(
            "Fail the run non-zero if SPEC and ROADMAP disagreed on any "
            "dimension or any override from vbrief/migration-overrides.yaml "
            "triggered. Scope vBRIEFs and vbrief/migration/RECONCILIATION.md "
            "are still written so the operator can inspect and re-run."
        ),
    )
    # --- end strict flag ---
    ns = parser.parse_args(args)

    project_root = (
        Path(ns.project_root).resolve() if ns.project_root else Path.cwd()
    )

    if not project_root.is_dir():
        print(f"ERROR: {project_root} is not a directory", file=sys.stderr)
        return 1

    if ns.rollback:
        print(f"Rolling back migration at: {project_root}")
        print("=" * 60)
        ok, messages = safety_rollback(project_root, force=ns.force)
        for msg in messages:
            print(f"  {msg}")
        print("=" * 60)
        if ok:
            print("Rollback completed successfully.")
            return 0
        print("Rollback FAILED.", file=sys.stderr)
        return 1

    if ns.dry_run:
        print(f"Dry-run migration at: {project_root}")
    else:
        print(f"Migrating project at: {project_root}")
    if ns.strict:
        print("Strict mode enabled: reconciliation conflicts will fail the run.")
    print("=" * 60)

    ok, messages = migrate(
        project_root,
        dry_run=ns.dry_run,
        force=ns.force,
        strict=ns.strict,
    )

    for msg in messages:
        print(f"  {msg}")

    print("=" * 60)
    if ok:
        if ns.dry_run:
            print("Dry-run completed successfully. No files were modified.")
        else:
            print("Migration completed successfully.")
        return 0
    # --- end safety ---
    print("Migration FAILED.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
