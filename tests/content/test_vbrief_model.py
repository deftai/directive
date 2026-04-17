"""
test_vbrief_model.py — Content and structural tests for the vBRIEF-centric document model.

Story L (#321) of Phase 2 vBRIEF Architecture Cutover.
Complements Tier 1 script tests (test_migrate_vbrief.py, test_roadmap_render.py,
test_vbrief_validate.py, test_scope_lifecycle.py) with repo-level structural and
content assertions that are independent of script execution.

Author: Oz agent — 2026-04-13
"""

import json
import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Repo root
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SKILLS_DIR = _REPO_ROOT / "skills"
_AGENTS_MD = _REPO_ROOT / "AGENTS.md"
_VBRIEF_MD = _REPO_ROOT / "vbrief" / "vbrief.md"
_SCHEMA_PATH = _REPO_ROOT / "vbrief" / "schemas" / "vbrief-core.schema.json"

# Lifecycle folders documented in vbrief.md (RFC D2/D13)
_LIFECYCLE_FOLDERS = ("proposed", "pending", "active", "completed", "cancelled")

# Status values that belong in each lifecycle folder (from vbrief.md)
_FOLDER_STATUS_MAP: dict[str, set[str]] = {
    "proposed": {"draft", "proposed"},
    "pending": {"approved", "pending"},
    "active": {"running", "blocked"},
    "completed": {"completed"},
    "cancelled": {"cancelled"},
}

# Valid vBRIEF status values (from schema)
_VALID_STATUSES = {
    "draft", "proposed", "approved", "pending",
    "running", "completed", "blocked", "cancelled",
}

# Files that should NOT reference SPECIFICATION.md or PROJECT.md as
# first-class output targets (non-deprecated, non-history content files).
# Excludes: history/, CHANGELOG.md, deprecated files, and test files.
_CONTENT_GLOBS = [
    "skills/*/SKILL.md",
    "AGENTS.md",
    "main.md",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _skill_subdirs() -> list[str]:
    """Return the directory names directly under skills/."""
    return [d.name for d in _SKILLS_DIR.iterdir() if d.is_dir()]


def _routing_entries() -> list[tuple[str, str]]:
    """Parse AGENTS.md Skill Routing table into (keywords, path) tuples.

    Each routing line looks like:
    - "keyword" / "keyword" ... -> `skills/deft-directive-xxx/SKILL.md`
    """
    text = _read_text(_AGENTS_MD)
    pattern = re.compile(
        r"^-\s+.+\u2192\s+`(skills/[^`]+)`",
        re.MULTILINE,
    )
    results: list[tuple[str, str]] = []
    for match in pattern.finditer(text):
        line = match.group(0)
        path = match.group(1)
        results.append((line, path))
    return results


# Cache collection-time calls to avoid re-parsing files during pytest parametrize
_ROUTING_ENTRIES = _routing_entries()


def _content_files() -> list[Path]:
    """Collect non-deprecated content files that should not reference
    SPECIFICATION.md or PROJECT.md as first-class output targets."""
    files: list[Path] = []
    for glob in _CONTENT_GLOBS:
        files.extend(_REPO_ROOT.glob(glob))
    return sorted(files)


_CONTENT_FILES = _content_files()


# ===========================================================================
# 1. CONTENT TESTS — Repo Structure Validation
# ===========================================================================


# ---------------------------------------------------------------------------
# 1a. skills/ directory contains only deft-directive-* subdirectories
# ---------------------------------------------------------------------------

# v0.19 -> v0.20 bridge: these bare `deft-*` directories contain a one-paragraph
# deprecation redirect SKILL.md that points stale v0.19 AGENTS.md references at
# deft/QUICK-START.md. They are NOT real skills; they exist for one release
# cycle so consumer projects with old AGENTS.md paths keep working until
# QUICK-START can refresh them. See issue #411 and
# `tests/content/test_deprecated_skill_redirects.py` for stub content checks.
_DEPRECATED_SKILL_REDIRECT_STUBS = frozenset({
    "deft-build",
    "deft-interview",
    "deft-pre-pr",
    "deft-review-cycle",
    "deft-roadmap-refresh",
    "deft-setup",
    "deft-swarm",
    "deft-sync",
})


def test_skills_dir_only_deft_directive_prefixed() -> None:
    """Every subdirectory under skills/ must use the deft-directive-* prefix.

    Exception: the 8 bare `deft-*` deprecated-redirect stubs (#411 v0.19 -> v0.20
    bridge) are allowed by name. Their content is enforced by
    `tests/content/test_deprecated_skill_redirects.py`.
    """
    subdirs = _skill_subdirs()
    assert subdirs, "skills/ directory is empty or missing"
    non_conforming = [
        d for d in subdirs
        if not d.startswith("deft-directive-")
        and d not in _DEPRECATED_SKILL_REDIRECT_STUBS
    ]
    assert not non_conforming, (
        f"skills/ contains subdirectories without 'deft-directive-' prefix: "
        f"{sorted(non_conforming)} "
        f"(allowed redirect stubs: {sorted(_DEPRECATED_SKILL_REDIRECT_STUBS)})"
    )


def test_skills_dir_has_no_bare_deft_prefix() -> None:
    """No skills/ subdirectory should use the old deft-* naming, except the 8
    bare deft-* deprecated-redirect stubs (#411 v0.19 -> v0.20 bridge)."""
    subdirs = _skill_subdirs()
    bare_deft = [
        d for d in subdirs
        if d.startswith("deft-")
        and not d.startswith("deft-directive-")
        and d not in _DEPRECATED_SKILL_REDIRECT_STUBS
    ]
    assert not bare_deft, (
        f"skills/ contains unexpected deft-* directories (neither 'deft-directive-*' "
        f"nor known redirect stubs): {sorted(bare_deft)}"
    )


# ---------------------------------------------------------------------------
# 1b. AGENTS.md routing table entries reference existing skill directories
# ---------------------------------------------------------------------------

def test_agents_md_routing_entries_exist() -> None:
    """AGENTS.md Skill Routing section must have at least one entry."""
    entries = _routing_entries()
    assert len(entries) >= 1, (
        "AGENTS.md Skill Routing section has no parseable routing entries"
    )


@pytest.mark.parametrize(
    "line,skill_path",
    _ROUTING_ENTRIES,
    ids=[p for _, p in _ROUTING_ENTRIES],
)
def test_agents_md_routing_path_exists(line: str, skill_path: str) -> None:
    """Each AGENTS.md routing entry must point to an existing file."""
    full_path = _REPO_ROOT / skill_path
    assert full_path.is_file(), (
        f"AGENTS.md routing entry points to missing file: {skill_path}\n"
        f"  Line: {line}"
    )


@pytest.mark.parametrize(
    "line,skill_path",
    _ROUTING_ENTRIES,
    ids=[p for _, p in _ROUTING_ENTRIES],
)
def test_agents_md_routing_uses_directive_prefix(line: str, skill_path: str) -> None:
    """All AGENTS.md routing paths must use the deft-directive-* prefix."""
    assert "deft-directive-" in skill_path, (
        f"AGENTS.md routing entry uses old naming convention: {skill_path}\n"
        f"  Expected: skills/deft-directive-*/SKILL.md"
    )


# ---------------------------------------------------------------------------
# 1c. No stale SPECIFICATION.md or PROJECT.md as first-class output targets
#     in non-deprecated skill/framework content files
# ---------------------------------------------------------------------------

def _is_stale_output_reference(line: str) -> bool:
    """Check if a line references SPECIFICATION.md or PROJECT.md as an output target.

    We look for patterns like 'output SPECIFICATION.md', 'generate PROJECT.md',
    'write to PROJECT.md', etc. Exclude: deprecation redirects, mentions in
    comments about migration, and references as read-only sources.
    """
    lower = line.lower()
    # Skip lines that are about deprecation, migration, or history
    if any(word in lower for word in (
        "deprecated", "redirect", "migration", "legacy", "replaced by",
        "no longer", "instead of", "was previously",
    )):
        return False
    # Check for output-target language
    output_patterns = [
        r"(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md",
        r"(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md",
    ]
    return any(re.search(pat, line) for pat in output_patterns)


@pytest.mark.parametrize(
    "content_file",
    _CONTENT_FILES,
    ids=[str(f.relative_to(_REPO_ROOT)) for f in _CONTENT_FILES],
)
def test_no_stale_output_target_references(content_file: Path) -> None:
    """Non-deprecated content files must not reference SPECIFICATION.md or
    PROJECT.md as first-class output targets."""
    text = _read_text(content_file)
    violations: list[str] = []
    for i, line in enumerate(text.splitlines(), start=1):
        if _is_stale_output_reference(line):
            violations.append(f"  L{i}: {line.strip()}")
    assert not violations, (
        f"{content_file.relative_to(_REPO_ROOT)} references SPECIFICATION.md or "
        f"PROJECT.md as output target:\n" + "\n".join(violations)
    )


# ---------------------------------------------------------------------------
# 1d. vbrief/vbrief.md documents lifecycle folder structure
# ---------------------------------------------------------------------------

def test_vbrief_md_documents_all_lifecycle_folders() -> None:
    """vbrief.md must document all five lifecycle folders."""
    text = _read_text(_VBRIEF_MD)
    for folder in _LIFECYCLE_FOLDERS:
        assert f"{folder}/" in text, (
            f"vbrief/vbrief.md missing documentation for lifecycle folder: {folder}/"
        )


def test_vbrief_md_documents_directory_structure() -> None:
    """vbrief.md must contain a Directory Structure section with folder layout."""
    text = _read_text(_VBRIEF_MD)
    assert "### Directory Structure" in text, (
        "vbrief/vbrief.md missing '### Directory Structure' section"
    )
    assert "PROJECT-DEFINITION.vbrief.json" in text, (
        "vbrief/vbrief.md Directory Structure must reference "
        "PROJECT-DEFINITION.vbrief.json"
    )


def test_vbrief_md_documents_status_driven_moves() -> None:
    """vbrief.md must document status-driven file moves."""
    text = _read_text(_VBRIEF_MD)
    assert "### Status-Driven Moves" in text, (
        "vbrief/vbrief.md missing '### Status-Driven Moves' section"
    )
    assert "plan.status" in text, (
        "vbrief/vbrief.md Status-Driven Moves must reference plan.status "
        "as source of truth"
    )


def test_vbrief_md_documents_filename_convention() -> None:
    """vbrief.md must document the scope vBRIEF filename convention."""
    text = _read_text(_VBRIEF_MD)
    assert "### Filename Convention" in text, (
        "vbrief/vbrief.md missing '### Filename Convention' section"
    )
    assert "YYYY-MM-DD" in text, (
        "vbrief/vbrief.md Filename Convention must specify YYYY-MM-DD date prefix"
    )


def test_vbrief_md_documents_origin_provenance() -> None:
    """vbrief.md must document origin provenance requirements."""
    text = _read_text(_VBRIEF_MD)
    assert "### Origin Provenance" in text, (
        "vbrief/vbrief.md missing '### Origin Provenance' section"
    )
    assert "github-issue" in text, (
        "vbrief/vbrief.md Origin Provenance must list github-issue as a "
        "reference type"
    )


# ===========================================================================
# 2. LIFECYCLE VALIDATION TESTS
# ===========================================================================


# ---------------------------------------------------------------------------
# 2a. vBRIEF filename convention: YYYY-MM-DD-slug.vbrief.json
# ---------------------------------------------------------------------------

_FILENAME_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.vbrief\.json$"
)


@pytest.mark.parametrize(
    "valid_name",
    [
        "2026-04-12-add-oauth-flow.vbrief.json",
        "2026-01-01-fix-login-bug.vbrief.json",
        "2025-12-31-setup-ci.vbrief.json",
    ],
    ids=["oauth-flow", "login-bug", "setup-ci"],
)
def test_filename_convention_accepts_valid(valid_name: str) -> None:
    """Valid vBRIEF filenames must match the YYYY-MM-DD-slug pattern."""
    assert _FILENAME_PATTERN.match(valid_name), (
        f"Expected valid vBRIEF filename to match: {valid_name}"
    )


@pytest.mark.parametrize(
    "invalid_name",
    [
        "oauth-flow.vbrief.json",           # missing date
        "2026-04-12.vbrief.json",           # missing slug
        "2026-4-12-fix.vbrief.json",        # non-zero-padded month
        "2026-04-12-Fix-Bug.vbrief.json",   # uppercase in slug
        "2026-04-12-fix_bug.vbrief.json",   # underscore in slug
        "specification.vbrief.json",         # root-level file, not scope
    ],
    ids=["no-date", "no-slug", "bad-month", "uppercase", "underscore", "root-file"],
)
def test_filename_convention_rejects_invalid(invalid_name: str) -> None:
    """Invalid vBRIEF filenames must not match the scope filename pattern."""
    assert not _FILENAME_PATTERN.match(invalid_name), (
        f"Expected invalid vBRIEF filename to NOT match: {invalid_name}"
    )


# ---------------------------------------------------------------------------
# 2b. Status/folder consistency: status values match lifecycle folder names
# ---------------------------------------------------------------------------

def test_folder_status_map_covers_all_valid_statuses() -> None:
    """The folder-status mapping must cover every valid status value exactly once."""
    mapped_statuses: set[str] = set()
    for statuses in _FOLDER_STATUS_MAP.values():
        mapped_statuses |= statuses
    assert mapped_statuses == _VALID_STATUSES, (
        f"Folder-status mapping does not cover all valid statuses.\n"
        f"  Mapped:   {sorted(mapped_statuses)}\n"
        f"  Expected: {sorted(_VALID_STATUSES)}"
    )


def test_folder_status_map_no_overlap() -> None:
    """No status value should appear in more than one lifecycle folder."""
    seen: dict[str, str] = {}
    for folder, statuses in _FOLDER_STATUS_MAP.items():
        for status in statuses:
            assert status not in seen, (
                f"Status '{status}' appears in both '{seen[status]}' and "
                f"'{folder}' folder mappings"
            )
            seen[status] = folder


@pytest.mark.parametrize(
    "folder,expected_statuses",
    list(_FOLDER_STATUS_MAP.items()),
    ids=list(_FOLDER_STATUS_MAP.keys()),
)
def test_vbrief_md_documents_folder_status_mapping(
    folder: str, expected_statuses: set[str],
) -> None:
    """vbrief.md must document the status-to-folder mapping for each folder."""
    text = _read_text(_VBRIEF_MD)
    for status in expected_statuses:
        assert f"`{status}`" in text, (
            f"vbrief/vbrief.md missing status '{status}' for folder {folder}/"
        )


# ---------------------------------------------------------------------------
# 2c. Origin provenance structure (references array format)
# ---------------------------------------------------------------------------

def test_origin_provenance_example_in_vbrief_md() -> None:
    """vbrief.md must contain a JSON example of the references array format."""
    text = _read_text(_VBRIEF_MD)
    assert '"references"' in text, (
        "vbrief/vbrief.md must contain a references array example"
    )
    assert '"type"' in text and '"url"' in text and '"id"' in text, (
        "vbrief/vbrief.md references example must include type, url, and id fields"
    )


def test_origin_provenance_valid_reference_structure() -> None:
    """Validate that a JSON example in vbrief.md contains a well-formed references array."""
    text = _read_text(_VBRIEF_MD)
    # Find JSON code blocks that are complete objects and contain "references"
    for match in re.finditer(r'```json\n(\{.*?\})\n```', text, re.DOTALL):
        try:
            data = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        # Navigate to references — may be at top level or nested in plan
        refs = data.get("references", [])
        if not refs:
            plan = data.get("plan", {})
            refs = plan.get("references", []) if isinstance(plan, dict) else []
        if refs:
            ref = refs[0]
            assert "type" in ref, "reference must have 'type' key"
            assert "url" in ref, "reference must have 'url' key"
            return
    pytest.fail("No JSON code block with a valid 'references' array found in vbrief.md")


def test_origin_provenance_reference_types_documented() -> None:
    """vbrief.md must document extensible reference types."""
    text = _read_text(_VBRIEF_MD)
    assert "github-issue" in text, (
        "vbrief/vbrief.md must document 'github-issue' reference type"
    )
    assert "jira-ticket" in text, (
        "vbrief/vbrief.md must document 'jira-ticket' reference type"
    )
    assert "user-request" in text, (
        "vbrief/vbrief.md must document 'user-request' reference type"
    )


# ===========================================================================
# 3. SCHEMA CONSISTENCY — Cross-checks between vbrief.md and schema
# ===========================================================================


def test_schema_status_enum_matches_folder_map() -> None:
    """The schema Status enum must match the statuses in our folder-status map."""
    schema = json.loads(_read_text(_SCHEMA_PATH))
    schema_statuses = set(schema["$defs"]["Status"]["enum"])
    assert schema_statuses == _VALID_STATUSES, (
        f"Schema Status enum does not match expected statuses.\n"
        f"  Schema:   {sorted(schema_statuses)}\n"
        f"  Expected: {sorted(_VALID_STATUSES)}"
    )
