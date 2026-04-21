"""test_500_discoverability.py -- Tests for #500 pre-cutover migration discoverability.

Scope: per #506 D6, Agent E (#500) is responsible for:
  A. documenting the deft/Taskfile.yml include pattern in deft/main.md and
     deft/QUICK-START.md so `task migrate:vbrief` resolves from project root
  B. updating the setup SKILL.md pre-cutover guard with a task-resolvability
     check and the `task -t ./deft/Taskfile.yml migrate:vbrief` fallback
  C. adding a pre-cutover detection branch to the consumer AGENTS.md
     (templates/agents-entry.md) BEFORE Phase 1/2/Returning
  D. adding a ``## Migrating from pre-v0.20`` section to deft/main.md,
     cross-linked from AGENTS.md pre-cutover branch and deft/QUICK-START.md
  skip-ii. NOT adding install-step Taskfile mutation (#506 D6 explicitly
     skips option ii); these tests therefore assert the absence of such
     mutation language.

This module asserts the contract documented in
``vbrief/active/2026-04-21-500-migration-discoverability.vbrief.json``.
"""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]

_MAIN_MD = _REPO_ROOT / "main.md"
_QUICKSTART_MD = _REPO_ROOT / "QUICK-START.md"
_AGENTS_ENTRY_TEMPLATE = _REPO_ROOT / "templates" / "agents-entry.md"
_SETUP_SKILL = _REPO_ROOT / "skills" / "deft-directive-setup" / "SKILL.md"
_SETUP_GO = _REPO_ROOT / "cmd" / "deft-install" / "setup.go"

_FALLBACK_CMD = "task -t ./deft/Taskfile.yml migrate:vbrief"
_PRECUTOVER_SECTION_HEADING = "## Migrating from pre-v0.20"


# ---------------------------------------------------------------------------
# Task 500-A -- Taskfile include pattern discoverable in deft/main.md and
# deft/QUICK-START.md
# ---------------------------------------------------------------------------


def test_main_md_documents_taskfile_include_pattern() -> None:
    """deft/main.md must document the `includes: deft: deft/Taskfile.yml` pattern.

    The pattern is how consumer projects make `task migrate:vbrief`
    resolvable from the project root (#506 D6 primary path).
    """
    text = _MAIN_MD.read_text(encoding="utf-8")
    # Heading + code block + ./deft/Taskfile.yml include target.
    assert "Publishing deft tasks in your project root" in text, (
        "main.md: missing 'Publishing deft tasks in your project root' section "
        "(Task 500-A, #506 D6 primary path)"
    )
    assert "taskfile: ./deft/Taskfile.yml" in text, (
        "main.md: the Taskfile include snippet must reference "
        "`taskfile: ./deft/Taskfile.yml` so consumers can copy-paste (#500)"
    )
    # Must name `includes:` so readers spot the Taskfile include key.
    assert "includes:" in text, (
        "main.md: the Taskfile include snippet must use the `includes:` key"
    )


def test_quickstart_references_fallback_command() -> None:
    """QUICK-START.md must reference the `task -t ./deft/Taskfile.yml migrate:vbrief`
    fallback so operators hitting Case H / Case I from the project root still
    have a working invocation (#500 problem 1)."""
    text = _QUICKSTART_MD.read_text(encoding="utf-8")
    assert _FALLBACK_CMD in text, (
        f"QUICK-START.md: missing fallback invocation '{_FALLBACK_CMD}' "
        f"referenced from Case H / Case I (#500, #506 D6 fallback path)"
    )


def test_quickstart_cross_links_main_migration_section() -> None:
    """QUICK-START.md Case H / Case I must cross-link the main.md migration section."""
    text = _QUICKSTART_MD.read_text(encoding="utf-8")
    # Explicit anchor required so agents can jump straight to the main.md
    # migration reference from QUICK-START.md Case H / Case I.
    assert "main.md#migrating-from-pre-v020" in text, (
        "QUICK-START.md: should deep-link to "
        "`main.md#migrating-from-pre-v020` for the full migration reference "
        "(Task 500-D cross-link)"
    )


# ---------------------------------------------------------------------------
# Task 500-B -- Pre-cutover guard fallback command + resolvability check
# Task 500-B2 -- Environment preflight
# ---------------------------------------------------------------------------


def test_setup_skill_pre_cutover_guard_fallback_command() -> None:
    """skills/deft-directive-setup/SKILL.md must surface the fallback command."""
    text = _SETUP_SKILL.read_text(encoding="utf-8")
    assert "Pre-Cutover Detection Guard" in text, (
        "setup SKILL.md: Pre-Cutover Detection Guard section missing "
        "(regression guard)"
    )
    assert _FALLBACK_CMD in text, (
        f"setup SKILL.md: Pre-Cutover Detection Guard must reference the "
        f"fallback invocation '{_FALLBACK_CMD}' when `task migrate:vbrief` "
        f"is not resolvable from the project root (Task 500-B, #506 D6)"
    )


def test_setup_skill_documents_task_resolvability_check() -> None:
    """The guard must describe a task resolvability check (e.g. `task --list`
    grepped for `migrate:vbrief`)."""
    text = _SETUP_SKILL.read_text(encoding="utf-8")
    assert "Task resolvability" in text or "task resolvability" in text.lower(), (
        "setup SKILL.md: Pre-Cutover Detection Guard must document a task "
        "resolvability check as the first preflight step (Task 500-B / B2)"
    )
    assert "task --list" in text, (
        "setup SKILL.md: resolvability check must call out `task --list` as "
        "the probe command so operators can reproduce it"
    )
    assert "migrate:vbrief" in text, (
        "setup SKILL.md: resolvability check must grep `task --list` for "
        "the `migrate:vbrief` task name"
    )


def test_setup_skill_documents_uv_preflight() -> None:
    """Preflight must verify `uv` is on PATH before offering to run migration."""
    text = _SETUP_SKILL.read_text(encoding="utf-8")
    assert "uv" in text and ("on PATH" in text or "`uv --version`" in text), (
        "setup SKILL.md: Pre-Cutover Detection Guard preflight must verify "
        "`uv` is installed (the migrator runs `uv run python ...`) -- see "
        "Task 500-B2"
    )


def test_setup_skill_documents_migrate_script_preflight() -> None:
    """Preflight must verify `deft/scripts/migrate_vbrief.py` is present."""
    text = _SETUP_SKILL.read_text(encoding="utf-8")
    assert "migrate_vbrief.py" in text, (
        "setup SKILL.md: Pre-Cutover Detection Guard preflight must verify "
        "the migration script is on disk (Task 500-B2)"
    )


def test_setup_skill_preflight_reports_before_prompt() -> None:
    """The preflight results MUST be reported to the user BEFORE the yes/no
    `Would you like me to run ... now?` prompt."""
    text = _SETUP_SKILL.read_text(encoding="utf-8")
    # Ordering: the preflight section introduction line mentioning "Before"
    # appears before the prompt-and-run subsection.
    preflight_intro = text.find("Environment Preflight")
    prompt_index = text.find("Prompt and Run")
    assert preflight_intro != -1, (
        "setup SKILL.md: Pre-Cutover Detection Guard must include an "
        "'Environment Preflight' subsection (Task 500-B2)"
    )
    assert prompt_index != -1, (
        "setup SKILL.md: Pre-Cutover Detection Guard must include a "
        "'Prompt and Run' subsection that runs after preflight"
    )
    assert preflight_intro < prompt_index, (
        "setup SKILL.md: 'Environment Preflight' must appear BEFORE "
        "'Prompt and Run' so the agent surfaces blockers first (Task 500-B2)"
    )


# ---------------------------------------------------------------------------
# Task 500-C -- AGENTS.md pre-cutover branch (consumer template + Go mirror)
# ---------------------------------------------------------------------------


def test_agents_entry_template_has_pre_cutover_branch() -> None:
    """templates/agents-entry.md must have an explicit pre-cutover branch
    BEFORE Phase 1 / Phase 2 / Returning Sessions (#500 problem 2, AC 2)."""
    text = _AGENTS_ENTRY_TEMPLATE.read_text(encoding="utf-8")
    assert "Pre-Cutover Check" in text or "Pre-Cutover" in text, (
        "templates/agents-entry.md: missing 'Pre-Cutover Check' heading "
        "(Task 500-C)"
    )
    pre_cutover_pos = text.find("Pre-Cutover")
    first_session_pos = text.find("## First Session")
    returning_pos = text.find("## Returning Sessions")
    assert pre_cutover_pos != -1, "Pre-Cutover branch heading missing"
    assert first_session_pos != -1, "First Session heading missing"
    assert returning_pos != -1, "Returning Sessions heading missing"
    assert pre_cutover_pos < first_session_pos, (
        "templates/agents-entry.md: Pre-Cutover Check MUST appear BEFORE "
        "'## First Session' (Task 500-C, #500 AC 'before any other action')"
    )
    assert pre_cutover_pos < returning_pos, (
        "templates/agents-entry.md: Pre-Cutover Check MUST appear BEFORE "
        "'## Returning Sessions'"
    )


def test_agents_entry_template_references_deprecated_redirect_sentinel() -> None:
    """Pre-cutover detection criteria must reference the deprecation
    redirect sentinel so agents can distinguish real content from redirect
    stubs."""
    text = _AGENTS_ENTRY_TEMPLATE.read_text(encoding="utf-8")
    assert "deft:deprecated-redirect" in text, (
        "templates/agents-entry.md: pre-cutover detection must reference "
        "the `<!-- deft:deprecated-redirect -->` sentinel (Task 500-C)"
    )


def test_agents_entry_template_references_lifecycle_folders() -> None:
    """Pre-cutover detection must include the partial-migration criterion
    (vbrief/ without all five lifecycle folders)."""
    text = _AGENTS_ENTRY_TEMPLATE.read_text(encoding="utf-8")
    for folder in ("proposed/", "pending/", "active/", "completed/", "cancelled/"):
        assert folder in text, (
            f"templates/agents-entry.md: pre-cutover detection must name "
            f"the `{folder}` lifecycle folder in its partial-migration "
            f"criterion (Task 500-C)"
        )


def test_agents_entry_template_routes_to_setup_skill() -> None:
    """Pre-cutover branch must route agents to the setup SKILL pre-cutover
    guard section."""
    text = _AGENTS_ENTRY_TEMPLATE.read_text(encoding="utf-8")
    assert "deft/skills/deft-directive-setup/SKILL.md" in text, (
        "templates/agents-entry.md: pre-cutover branch must route agents "
        "to deft/skills/deft-directive-setup/SKILL.md (Task 500-C, #500 AC)"
    )
    assert "Pre-Cutover Detection Guard" in text, (
        "templates/agents-entry.md: pre-cutover branch must name the "
        "'Pre-Cutover Detection Guard' section of the setup SKILL"
    )


def test_setup_go_mirrors_pre_cutover_branch() -> None:
    """cmd/deft-install/setup.go agentsMDEntry must mirror the pre-cutover
    branch (same content installed into consumer AGENTS.md)."""
    content = _SETUP_GO.read_text(encoding="utf-8")
    assert "Pre-Cutover Check" in content, (
        "setup.go agentsMDEntry: must mirror the Pre-Cutover Check branch "
        "from templates/agents-entry.md (Task 500-C)"
    )
    assert "deft:deprecated-redirect" in content, (
        "setup.go agentsMDEntry: must reference the deprecation redirect "
        "sentinel in the mirrored pre-cutover branch"
    )
    for folder in ("proposed/", "pending/", "active/", "completed/", "cancelled/"):
        assert folder in content, (
            f"setup.go agentsMDEntry: must list the `{folder}` lifecycle "
            f"folder in its mirrored pre-cutover criterion"
        )
    assert "deft/main.md" in content, (
        "setup.go agentsMDEntry: mirrored branch must cross-link deft/main.md"
    )


# ---------------------------------------------------------------------------
# Task 500-D -- Migrating from pre-v0.20 section in deft/main.md
# ---------------------------------------------------------------------------


def test_main_md_has_migration_section() -> None:
    """deft/main.md must contain a ## Migrating from pre-v0.20 section
    (Task 500-D, #500 AC)."""
    text = _MAIN_MD.read_text(encoding="utf-8")
    assert _PRECUTOVER_SECTION_HEADING in text, (
        f"main.md: missing '{_PRECUTOVER_SECTION_HEADING}' section "
        f"(Task 500-D, #500 AC)"
    )


def test_main_md_migration_section_covers_required_content() -> None:
    """The migration section must cover: pre-cutover detection, canonical
    command, fallback command, what migration produces (reconciliation +
    legacy reports), and safety flags."""
    text = _MAIN_MD.read_text(encoding="utf-8")
    # Split to the migration section and assert content within it.
    start = text.find(_PRECUTOVER_SECTION_HEADING)
    assert start != -1
    end = text.find("\n## ", start + len(_PRECUTOVER_SECTION_HEADING))
    section = text[start:end] if end != -1 else text[start:]
    # What pre-cutover looks like
    assert "pre-cutover" in section.lower(), (
        "main.md migration section must describe what pre-cutover looks like"
    )
    # Canonical command
    assert "task migrate:vbrief" in section, (
        "main.md migration section must cite the canonical `task migrate:vbrief` command"
    )
    # Fallback command
    assert _FALLBACK_CMD in section, (
        f"main.md migration section must document the fallback invocation "
        f"'{_FALLBACK_CMD}' for projects that don't have migrate:vbrief in "
        f"their root Taskfile"
    )
    # RECONCILIATION.md + LEGACY-REPORT.md (produced by Agent A/B per #496/#495/#505)
    assert "RECONCILIATION.md" in section, (
        "main.md migration section must reference RECONCILIATION.md (#496 output)"
    )
    assert "LEGACY-REPORT.md" in section, (
        "main.md migration section must reference LEGACY-REPORT.md (#495/#505 output)"
    )
    # Safety flags (#497)
    for flag in ("--dry-run", "--rollback", "--strict", "--force"):
        assert flag in section, (
            f"main.md migration section must document the `{flag}` safety "
            f"flag (#497)"
        )


def test_main_md_migration_section_references_quickstart_and_setup_skill() -> None:
    """The migration section must cross-link QUICK-START.md and the setup SKILL."""
    text = _MAIN_MD.read_text(encoding="utf-8")
    start = text.find(_PRECUTOVER_SECTION_HEADING)
    section = text[start:]
    assert "QUICK-START.md" in section, (
        "main.md migration section must cross-reference QUICK-START.md"
    )
    assert "skills/deft-directive-setup/SKILL.md" in section, (
        "main.md migration section must cross-reference the setup SKILL.md "
        "(Pre-Cutover Detection Guard)"
    )


# ---------------------------------------------------------------------------
# Task 500-skip-ii -- NO install-step Taskfile mutation anywhere
# ---------------------------------------------------------------------------


def test_no_install_step_taskfile_mutation_language() -> None:
    """Per #506 D6, option (ii) 'install step adds migration-task include' is
    explicitly skipped. Guard against any language that proposes this approach
    in the files touched by #500."""
    # Watch for install-step Taskfile mutation language. These phrases would
    # indicate someone proposed option (ii); they must NOT appear.
    banned_substrings = (
        "install:install writes a project-root Taskfile",
        "install step adds migration-task include",
        "install step writes migrate:vbrief",
    )
    surfaces = [_MAIN_MD, _QUICKSTART_MD, _AGENTS_ENTRY_TEMPLATE, _SETUP_SKILL, _SETUP_GO]
    for path in surfaces:
        text = path.read_text(encoding="utf-8")
        for phrase in banned_substrings:
            assert phrase not in text, (
                f"{path.name}: must NOT propose install-step Taskfile "
                f"mutation (banned phrase: '{phrase}'). Per #506 D6, "
                f"option (ii) is explicitly skipped -- the include pattern "
                f"documented in main.md is the supported publish mechanism."
            )


def test_setup_skill_explicitly_prohibits_install_step_mutation() -> None:
    """setup SKILL.md should carry an explicit anti-pattern against proposing
    install-step Taskfile mutation so future agents don't re-introduce option
    (ii) from #500."""
    text = _SETUP_SKILL.read_text(encoding="utf-8")
    # The rule should be strong (\u2297) and reference the supported
    # include pattern.
    assert "install-step" in text.lower() or "install step" in text.lower(), (
        "setup SKILL.md: should carry an explicit anti-pattern referencing "
        "install-step Taskfile mutation (per #506 D6 skip)"
    )
    # And the skip rationale should reference the include pattern.
    assert "includes: deft: deft/Taskfile.yml" in text or "deft/Taskfile.yml" in text, (
        "setup SKILL.md: anti-pattern / skip rationale should reference the "
        "include pattern as the supported alternative"
    )
