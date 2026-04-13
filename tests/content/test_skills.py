"""
test_skills.py — Structural and content checks for deft skill files.

Implementation: IMPLEMENTATION.md Phase 1.3

Verifies:
  - SKILL.md files exist at expected paths
  - Both skill files contain the RFC2119 legend
  - Both skill files contain a Platform Detection section
  - deft-build SKILL.md contains a USER.md Gate section

Author: Scott Adams (msadams) — 2026-03-12
"""

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

SKILL_PATHS = [
    "skills/deft-directive-build/SKILL.md",
    "skills/deft-directive-setup/SKILL.md",
]

RFC2119_LEGEND = "!=MUST, ~=SHOULD"
PLATFORM_DETECTION_HEADING = "## Platform Detection"
USER_MD_GATE_HEADING = "## USER.md Gate"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_skill(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Skill files exist
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_file_exists(rel_path: str) -> None:
    """Each skill SKILL.md must exist at its expected path."""
    assert (_REPO_ROOT / rel_path).is_file(), (
        f"Skill file missing: {rel_path}"
    )


# ---------------------------------------------------------------------------
# 2. RFC2119 legend present in both skill files
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_rfc2119_legend_present(rel_path: str) -> None:
    """Each skill file must contain the RFC2119 legend line."""
    text = _read_skill(rel_path)
    assert RFC2119_LEGEND in text, (
        f"{rel_path}: missing RFC2119 legend '{RFC2119_LEGEND}' — "
        "add the Legend line near the top of the file"
    )


# ---------------------------------------------------------------------------
# 3. Platform Detection section present in both skill files
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_platform_detection_section(rel_path: str) -> None:
    """Each skill file must contain a Platform Detection section."""
    text = _read_skill(rel_path)
    assert PLATFORM_DETECTION_HEADING in text, (
        f"{rel_path}: missing '{PLATFORM_DETECTION_HEADING}' section — "
        "skills must instruct agents to detect OS and resolve USER.md path"
    )


# ---------------------------------------------------------------------------
# 4. Platform Detection covers both Windows and Unix paths
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_platform_detection_covers_windows(rel_path: str) -> None:
    """Platform Detection must reference the Windows APPDATA path."""
    text = _read_skill(rel_path)
    assert "%APPDATA%" in text, (
        f"{rel_path}: Platform Detection must include Windows path "
        r"(%APPDATA%\deft\USER.md)"
    )


@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_platform_detection_covers_unix(rel_path: str) -> None:
    """Platform Detection must reference the Unix ~/.config path."""
    text = _read_skill(rel_path)
    assert "~/.config/deft/USER.md" in text, (
        f"{rel_path}: Platform Detection must include Unix path "
        "(~/.config/deft/USER.md)"
    )


@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_platform_detection_env_override(rel_path: str) -> None:
    """Platform Detection must mention $DEFT_USER_PATH as an override."""
    text = _read_skill(rel_path)
    assert "$DEFT_USER_PATH" in text, (
        f"{rel_path}: Platform Detection must mention $DEFT_USER_PATH "
        "as the override for platform-default paths"
    )


# ---------------------------------------------------------------------------
# 5. USER.md Gate present in deft-build
# ---------------------------------------------------------------------------

def test_deft_directive_build_user_md_gate() -> None:
    """deft-directive-build must contain a USER.md Gate section."""
    rel_path = "skills/deft-directive-build/SKILL.md"
    text = _read_skill(rel_path)
    assert USER_MD_GATE_HEADING in text, (
        f"{rel_path}: missing '{USER_MD_GATE_HEADING}' section -- "
        "deft-directive-build must redirect to deft-directive-setup if USER.md is not found"
    )


def test_deft_directive_build_user_md_gate_redirects_to_deft_setup() -> None:
    """deft-directive-build USER.md Gate must reference deft-directive-setup."""
    rel_path = "skills/deft-directive-build/SKILL.md"
    text = _read_skill(rel_path)
    assert "deft-directive-setup" in text, (
        f"{rel_path}: USER.md Gate must reference deft-directive-setup as the "
        "redirect target when USER.md is not found"
    )


# ---------------------------------------------------------------------------
# 6. deft-setup does NOT have a USER.md Gate (belongs only in deft-build)
# ---------------------------------------------------------------------------

def test_deft_setup_has_no_user_md_gate() -> None:
    """deft-directive-setup must not have a USER.md Gate section (that belongs in deft-build)."""
    rel_path = "skills/deft-directive-setup/SKILL.md"
    text = _read_skill(rel_path)
    assert USER_MD_GATE_HEADING not in text, (
        f"{rel_path}: should not contain '{USER_MD_GATE_HEADING}' — "
        "deft-directive-setup creates USER.md, it doesn't gate on it"
    )


# ---------------------------------------------------------------------------
# 7. Phase 2 inference must not scan ./deft/ for build files (#79, t1.1.1)
# ---------------------------------------------------------------------------

def test_phase2_inference_no_deft_build_files() -> None:
    """Phase 2 Inference must forbid scanning ./deft/ for build files."""
    text = _read_skill("skills/deft-directive-setup/SKILL.md")
    assert "\u2297" in text and "./deft/" in text and "build files" in text.lower(), (
        "skills/deft-directive-setup/SKILL.md: Phase 2 Inference must contain a \u2297 rule "
        "forbidding scanning ./deft/ for build files"
    )


def test_phase2_inference_no_deft_git() -> None:
    """Phase 2 Inference must forbid running git inside ./deft/."""
    text = _read_skill("skills/deft-directive-setup/SKILL.md")
    assert "git" in text.lower() and "./deft/" in text and "framework repo" in text.lower(), (
        "skills/deft-directive-setup/SKILL.md: Phase 2 Inference must contain a \u2297 rule "
        "forbidding git commands inside ./deft/"
    )


# ---------------------------------------------------------------------------
# 8. Phase 2 inference fallback to directory name (#80, t1.1.2)
# ---------------------------------------------------------------------------

def test_phase2_inference_directory_name_fallback() -> None:
    """Phase 2 Inference must fall back to directory name when no build files found."""
    text = _read_skill("skills/deft-directive-setup/SKILL.md")
    assert "directory name" in text.lower() and "no build files" in text.lower(), (
        "skills/deft-directive-setup/SKILL.md: Phase 2 Inference must contain a fallback rule "
        "using the current directory name when no build files are found"
    )


# ---------------------------------------------------------------------------
# 9. USER.md template must not include Primary Languages (#107, t1.1.3)
# ---------------------------------------------------------------------------

def test_user_md_template_no_primary_languages() -> None:
    """USER.md template must not contain a Primary Languages field."""
    text = _read_skill("skills/deft-directive-setup/SKILL.md")
    # The template is between ```markdown and ``` — check the whole file
    assert "**Primary Languages**" not in text, (
        "skills/deft-directive-setup/SKILL.md: USER.md template still contains "
        "**Primary Languages** — language is a project-level concern (#107)"
    )


def test_phase1_track1_no_language_step() -> None:
    """Phase 1 Track 1 must not ask about preferred languages."""
    text = _read_skill("skills/deft-directive-setup/SKILL.md")
    # Track 1 should not have "Ask preferred languages" in its steps
    assert "Ask preferred languages" not in text, (
        "skills/deft-directive-setup/SKILL.md: Phase 1 Track 1 still asks about "
        "preferred languages — removed per #107"
    )


# ---------------------------------------------------------------------------
# 10. Phase 2 Track 1 deployment platform question (#108, t1.1.4)
# ---------------------------------------------------------------------------

def test_phase2_track1_has_deployment_platform() -> None:
    """Phase 2 Track 1 must ask about deployment platform before language."""
    text = _read_skill("skills/deft-directive-setup/SKILL.md")
    assert "deployment platform" in text.lower(), (
        "skills/deft-directive-setup/SKILL.md: Phase 2 Track 1 must ask about "
        "deployment platform (#108)"
    )


def test_phase2_track1_platform_before_language() -> None:
    """Deployment platform question must appear before language question in Track 1."""
    text = _read_skill("skills/deft-directive-setup/SKILL.md")
    platform_pos = text.lower().find("deployment platform")
    # Find the language step that follows platform (Step 4 in Track 1)
    language_pos = text.lower().find("ask languages", platform_pos)
    assert platform_pos != -1 and language_pos != -1 and platform_pos < language_pos, (
        "skills/deft-directive-setup/SKILL.md: deployment platform must appear before "
        "language question in Phase 2 Track 1"
    )


def test_phase2_track1_progressive_other_disclosure() -> None:
    """Phase 2 Track 1 language step must include progressive Other disclosure."""
    text = _read_skill("skills/deft-directive-setup/SKILL.md")
    assert "Tier 2" in text and "Tier 3" in text, (
        "skills/deft-directive-setup/SKILL.md: Phase 2 Track 1 language step must include "
        "progressive Other disclosure (Tier 2, Tier 3)"
    )


def test_phase2_track1_missing_standards_warning() -> None:
    """Phase 2 Track 1 must warn when entered language has no standards file."""
    text = _read_skill("skills/deft-directive-setup/SKILL.md")
    assert "standards file" in text.lower() and "general defaults" in text.lower(), (
        "skills/deft-directive-setup/SKILL.md: Phase 2 Track 1 must warn when entered "
        "language has no deft standards file"
    )


# ---------------------------------------------------------------------------
# 11. task check and task test:coverage referenced in deft-build
# ---------------------------------------------------------------------------

def test_deft_directive_build_references_task_check() -> None:
    """deft-directive-build must reference 'task check' as a quality gate."""
    rel_path = "skills/deft-directive-build/SKILL.md"
    text = _read_skill(rel_path)
    assert "task check" in text, (
        f"{rel_path}: must reference 'task check' -- Taskfile is a hard dependency"
    )


def test_deft_directive_build_references_task_test_coverage() -> None:
    """deft-directive-build must reference 'task test:coverage'."""
    rel_path = "skills/deft-directive-build/SKILL.md"
    text = _read_skill(rel_path)
    assert "task test:coverage" in text, (
        f"{rel_path}: must reference 'task test:coverage' -- Taskfile is a hard dependency"
    )


# ---------------------------------------------------------------------------
# 12. deft-directive-swarm skill — file existence and RFC2119 (#188, #199, #317)
# ---------------------------------------------------------------------------

_SWARM_PATH = "skills/deft-directive-swarm/SKILL.md"


def test_deft_directive_swarm_exists() -> None:
    """deft-directive-swarm SKILL.md must exist at its expected path."""
    assert (_REPO_ROOT / _SWARM_PATH).is_file(), (
        f"Skill file missing: {_SWARM_PATH}"
    )


def test_deft_directive_swarm_rfc2119_legend() -> None:
    """deft-directive-swarm must contain the RFC2119 legend line."""
    text = _read_skill(_SWARM_PATH)
    assert RFC2119_LEGEND in text, (
        f"{_SWARM_PATH}: missing RFC2119 legend '{RFC2119_LEGEND}'"
    )


# ---------------------------------------------------------------------------
# 13. deft-directive-swarm Phase 0 — Allocate (vBRIEF allocation, #199, #317)
# ---------------------------------------------------------------------------

def test_deft_directive_swarm_phase0_allocate_heading() -> None:
    """deft-directive-swarm must contain Phase 0 — Allocate heading."""
    text = _read_skill(_SWARM_PATH)
    assert "## Phase 0" in text and "Allocate" in text, (
        f"{_SWARM_PATH}: missing Phase 0 -- Allocate section (#317)"
    )


def test_deft_directive_swarm_phase0_scans_vbrief_active() -> None:
    """Phase 0 must scan vbrief/active/ for story-level vBRIEFs."""
    text = _read_skill(_SWARM_PATH)
    assert "vbrief/active/" in text and "vbrief.json" in text, (
        f"{_SWARM_PATH}: Phase 0 must scan vbrief/active/ for vBRIEFs (#317)"
    )


def test_deft_directive_swarm_phase0_surfaces_blockers() -> None:
    """Phase 0 must surface blockers."""
    text = _read_skill(_SWARM_PATH)
    assert "blocked" in text.lower() and "incomplete" in text.lower(), (
        f"{_SWARM_PATH}: Phase 0 must surface blockers and incomplete vBRIEFs"
    )


def test_deft_directive_swarm_phase0_approval_gate() -> None:
    """Phase 0 must require explicit user approval before Phase 1."""
    text = _read_skill(_SWARM_PATH)
    assert "yes" in text and "confirmed" in text and "approve" in text, (
        f"{_SWARM_PATH}: Phase 0 must require explicit approval (yes/confirmed/approve)"
    )


def test_deft_directive_swarm_phase0_antipattern() -> None:
    """Anti-patterns must prohibit proceeding to Phase 1 without Phase 0."""
    text = _read_skill(_SWARM_PATH)
    assert "Phase 1 (Select) without completing Phase 0" in text, (
        f"{_SWARM_PATH}: must have anti-pattern against skipping Phase 0"
    )


def test_deft_directive_swarm_flexible_allocation() -> None:
    """Phase 0 must support flexible multi-vBRIEF allocation per agent (#317)."""
    text = _read_skill(_SWARM_PATH)
    assert "no fixed per-agent limit" in text.lower() or "no hardcoded 1:1 rule" in text.lower(), (
        f"{_SWARM_PATH}: Phase 0 must support flexible allocation (no fixed 1:1) (#317)"
    )
    assert "small/independent stories" in text.lower() and "batched" in text.lower(), (
        f"{_SWARM_PATH}: Phase 0 must allow batching small stories (#317)"
    )
    assert "large/complex stories" in text.lower() and "dedicated" in text.lower(), (
        f"{_SWARM_PATH}: Phase 0 must allow dedicated agents for large stories (#317)"
    )


# ---------------------------------------------------------------------------
# 14. deft-directive-swarm Phase 3 — Runtime capability detection (#188, t1.9.3)
# ---------------------------------------------------------------------------

def test_deft_directive_swarm_runtime_start_agent_detection() -> None:
    """Phase 3 must probe for start_agent tool."""
    text = _read_skill(_SWARM_PATH)
    assert "start_agent" in text, (
        f"{_SWARM_PATH}: Phase 3 must probe for start_agent tool (#188)"
    )


def test_deft_directive_swarm_warp_env_detection() -> None:
    """Phase 3 must detect Warp via WARP_* environment variables."""
    text = _read_skill(_SWARM_PATH)
    assert "WARP_*" in text or "WARP_TERMINAL_SESSION" in text, (
        f"{_SWARM_PATH}: Phase 3 must detect Warp via WARP_* env vars (#188)"
    )


def test_deft_directive_swarm_no_static_abc_antipattern() -> None:
    """Anti-patterns must prohibit static A/B/C option presentation."""
    text = _read_skill(_SWARM_PATH)
    assert "static launch options" in text.lower() or "static launch options (A/B/C)" in text, (
        f"{_SWARM_PATH}: must have anti-pattern against static A/B/C options (#188)"
    )


def test_deft_directive_swarm_cloud_escape_hatch_only() -> None:
    """Cloud launch (oz agent run-cloud) must be explicit user request only."""
    text = _read_skill(_SWARM_PATH)
    assert "explicit" in text.lower() and "user" in text.lower() and "run-cloud" in text, (
        f"{_SWARM_PATH}: oz agent run-cloud must be explicit user-requested escape hatch only"
    )


# ---------------------------------------------------------------------------
# 15. deft-directive-swarm Phase 6 — Close-out orchestration rules (#206, t2.6.3)
# ---------------------------------------------------------------------------

def test_deft_directive_swarm_phase6_merge_authority() -> None:
    """Phase 6 must contain merge authority rule."""
    text = _read_skill(_SWARM_PATH)
    assert "Merge authority" in text and "user approves" in text, (
        f"{_SWARM_PATH}: Phase 6 must contain merge authority rule (#206)"
    )


def test_deft_directive_swarm_phase6_rebase_ownership() -> None:
    """Phase 6 must assign rebase cascade ownership to monitor."""
    text = _read_skill(_SWARM_PATH)
    assert "Rebase cascade ownership" in text and "Monitor owns" in text, (
        f"{_SWARM_PATH}: Phase 6 must assign rebase ownership to monitor (#206)"
    )


def test_deft_directive_swarm_phase6_git_editor() -> None:
    """Phase 6 must document GIT_EDITOR override for non-interactive rebase."""
    text = _read_skill(_SWARM_PATH)
    assert "GIT_EDITOR" in text, (
        f"{_SWARM_PATH}: Phase 6 must document GIT_EDITOR override (#206)"
    )


def test_deft_directive_swarm_phase6_post_merge_verification() -> None:
    """Phase 6 must verify issues closed after squash merge."""
    text = _read_skill(_SWARM_PATH)
    assert "verify issues actually closed" in text, (
        f"{_SWARM_PATH}: Phase 6 must include post-merge issue verification (#206)"
    )


def test_deft_directive_swarm_push_autonomy() -> None:
    """Swarm skill must contain push autonomy carve-out."""
    text = _read_skill(_SWARM_PATH)
    assert "Push Autonomy" in text and "task check" in text.lower(), (
        f"{_SWARM_PATH}: must contain push autonomy carve-out section (#206)"
    )


# ---------------------------------------------------------------------------
# 16. deft-directive-swarm Phase 5→6 gate — release decision checkpoint (#218, t1.10.2)
# ---------------------------------------------------------------------------


def test_deft_directive_swarm_phase5_6_gate_heading() -> None:
    """deft-directive-swarm must contain Phase 5→6 gate section."""
    text = _read_skill(_SWARM_PATH)
    assert "Phase 5\u21926 Gate" in text, (
        f"{_SWARM_PATH}: missing Phase 5\u21926 gate section (#218)"
    )


def test_deft_directive_swarm_phase5_6_version_bump_approval() -> None:
    """Phase 5→6 gate must require explicit user approval."""
    text = _read_skill(_SWARM_PATH)
    assert "version bump" in text.lower() and "confirmed" in text, (
        f"{_SWARM_PATH}: Phase 5→6 gate must require explicit approval (#218)"
    )


def test_deft_directive_swarm_greptile_rebase_latency() -> None:
    """Phase 6 must document Greptile re-review latency on force-push rebase."""
    text = _read_skill(_SWARM_PATH)
    assert "Greptile re-review" in text and "2-5" in text, (
        f"{_SWARM_PATH}: Phase 6 must document Greptile re-review latency (#207)"
    )


# ---------------------------------------------------------------------------
# 17. deft-review-cycle MCP fallback (#206, t2.6.3)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 18. deft-directive-sync skill -- existence, structure, and content
#     (#146, t2.7.5; #318, vBRIEF cutover rename + rewrite)
# ---------------------------------------------------------------------------

_SYNC_PATH = "skills/deft-directive-sync/SKILL.md"
_SYNC_POINTER_PATH = ".agents/skills/deft-directive-sync/SKILL.md"


def test_deft_directive_sync_exists() -> None:
    """deft-directive-sync SKILL.md must exist at its expected path."""
    assert (_REPO_ROOT / _SYNC_PATH).is_file(), (
        f"Skill file missing: {_SYNC_PATH}"
    )


def test_deft_directive_sync_rfc2119_legend() -> None:
    """deft-directive-sync must contain the RFC2119 legend line."""
    text = _read_skill(_SYNC_PATH)
    assert RFC2119_LEGEND in text, (
        f"{_SYNC_PATH}: missing RFC2119 legend '{RFC2119_LEGEND}'"
    )


def test_deft_directive_sync_has_frontmatter() -> None:
    """deft-directive-sync must have YAML frontmatter with name field."""
    text = _read_skill(_SYNC_PATH)
    assert text.startswith("---"), (
        f"{_SYNC_PATH}: must start with YAML frontmatter '---'"
    )
    assert "name: deft-directive-sync" in text, (
        f"{_SYNC_PATH}: frontmatter must contain 'name: deft-directive-sync'"
    )


def test_deft_directive_sync_anti_patterns_section() -> None:
    """deft-directive-sync must have an Anti-Patterns section with required entries."""
    text = _read_skill(_SYNC_PATH)
    assert "## Anti-Patterns" in text, (
        f"{_SYNC_PATH}: missing '## Anti-Patterns' section"
    )
    assert "\u2297" in text and "auto-commit" in text.lower(), (
        f"{_SYNC_PATH}: Anti-Patterns must prohibit auto-committing submodule changes"
    )


def test_deft_directive_sync_preflight_dirty_check() -> None:
    """deft-directive-sync must include pre-flight dirty check on deft/ submodule."""
    text = _read_skill(_SYNC_PATH)
    assert "git -C deft status --porcelain" in text, (
        f"{_SYNC_PATH}: must include pre-flight dirty check command"
    )


def test_deft_directive_sync_no_upstream_vbrief_fetch() -> None:
    """deft-directive-sync must NOT include upstream vBRIEF schema fetch (#128)."""
    text = _read_skill(_SYNC_PATH)
    assert "\u2297" in text and "#128" in text, (
        f"{_SYNC_PATH}: must explicitly prohibit upstream vBRIEF schema fetch (CI concern per #128)"
    )


def test_deft_directive_sync_pointer_exists() -> None:
    """.agents thin pointer for deft-directive-sync must exist."""
    assert (_REPO_ROOT / _SYNC_POINTER_PATH).is_file(), (
        f"Thin pointer missing: {_SYNC_POINTER_PATH}"
    )

_REVIEW_CYCLE_PATH = "skills/deft-directive-review-cycle/SKILL.md"

def test_deft_directive_sync_lifecycle_folder_validation() -> None:
    """deft-directive-sync must validate lifecycle folder structure."""
    text = _read_skill(_SYNC_PATH)
    assert "proposed/" in text and "pending/" in text and "active/" in text, (
        f"{_SYNC_PATH}: must validate lifecycle folders (proposed/, pending/, active/)"
    )
    assert "completed/" in text and "cancelled/" in text, (
        f"{_SYNC_PATH}: must validate lifecycle folders (completed/, cancelled/)"
    )


def test_deft_directive_sync_project_definition_validation() -> None:
    """deft-directive-sync must validate PROJECT-DEFINITION.vbrief.json."""
    text = _read_skill(_SYNC_PATH)
    assert "PROJECT-DEFINITION.vbrief.json" in text, (
        f"{_SYNC_PATH}: must validate PROJECT-DEFINITION.vbrief.json"
    )
    assert "vBRIEFInfo" in text and '"0.5"' in text, (
        f"{_SYNC_PATH}: must validate vBRIEF v0.5 schema conformance"
    )


def test_deft_directive_sync_project_definition_freshness() -> None:
    """deft-directive-sync must check PROJECT-DEFINITION freshness."""
    text = _read_skill(_SYNC_PATH)
    assert "freshness check" in text.lower() and "stale" in text.lower(), (
        f"{_SYNC_PATH}: must include PROJECT-DEFINITION freshness check"
    )


def test_deft_directive_sync_lifecycle_consistency() -> None:
    """deft-directive-sync must check status/folder consistency."""
    text = _read_skill(_SYNC_PATH)
    assert "Lifecycle Consistency" in text, (
        f"{_SYNC_PATH}: must have Lifecycle Consistency section"
    )
    assert "MISMATCH" in text and "plan.status" in text, (
        f"{_SYNC_PATH}: must report status/folder mismatches"
    )


def test_deft_directive_sync_origin_freshness() -> None:
    """deft-directive-sync must check origin freshness (RFC D12)."""
    text = _read_skill(_SYNC_PATH)
    assert "Origin Freshness" in text and "D12" in text, (
        f"{_SYNC_PATH}: must have Origin Freshness section referencing RFC D12"
    )
    assert "updatedAt" in text and "github-issue" in text, (
        f"{_SYNC_PATH}: must compare issue updatedAt against vBRIEF timestamp"
    )


def test_deft_directive_sync_origin_freshness_report_only() -> None:
    """Origin freshness must report only -- never auto-update."""
    text = _read_skill(_SYNC_PATH)
    assert "report only" in text.lower() and "never auto-update" in text.lower(), (
        f"{_SYNC_PATH}: origin freshness must report only, never auto-update"
    )


def test_deft_directive_sync_externally_closed_origins() -> None:
    """deft-directive-sync must flag externally-closed origins."""
    text = _read_skill(_SYNC_PATH)
    assert "externally closed" in text.lower() and "CLOSED" in text, (
        f"{_SYNC_PATH}: must flag externally-closed origins"
    )


def test_deft_directive_sync_no_old_name_references() -> None:
    """deft-directive-sync must not reference old deft-sync name in paths."""
    text = _read_skill(_SYNC_PATH)
    # Check that old skill path pattern doesn't appear
    assert "skills/deft-sync/" not in text, (
        f"{_SYNC_PATH}: must not reference old 'skills/deft-sync/' path"
    )



def test_deft_review_cycle_mcp_fallback() -> None:
    """Review cycle skill must document MCP fallback (gh-only when MCP unavailable)."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    assert "MCP is unavailable" in text and "gh" in text, (
        f"{_REVIEW_CYCLE_PATH}: must document MCP fallback for start_agent/cloud agents (#206)"
    )


# ---------------------------------------------------------------------------
# 21. deft-directive-refinement skill -- existence and RFC2119
#     (#316, vBRIEF cutover rename + rewrite from deft-roadmap-refresh)
# ---------------------------------------------------------------------------

_REFINEMENT_PATH = "skills/deft-directive-refinement/SKILL.md"
_REFINEMENT_POINTER_PATH = ".agents/skills/deft-directive-refinement/SKILL.md"


def test_deft_directive_refinement_exists() -> None:
    """deft-directive-refinement SKILL.md must exist."""
    assert (_REPO_ROOT / _REFINEMENT_PATH).is_file(), (
        f"Skill file missing: {_REFINEMENT_PATH}"
    )


def test_deft_directive_refinement_rfc2119_legend() -> None:
    """deft-directive-refinement must contain the RFC2119 legend."""
    text = _read_skill(_REFINEMENT_PATH)
    assert RFC2119_LEGEND in text, (
        f"{_REFINEMENT_PATH}: missing RFC2119 legend"
    )


# ---------------------------------------------------------------------------
# 22. deft-directive-refinement -- frontmatter and session model (#316)
# ---------------------------------------------------------------------------

def test_deft_directive_refinement_has_frontmatter() -> None:
    """deft-directive-refinement must have correct frontmatter name."""
    text = _read_skill(_REFINEMENT_PATH)
    assert text.startswith("---"), (
        f"{_REFINEMENT_PATH}: must start with YAML frontmatter '---'"
    )
    assert "name: deft-directive-refinement" in text, (
        f"{_REFINEMENT_PATH}: frontmatter must contain 'name: deft-directive-refinement'"
    )


def test_deft_directive_refinement_session_model() -> None:
    """deft-directive-refinement must describe a conversational session model."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "conversational loop" in text.lower() and "batch job" in text.lower(), (
        f"{_REFINEMENT_PATH}: must describe conversational (not batch) session model (#316)"
    )


# ---------------------------------------------------------------------------
# 23. deft-directive-refinement phases (#316)
# ---------------------------------------------------------------------------

def test_deft_directive_refinement_ingest_phase() -> None:
    """deft-directive-refinement must have an Ingest phase with deduplication."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "## Phase 1 -- Ingest" in text, (
        f"{_REFINEMENT_PATH}: must have Phase 1 -- Ingest (#316)"
    )
    assert "Deduplicate" in text and "references" in text, (
        f"{_REFINEMENT_PATH}: Ingest must deduplicate via references (#316)"
    )


def test_deft_directive_refinement_ingest_origin_provenance() -> None:
    """Ingest must create vBRIEFs with origin provenance."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "github-issue" in text and "YYYY-MM-DD" in text, (
        f"{_REFINEMENT_PATH}: Ingest must create proposed/ vBRIEFs with origin provenance (#316)"
    )


def test_deft_directive_refinement_evaluate_phase() -> None:
    """deft-directive-refinement must have an Evaluate phase with user review."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "## Phase 2 -- Evaluate" in text, (
        f"{_REFINEMENT_PATH}: must have Phase 2 -- Evaluate (#316)"
    )
    assert "Interactive Review" in text, (
        f"{_REFINEMENT_PATH}: Evaluate must include interactive user review (#316)"
    )


def test_deft_directive_refinement_reconcile_phase() -> None:
    """deft-directive-refinement must have a Reconcile phase (RFC D12)."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "## Phase 3 -- Reconcile" in text and "D12" in text, (
        f"{_REFINEMENT_PATH}: must have Phase 3 -- Reconcile referencing RFC D12 (#316)"
    )
    assert "never auto-update" in text.lower(), (
        f"{_REFINEMENT_PATH}: Reconcile must never auto-update vBRIEFs (#316)"
    )


def test_deft_directive_refinement_promote_demote_phase() -> None:
    """deft-directive-refinement must use deterministic task commands for lifecycle."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "## Phase 4 -- Promote/Demote" in text, (
        f"{_REFINEMENT_PATH}: must have Phase 4 -- Promote/Demote (#316)"
    )
    assert "task scope:promote" in text and "task scope:activate" in text, (
        f"{_REFINEMENT_PATH}: must use deterministic task commands (#316)"
    )


def test_deft_directive_refinement_prioritize_phase() -> None:
    """deft-directive-refinement must have a Prioritize phase with roadmap render."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "## Phase 5 -- Prioritize" in text, (
        f"{_REFINEMENT_PATH}: must have Phase 5 -- Prioritize (#316)"
    )
    assert "task roadmap:render" in text, (
        f"{_REFINEMENT_PATH}: Prioritize must call task roadmap:render (#316)"
    )


def test_deft_directive_refinement_completion_lifecycle() -> None:
    """deft-directive-refinement must have a completion lifecycle phase."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "Completion Lifecycle" in text, (
        f"{_REFINEMENT_PATH}: must have Completion Lifecycle section (#316)"
    )
    assert "gh issue close" in text, (
        f"{_REFINEMENT_PATH}: completion must update origins (close issues) (#316)"
    )


def test_deft_directive_refinement_pr_review_cycle() -> None:
    """deft-directive-refinement must have PR & Review Cycle section."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "## PR & Review Cycle" in text, (
        f"{_REFINEMENT_PATH}: must have PR & Review Cycle section"
    )
    assert "Ready to commit and create a PR?" in text, (
        f"{_REFINEMENT_PATH}: must ask user confirmation before PR"
    )
    assert "task check" in text, (
        f"{_REFINEMENT_PATH}: PR pre-flight must run task check"
    )


def test_deft_directive_refinement_review_cycle_handoff() -> None:
    """deft-directive-refinement must hand off to deft-directive-review-cycle."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "skills/deft-directive-review-cycle/SKILL.md" in text, (
        f"{_REFINEMENT_PATH}: must hand off to deft-review-cycle"
    )


def test_deft_directive_refinement_exit_block() -> None:
    """deft-directive-refinement must have an EXIT block."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "### EXIT" in text, (
        f"{_REFINEMENT_PATH}: missing EXIT block"
    )
    assert "exiting skill" in text.lower(), (
        f"{_REFINEMENT_PATH}: EXIT block must contain 'exiting skill' confirmation"
    )
    assert "chaining instructions" in text.lower(), (
        f"{_REFINEMENT_PATH}: EXIT block must provide chaining instructions"
    )


def test_deft_directive_refinement_batch_changelog_rule() -> None:
    """deft-directive-refinement must require one batch CHANGELOG entry."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "batch" in text.lower() and "end of the full refinement session" in text.lower(), (
        f"{_REFINEMENT_PATH}: must require batch CHANGELOG entry"
    )


def test_deft_directive_refinement_precommit_file_review() -> None:
    """PR pre-flight must include mandatory file review."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "encoding errors" in text.lower() and "unintended duplication" in text.lower(), (
        f"{_REFINEMENT_PATH}: must include mandatory pre-commit file review"
    )


def test_deft_directive_refinement_anti_patterns() -> None:
    """deft-directive-refinement must have comprehensive anti-patterns."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "## Anti-Patterns" in text, (
        f"{_REFINEMENT_PATH}: missing Anti-Patterns section"
    )
    assert "auto-push" in text.lower() and "deduplicat" in text.lower(), (
        f"{_REFINEMENT_PATH}: anti-patterns must cover auto-push and deduplication"
    )


def test_deft_directive_refinement_pointer_exists() -> None:
    """.agents thin pointer for deft-directive-refinement must exist."""
    assert (_REPO_ROOT / _REFINEMENT_POINTER_PATH).is_file(), (
        f"Thin pointer missing: {_REFINEMENT_POINTER_PATH}"
    )


def test_deft_directive_refinement_no_old_name_references() -> None:
    """deft-directive-refinement must not reference old deft-roadmap-refresh name."""
    text = _read_skill(_REFINEMENT_PATH)
    assert "deft-roadmap-refresh" not in text, (
        f"{_REFINEMENT_PATH}: must not reference old 'deft-roadmap-refresh' name"
    )


# ---------------------------------------------------------------------------
# 22. deft-review-cycle tiered monitoring (#195, t2.7.4)
# ---------------------------------------------------------------------------


def test_deft_review_cycle_tiered_monitoring_heading() -> None:
    """Review cycle skill must contain a Review Monitoring subsection."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    assert "### Review Monitoring" in text, (
        f"{_REVIEW_CYCLE_PATH}: missing '### Review Monitoring' subsection (#195)"
    )


def test_deft_review_cycle_start_agent_approach() -> None:
    """Review cycle must document start_agent sub-agent as preferred monitoring approach."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    assert "start_agent" in text and "sub-agent" in text.lower(), (
        f"{_REVIEW_CYCLE_PATH}: must document start_agent sub-agent monitoring (#195)"
    )


def test_deft_review_cycle_fallback_approach() -> None:
    """Review cycle must document tool-call polling fallback when start_agent unavailable."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    assert "run_shell_command" in text and "yield" in text.lower(), (
        f"{_REVIEW_CYCLE_PATH}: must document run_shell_command + yield fallback (#195)"
    )


def test_deft_review_cycle_no_blocking_sleep() -> None:
    """Review cycle must not recommend Start-Sleep or time.sleep for polling delays."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    # The text may mention Start-Sleep in a prohibition context only
    lines = text.split("\n")
    for line in lines:
        if "Start-Sleep" in line or "time.sleep" in line:
            # These should only appear in prohibition lines (containing the ⊗ marker)
            assert "\u2297" in line, (
                f"{_REVIEW_CYCLE_PATH}: Start-Sleep/time.sleep must only appear "
                f"in prohibition rules, found in: {line.strip()!r}"
            )


def test_deft_review_cycle_capability_detection() -> None:
    """Review cycle must use capability detection to select monitoring approach."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    assert "capability detection" in text.lower() and "start_agent" in text, (
        f"{_REVIEW_CYCLE_PATH}: must use capability detection to select approach (#195)"
    )


def test_deft_review_cycle_send_message() -> None:
    """Start_agent approach must use send_message_to_agent for completion notification."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    assert "send_message_to_agent" in text, (
        f"{_REVIEW_CYCLE_PATH}: start_agent approach must use send_message_to_agent (#195)"
    )


# ---------------------------------------------------------------------------
# 23-25: deft-directive-refinement consolidated tests
#        (replaces old deft-roadmap-refresh sections 23-25)
#        Tests covered inline in sections 19-20 above.
# ---------------------------------------------------------------------------


def test_deft_directive_build_precommit_file_review() -> None:
    """deft-directive-build must include mandatory pre-commit file review step."""
    text = _read_skill("skills/deft-directive-build/SKILL.md")
    assert "encoding errors" in text.lower() and "unintended duplication" in text.lower(), (
        "skills/deft-directive-build/SKILL.md: missing pre-commit file review step (#239, t1.11.4)"
    )


# ---------------------------------------------------------------------------
# 26. deft-review-cycle batch-fix enforcement (#250, t1.12.2)
# ---------------------------------------------------------------------------


def test_deft_review_cycle_precommit_gate() -> None:
    """Phase 2 Step 3 must require full review re-read before committing."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    assert "re-read the full current greptile review" in text.lower(), (
        f"{_REVIEW_CYCLE_PATH}: Step 3 must have pre-commit gate requiring "
        "full review re-read (#250, t1.12.2)"
    )


def test_deft_review_cycle_partial_fix_antipattern() -> None:
    """Anti-patterns must prohibit fix commits addressing fewer findings than review surfaces."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    assert "fewer findings than the current greptile review surfaces" in text.lower(), (
        f"{_REVIEW_CYCLE_PATH}: must have anti-pattern against partial fix commits (#250, t1.12.2)"
    )


def test_deft_review_cycle_unchecked_p1_antipattern() -> None:
    """Anti-patterns must prohibit pushing after fixing P1 without checking for more findings."""
    text = _read_skill(_REVIEW_CYCLE_PATH)
    assert "push after fixing a p1 without first checking" in text.lower(), (
        f"{_REVIEW_CYCLE_PATH}: must have anti-pattern against unchecked P1 fix (#250, t1.12.2)"
    )


# ---------------------------------------------------------------------------
# 27. Semantic contradiction check in deft-build and deft-pre-pr (#251, t1.12.3)
# ---------------------------------------------------------------------------

_PRE_PR_PATH = "skills/deft-directive-pre-pr/SKILL.md"


def test_deft_directive_build_semantic_contradiction_rule() -> None:
    """deft-directive-build must require contradiction scan for !/\u2297 rules."""
    text = _read_skill("skills/deft-directive-build/SKILL.md")
    assert "semantic contradictions" in text.lower(), (
        "skills/deft-directive-build/SKILL.md: "
        "missing semantic contradiction check rule (#251, t1.12.3)"
    )


def test_deft_directive_build_strength_duplicate_rule() -> None:
    """deft-directive-build must require strength-duplicate check."""
    text = _read_skill("skills/deft-directive-build/SKILL.md")
    assert (
        "strength duplicates" in text.lower()
        and "weaker-strength duplicate" in text.lower()
    ), (
        "skills/deft-directive-build/SKILL.md: "
        "missing strength-duplicate check (#251, t1.12.3)"
    )


def test_deft_directive_build_contradiction_antipattern() -> None:
    """deft-directive-build must prohibit adding prohibition without scanning."""
    text = _read_skill("skills/deft-directive-build/SKILL.md")
    assert (
        "prohibition" in text.lower()
        and "softer-strength" in text.lower()
    ), (
        "skills/deft-directive-build/SKILL.md: "
        "missing contradiction anti-pattern (#251, t1.12.3)"
    )


def test_deft_pre_pr_semantic_contradiction_rule() -> None:
    """deft-pre-pr Read phase must require contradiction scan for !/\u2297 rules."""
    text = _read_skill(_PRE_PR_PATH)
    lower = text.lower()
    assert "prohibits a specific command" in lower and "resolve all contradictions" in lower, (
        f"{_PRE_PR_PATH}: missing semantic contradiction check rule (#251, t1.12.3)"
    )


def test_deft_pre_pr_strength_duplicate_rule() -> None:
    """deft-pre-pr Read phase must require strength-duplicate check."""
    text = _read_skill(_PRE_PR_PATH)
    assert "strengthening a rule" in text.lower() and "weaker-strength duplicate" in text.lower(), (
        f"{_PRE_PR_PATH}: missing strength-duplicate check rule (#251, t1.12.3)"
    )


def test_deft_pre_pr_contradiction_antipattern() -> None:
    """deft-pre-pr anti-patterns must prohibit adding prohibition without scanning for conflicts."""
    text = _read_skill(_PRE_PR_PATH)
    assert "prohibition" in text.lower() and "softer-strength" in text.lower(), (
        f"{_PRE_PR_PATH}: missing contradiction anti-pattern (#251, t1.12.3)"
    )


# ---------------------------------------------------------------------------
# 28. deft-directive-swarm Phase 5->6 gate hardening + crash recovery (#261, #263, t1.13.1)
# ---------------------------------------------------------------------------


def test_deft_directive_swarm_phase5_6_context_pressure_callout() -> None:
    """Phase 5->6 gate must contain explicit context-pressure bypass prohibition."""
    text = _read_skill(_SWARM_PATH)
    assert "context-pressure bypass prohibition" in text.lower(), (
        f"{_SWARM_PATH}: Phase 5->6 gate missing context-pressure callout (#261, t1.13.1)"
    )


def test_deft_directive_swarm_takeover_prespawn_verification() -> None:
    """Takeover Triggers must require pre-spawn verification via lifecycle events."""
    text = _read_skill(_SWARM_PATH)
    assert "pre-spawn verification" in text.lower() and "lifecycle event" in text.lower(), (
        f"{_SWARM_PATH}: Takeover Triggers missing pre-spawn verification rule (#261, t1.13.1)"
    )


def test_deft_directive_swarm_duplicate_tab_failure_mode() -> None:
    """deft-directive-swarm must document the duplicate-tab failure mode."""
    text = _read_skill(_SWARM_PATH)
    assert "Duplicate-Tab Failure Mode" in text and "tool_use" in text and "tool_result" in text, (
        f"{_SWARM_PATH}: missing Duplicate-Tab Failure Mode documentation (#261, t1.13.1)"
    )


def test_deft_directive_swarm_context_length_warning() -> None:
    """Phase 4 must contain context-length warning about long monitoring sessions."""
    text = _read_skill(_SWARM_PATH)
    assert "Context-Length Warning" in text and "conversation corruption" in text.lower(), (
        f"{_SWARM_PATH}: Phase 4 missing context-length warning (#263, t1.13.1)"
    )


def test_deft_directive_swarm_crash_recovery_section() -> None:
    """deft-directive-swarm must contain a Crash Recovery section with recovery steps."""
    text = _read_skill(_SWARM_PATH)
    assert "## Crash Recovery" in text and "gh pr list" in text and "gh pr view" in text, (
        f"{_SWARM_PATH}: missing Crash Recovery section (#263, t1.13.1)"
    )


def test_deft_directive_swarm_antipattern_no_spawn_without_lifecycle() -> None:
    """Anti-patterns must prohibit spawning replacement without lifecycle confirmation."""
    text = _read_skill(_SWARM_PATH)
    assert "spawn a replacement sub-agent without confirming" in text.lower(), (
        f"{_SWARM_PATH}: missing anti-pattern against spawning "
        "without lifecycle check (#261, t1.13.1)"
    )


def test_deft_directive_swarm_antipattern_no_skip_phase5_gate() -> None:
    """Anti-patterns must prohibit skipping Phase 5 gate under pressure."""
    text = _read_skill(_SWARM_PATH)
    lower = text.lower()
    assert "skip phase 5" in lower and "time pressure" in lower and "long context" in lower, (
        f"{_SWARM_PATH}: missing anti-pattern against skipping "
        "Phase 5 gate under pressure (#261, t1.13.1)"
    )


# ---------------------------------------------------------------------------
# 29. deft-setup USER.md/PROJECT.md deft_version field (#270, t3.2.1)
# ---------------------------------------------------------------------------

_SETUP_PATH = "skills/deft-directive-setup/SKILL.md"


def test_deft_setup_user_md_template_has_deft_version() -> None:
    """USER.md template in deft-setup must contain a deft_version field."""
    text = _read_skill(_SETUP_PATH)
    # The template is inside a ```markdown code block in Phase 1
    assert "**deft_version**:" in text, (
        f"{_SETUP_PATH}: USER.md template must include a deft_version field (#270, t3.2.1)"
    )


def test_deft_setup_project_definition_template_has_deft_version() -> None:
    """PROJECT-DEFINITION.vbrief.json template in deft-directive-setup must contain DeftVersion."""
    text = _read_skill(_SETUP_PATH)
    # USER.md template has **deft_version**: and PROJECT-DEFINITION template has "DeftVersion"
    assert "**deft_version**:" in text, (
        f"{_SETUP_PATH}: USER.md template must include deft_version field (#270, t3.2.1)"
    )
    assert '"DeftVersion"' in text, (
        f"{_SETUP_PATH}: PROJECT-DEFINITION.vbrief.json template must include "
        f"DeftVersion narrative key (#270, t3.2.1)"
    )


def test_deft_setup_stale_user_md_detection() -> None:
    """deft-setup must contain stale USER.md detection via deft_version field."""
    text = _read_skill(_SETUP_PATH)
    lower = text.lower()
    assert "freshness detection" in lower, (
        f"{_SETUP_PATH}: must contain USER.md Freshness Detection section (#270, t3.2.1)"
    )
    assert "predates versioning" in lower and "treat as stale" in lower, (
        f"{_SETUP_PATH}: must detect missing deft_version as stale (#270, t3.2.1)"
    )
    assert "query missing fields individually" in lower, (
        f"{_SETUP_PATH}: must query missing fields individually, "
        "not re-run full interview (#270, t3.2.1)"
    )


def test_deft_setup_deft_version_must_rule() -> None:
    """deft-setup must have a ! rule requiring deft_version on generate/update."""
    text = _read_skill(_SETUP_PATH)
    assert "deft_version` field MUST be set" in text, (
        f"{_SETUP_PATH}: must have ! rule requiring deft_version field "
        "when generating or updating USER.md/PROJECT.md (#270, t3.2.1)"
    )
    assert "\u2297" in text and "without including the `deft_version` field" in text, (
        f"{_SETUP_PATH}: must have \u2297 anti-pattern against omitting deft_version (#270, t3.2.1)"
    )


# ---------------------------------------------------------------------------
# 30. deft-interview skill -- existence, structure, and content (#296, t2.11.1)
# ---------------------------------------------------------------------------

_INTERVIEW_PATH = "skills/deft-directive-interview/SKILL.md"
_INTERVIEW_POINTER_PATH = ".agents/skills/deft-directive-interview/SKILL.md"


def test_deft_interview_exists() -> None:
    """deft-interview SKILL.md must exist at its expected path."""
    assert (_REPO_ROOT / _INTERVIEW_PATH).is_file(), (
        f"Skill file missing: {_INTERVIEW_PATH}"
    )


def test_deft_interview_rfc2119_legend() -> None:
    """deft-interview must contain the RFC2119 legend line."""
    text = _read_skill(_INTERVIEW_PATH)
    assert RFC2119_LEGEND in text, (
        f"{_INTERVIEW_PATH}: missing RFC2119 legend '{RFC2119_LEGEND}'"
    )


def test_deft_interview_has_frontmatter() -> None:
    """deft-directive-interview must have YAML frontmatter with name and description."""
    text = _read_skill(_INTERVIEW_PATH)
    assert text.startswith("---"), (
        f"{_INTERVIEW_PATH}: must start with YAML frontmatter '---'"
    )
    assert "name: deft-directive-interview" in text, (
        f"{_INTERVIEW_PATH}: frontmatter must contain 'name: deft-directive-interview'"
    )


def test_deft_interview_one_question_per_turn() -> None:
    """deft-interview must enforce one-question-per-turn rule."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "ONE focused question per step" in text, (
        f"{_INTERVIEW_PATH}: must contain one-question-per-turn rule (#296)"
    )


def test_deft_interview_numbered_options_with_default() -> None:
    """deft-interview must require numbered options with stated default."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "[default:" in text and "numbered answer options" in text.lower(), (
        f"{_INTERVIEW_PATH}: must require numbered options with stated default (#296)"
    )


def test_deft_interview_other_escape() -> None:
    """deft-interview must require an other/IDK escape option."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "Other / I don't know" in text, (
        f"{_INTERVIEW_PATH}: must require other/IDK escape option (#296)"
    )


def test_deft_interview_depth_gate() -> None:
    """deft-interview must include a depth gate rule."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "no material ambiguity remains" in text.lower(), (
        f"{_INTERVIEW_PATH}: must include depth gate rule (#296)"
    )


def test_deft_interview_default_acceptance() -> None:
    """deft-interview must define default acceptance responses."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "bare enter" in text.lower() and "default" in text.lower(), (
        f"{_INTERVIEW_PATH}: must define default acceptance responses (#296)"
    )


def test_deft_interview_confirmation_gate() -> None:
    """deft-interview must require confirmation gate with all captured answers."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "confirmation gate" in text.lower() and "yes / no" in text.lower(), (
        f"{_INTERVIEW_PATH}: must require confirmation gate (#296)"
    )


def test_deft_interview_structured_handoff() -> None:
    """deft-interview must define structured handoff contract with answers map."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "answers map" in text.lower() and "calling skill" in text.lower(), (
        f"{_INTERVIEW_PATH}: must define structured handoff contract (#296)"
    )


def test_deft_interview_anti_patterns() -> None:
    """deft-interview must have anti-patterns section."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "## Anti-Patterns" in text, (
        f"{_INTERVIEW_PATH}: missing '## Anti-Patterns' section (#296)"
    )
    assert "multiple questions" in text.lower() and "confirmation gate" in text.lower(), (
        f"{_INTERVIEW_PATH}: anti-patterns must cover multi-question and confirmation gate (#296)"
    )


def test_deft_interview_pointer_exists() -> None:
    """.agents thin pointer for deft-interview must exist."""
    assert (_REPO_ROOT / _INTERVIEW_POINTER_PATH).is_file(), (
        f"Thin pointer missing: {_INTERVIEW_POINTER_PATH}"
    )


# ---------------------------------------------------------------------------
# 31. deft-setup Phase 1/2 must reference deft-interview (#304, t1.29.1)
# ---------------------------------------------------------------------------


def test_deft_setup_phase1_references_deft_directive_interview() -> None:
    """deft-directive-setup Phase 1 Interview Rules must reference deft-directive-interview."""
    text = _read_skill(_SETUP_PATH)
    phase1_start = text.find("## Phase 1")
    phase2_start = text.find("## Phase 2")
    assert phase1_start != -1 and phase2_start != -1, (
        f"{_SETUP_PATH}: must contain Phase 1 and Phase 2 sections"
    )
    phase1_text = text[phase1_start:phase2_start]
    assert "deft-directive-interview" in phase1_text, (
        f"{_SETUP_PATH}: Phase 1 must reference deft-directive-interview (#304)"
    )


def test_deft_setup_phase2_references_deft_directive_interview() -> None:
    """deft-directive-setup Phase 2 Interview Rules must reference deft-directive-interview."""
    text = _read_skill(_SETUP_PATH)
    phase2_start = text.find("## Phase 2")
    phase3_start = text.find("## Phase 3")
    assert phase2_start != -1 and phase3_start != -1, (
        f"{_SETUP_PATH}: must contain Phase 2 and Phase 3 sections"
    )
    phase2_text = text[phase2_start:phase3_start]
    assert "deft-directive-interview" in phase2_text, (
        f"{_SETUP_PATH}: Phase 2 must reference deft-directive-interview (#304)"
    )


# ---------------------------------------------------------------------------
# 32. deft-directive-swarm Phase 6 read-back verification (#288, t1.21.1)
# ---------------------------------------------------------------------------


def test_deft_directive_swarm_phase6_readback_verification() -> None:
    """Phase 6 must require re-reading conflict-resolved files before git add."""
    text = _read_skill(_SWARM_PATH)
    assert "Read-back verification" in text and "conflict markers" in text.lower(), (
        f"{_SWARM_PATH}: Phase 6 must contain read-back verification rule (#288)"
    )


def test_deft_directive_swarm_phase6_prefer_edit_files_for_conflicts() -> None:
    """Phase 6 must prefer edit_files over shell regex for conflict resolution."""
    text = _read_skill(_SWARM_PATH)
    assert "edit_files" in text and "CHANGELOG.md" in text, (
        f"{_SWARM_PATH}: Phase 6 must prefer edit_files for conflict resolution (#288)"
    )


# ---------------------------------------------------------------------------
# 33. deft-directive-swarm Phase 6 Slack announcement (#292, t1.22.1)
# ---------------------------------------------------------------------------


def test_deft_directive_swarm_phase6_slack_announcement_step() -> None:
    """Phase 6 Step 5 must generate a Slack release announcement block."""
    text = _read_skill(_SWARM_PATH)
    assert "Slack" in text and "announcement" in text.lower(), (
        f"{_SWARM_PATH}: Phase 6 must include Slack announcement step (#292)"
    )


def test_deft_directive_swarm_phase6_slack_required_fields() -> None:
    """Slack announcement must include version, key changes, PR numbers, and release URL."""
    text = _read_skill(_SWARM_PATH)
    assert "Key Changes" in text and "PRs*:" in text and "Release*:" in text, (
        f"{_SWARM_PATH}: Slack announcement must include required fields (#292)"
    )


# ---------------------------------------------------------------------------
# 34. deft-directive-swarm Phase 5 vBRIEF completion lifecycle (#317)
# ---------------------------------------------------------------------------


def test_deft_directive_swarm_phase5_vbrief_completion() -> None:
    """Phase 5 must move completed vBRIEFs from active/ to completed/."""
    text = _read_skill(_SWARM_PATH)
    assert "scope:complete" in text and "vbrief/completed/" in text, (
        f"{_SWARM_PATH}: Phase 5 must move vBRIEFs to completed/ via scope:complete (#317)"
    )


def test_deft_directive_swarm_phase6_origin_update() -> None:
    """Phase 6 must update origin references on completion (post-merge)."""
    text = _read_skill(_SWARM_PATH)
    assert "references" in text.lower() and "update each origin" in text.lower(), (
        f"{_SWARM_PATH}: Phase 6 must update origins on completion (#317)"
    )


def test_deft_directive_swarm_no_old_name_references() -> None:
    """deft-directive-swarm must not reference the old deft-swarm name."""
    text = _read_skill(_SWARM_PATH)
    # Check that 'deft-swarm' does not appear without the 'directive-' prefix
    import re
    old_refs = re.findall(r'(?<!directive-)deft-swarm', text)
    assert len(old_refs) == 0, (
        f"{_SWARM_PATH}: found {len(old_refs)} reference(s) to old 'deft-swarm' name (#317)"
    )


def test_deft_directive_swarm_frontmatter_name() -> None:
    """SKILL.md frontmatter must have name: deft-directive-swarm."""
    text = _read_skill(_SWARM_PATH)
    assert "name: deft-directive-swarm" in text, (
        f"{_SWARM_PATH}: frontmatter must contain 'name: deft-directive-swarm' (#317)"
    )


def test_deft_directive_swarm_no_hardcoded_allocation_antipattern() -> None:
    """Anti-patterns must prohibit hardcoded 1:1 vBRIEF-per-agent allocation."""
    text = _read_skill(_SWARM_PATH)
    assert "hardcode a 1:1" in text.lower() or "hardcoded 1:1" in text.lower(), (
        f"{_SWARM_PATH}: must have anti-pattern against hardcoded 1:1 allocation (#317)"
    )


# ---------------------------------------------------------------------------
# 34. deft-directive-setup vBRIEF model assertions (#314)
# ---------------------------------------------------------------------------


def test_deft_directive_setup_phase2_outputs_project_definition_vbrief() -> None:
    """Phase 2 must output PROJECT-DEFINITION.vbrief.json, not PROJECT.md."""
    text = _read_skill(_SETUP_PATH)
    assert "PROJECT-DEFINITION.vbrief.json" in text, (
        f"{_SETUP_PATH}: Phase 2 must output PROJECT-DEFINITION.vbrief.json (#314)"
    )


def test_deft_directive_setup_phase3_onboarding_question() -> None:
    """Phase 3 must include onboarding question about adding scope vs starting new."""
    text = _read_skill(_SETUP_PATH)
    assert "adding a scope" in text.lower() and "starting a new" in text.lower(), (
        f"{_SETUP_PATH}: Phase 3 must include onboarding question (#314)"
    )


def test_deft_directive_setup_full_path_rich_narratives() -> None:
    """Full path must write rich narratives to specification.vbrief.json."""
    text = _read_skill(_SETUP_PATH)
    assert "ProblemStatement" in text and "Goals" in text and "UserStories" in text, (
        f"{_SETUP_PATH}: Full path must include rich narrative keys (#314)"
    )
    assert "SuccessMetrics" in text and "Requirements" in text, (
        f"{_SETUP_PATH}: Full path must include SuccessMetrics and Requirements (#314)"
    )


def test_deft_directive_setup_light_path_scope_vbriefs() -> None:
    """Light path must create scope vBRIEFs in vbrief/proposed/."""
    text = _read_skill(_SETUP_PATH)
    assert "vbrief/proposed/" in text, (
        f"{_SETUP_PATH}: Light path must create scope vBRIEFs in vbrief/proposed/ (#314)"
    )


def test_deft_directive_setup_no_authoritative_prd() -> None:
    """deft-directive-setup must not generate authoritative PRD.md."""
    text = _read_skill(_SETUP_PATH)
    assert "authoritative PRD.md" in text, (
        f"{_SETUP_PATH}: must prohibit authoritative PRD.md generation (#314)"
    )


def test_deft_directive_setup_handoff_to_directive_build() -> None:
    """Handoff must reference deft-directive-build, not deft-build."""
    text = _read_skill(_SETUP_PATH)
    assert "deft-directive-build" in text, (
        f"{_SETUP_PATH}: handoff must reference deft-directive-build (#314)"
    )


# ---------------------------------------------------------------------------
# 35. deft-directive-interview vBRIEF model assertions (#319)
# ---------------------------------------------------------------------------


def test_deft_directive_interview_full_path_narrative_keys() -> None:
    """Full path must define rich narrative keys for specification.vbrief.json."""
    text = _read_skill(_INTERVIEW_PATH)
    for key in ["ProblemStatement", "Goals", "UserStories", "Requirements",
                "SuccessMetrics", "Architecture", "Overview"]:
        assert key in text, (
            f"{_INTERVIEW_PATH}: Full path must include '{key}' narrative key (#319)"
        )


def test_deft_directive_interview_light_path_slim_narratives() -> None:
    """Light path must define slim narratives (Overview + Architecture)."""
    text = _read_skill(_INTERVIEW_PATH)
    light_section = text[text.find("### Light Path"):]
    assert "Overview" in light_section and "Architecture" in light_section, (
        f"{_INTERVIEW_PATH}: Light path must include Overview + Architecture (#319)"
    )


def test_deft_directive_interview_prd_render_reference() -> None:
    """deft-directive-interview must reference task prd:render for optional export."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "task prd:render" in text, (
        f"{_INTERVIEW_PATH}: must reference task prd:render (#319)"
    )


def test_deft_directive_interview_no_authoritative_prd() -> None:
    """deft-directive-interview must prohibit authoritative PRD.md generation."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "authoritative PRD.md" in text, (
        f"{_INTERVIEW_PATH}: must prohibit authoritative PRD.md (#319)"
    )
    assert "never authoritative" in text.lower(), (
        f"{_INTERVIEW_PATH}: must state PRD.md is never authoritative (#319)"
    )


def test_deft_directive_interview_output_targets_section() -> None:
    """deft-directive-interview must have Output Targets section."""
    text = _read_skill(_INTERVIEW_PATH)
    assert "## Output Targets" in text, (
        f"{_INTERVIEW_PATH}: must have Output Targets section (#319)"
    )


# ---------------------------------------------------------------------------
# 36. Skill rename verification — no bare deft-* directories remain (#321)
# ---------------------------------------------------------------------------


def test_no_bare_deft_skill_directories() -> None:
    """No skills/ subdirectory should use the old deft-* name (without directive-)."""
    skills_dir = _REPO_ROOT / "skills"
    bare_deft = [
        d.name for d in skills_dir.iterdir()
        if d.is_dir()
        and d.name.startswith("deft-")
        and not d.name.startswith("deft-directive-")
    ]
    assert not bare_deft, (
        f"skills/ contains old-style deft-* directories (should be deft-directive-*): "
        f"{sorted(bare_deft)}"
    )


def test_agents_md_routing_all_deft_directive_paths() -> None:
    """All AGENTS.md routing keywords must map to deft-directive-* skill paths.

    Note: intentionally duplicates test_agents_md_routing_uses_directive_prefix
    in test_vbrief_model.py -- this copy lives in the skill-focused test file
    for skill rename verification context.
    """
    text = _read_skill("AGENTS.md")
    pattern = re.compile(
        r"\u2192\s+`(skills/[^`]+)`",
    )
    paths = pattern.findall(text)
    assert paths, "No routing paths found in AGENTS.md Skill Routing section"
    non_directive = [
        p for p in paths
        if "deft-directive-" not in p
    ]
    assert not non_directive, (
        f"AGENTS.md routing paths use old naming (should be deft-directive-*): "
        f"{non_directive}"
    )
