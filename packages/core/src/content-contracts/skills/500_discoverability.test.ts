import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_500_discoverability.py (#1838 #1530) */

const FROZEN_TAG = "v0.59.0";
const PRECUTOVER_SECTION_HEADING = "## Migrating from pre-v0.20";

const MAIN_MD = "main.md";
const QUICKSTART_MD = "QUICK-START.md";
const AGENTS_ENTRY_TEMPLATE = "templates/agents-entry.md";
const SETUP_SKILL = "skills/deft-directive-setup/SKILL.md";
const SETUP_GO = "cmd/deft-install/setup.go";

const LIFECYCLE_FOLDERS = ["proposed/", "pending/", "active/", "completed/", "cancelled/"] as const;

const BANNED_SUBSTRINGS = [
  "install:install writes a project-root Taskfile",
  "install step adds migration-task include",
  "install step writes migrate:vbrief",
];

const SURFACES = [MAIN_MD, QUICKSTART_MD, AGENTS_ENTRY_TEMPLATE, SETUP_SKILL, SETUP_GO];

describe("test_500_discoverability", () => {
  it("main_md_documents_taskfile_include_pattern", () => {
    const text = readRepoFile(MAIN_MD);
    expect(text).toContain("Publishing deft tasks in your project root");
    expect(text).toContain("taskfile: ./.deft/core/Taskfile.yml");
    expect(text).toContain("includes:");
  });

  it("quickstart_references_fallback_command", () => {
    const text = readRepoFile(QUICKSTART_MD);
    expect(text).toContain("task -t ./.deft/core/Taskfile.yml migrate:preflight");
  });

  it("quickstart_cross_links_main_migration_section", () => {
    const text = readRepoFile(QUICKSTART_MD);
    expect(text).toContain("main.md#migrating-from-pre-v020");
  });

  it("setup_skill_pre_cutover_guard_fallback_command", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(text).toContain("Pre-Cutover Detection Guard");
    expect(text).toContain(FROZEN_TAG);
  });

  it("setup_skill_documents_task_resolvability_check", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(text).toContain("migrate:preflight");
  });

  it("setup_skill_documents_uv_preflight", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(text).toContain("uv");
  });

  it("setup_skill_documents_frozen_migration_path", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(text).toContain(FROZEN_TAG);
    expect(text).toContain("#2068");
  });

  it("setup_skill_preflight_reports_before_prompt", () => {
    const text = readRepoFile(SETUP_SKILL);
    const preflightIntro = text.indexOf("Preflight (optional diagnostic)");
    const deterministicPos = text.indexOf("## Deterministic Questions Contract");
    expect(preflightIntro).not.toBe(-1);
    expect(deterministicPos).not.toBe(-1);
    expect(preflightIntro).toBeLessThan(deterministicPos);
  });

  it("agents_entry_template_has_pre_cutover_branch", () => {
    const text = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    // #2535: Session routing is one pointer-thin bootstrap line (#2176).
    expect(text).toContain("## Session routing (#2176)");
    expect(text).toContain("Pre-Cutover (#2068)");
    expect(text).toContain("Cold-start (#2273)");
    expect(text).toContain("missing USER.md / PROJECT-DEFINITION");
    expect(text.indexOf("## First Session")).toBe(-1);
    expect(text.indexOf("## Returning Sessions")).toBe(-1);
  });

  it("agents_entry_template_references_deprecated_redirect_sentinel", () => {
    // Full pre-cutover detection criteria live in setup SKILL; agents-entry is pointer-thin (#2535).
    const setup = readRepoFile(SETUP_SKILL);
    expect(setup).toContain("deft:deprecated-redirect");
    const entry = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    expect(entry).toContain("Pre-Cutover (#2068)");
    expect(entry).toContain("commands.md");
  });

  it("agents_entry_template_references_lifecycle_folders", () => {
    // Lifecycle folder enumeration lives in setup SKILL Pre-Cutover Guard (#2493).
    const setup = readRepoFile(SETUP_SKILL);
    for (const folder of LIFECYCLE_FOLDERS) {
      expect(setup).toContain(folder);
    }
    const entry = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    expect(entry).toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
  });

  it("agents_entry_template_routes_to_setup_skill", () => {
    const text = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    // #2535: setup skill path lives in setup SKILL; entry routes via Pre-Cutover pointer (#2068).
    expect(text).toContain("setup Pre-Cutover (#2068)");
    expect(text).toContain("commands.md");
  });

  it("setup_go_mirrors_pre_cutover_branch", () => {
    const setupGoContent = readRepoFile(SETUP_GO);
    expect(setupGoContent).toContain("templates.AgentsEntry");
    expect(setupGoContent).not.toContain("agentsMDEntry = `");
    const entry = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    expect(entry).toContain("## Session routing (#2176)");
    expect(entry).toContain("Pre-Cutover (#2068)");
    expect(entry).toContain("commands.md");
    const setup = readRepoFile(SETUP_SKILL);
    expect(setup).toContain("deft:deprecated-redirect");
    for (const folder of LIFECYCLE_FOLDERS) {
      expect(setup).toContain(folder);
    }
    expect(entry.split(".deft/core/main.md").length - 1).toBe(1);
    expect(readRepoFile(MAIN_MD)).toContain("Migrating from pre-v0.20");
  });

  it("main_md_has_migration_section", () => {
    const text = readRepoFile(MAIN_MD);
    expect(text).toContain(PRECUTOVER_SECTION_HEADING);
  });

  it("main_md_migration_section_covers_required_content", () => {
    const text = readRepoFile(MAIN_MD);
    const start = text.indexOf(PRECUTOVER_SECTION_HEADING);
    expect(start).not.toBe(-1);
    const nextHeading = text.indexOf("\n## ", start + PRECUTOVER_SECTION_HEADING.length);
    const section = nextHeading === -1 ? text.slice(start) : text.slice(start, nextHeading);
    expect(section.toLowerCase()).toContain("pre-cutover");
    expect(section).toContain(FROZEN_TAG);
    expect(section).toContain("migrate:preflight");
    expect(section).toContain("RECONCILIATION.md");
    expect(section).toContain("LEGACY-REPORT.md");
    for (const flag of ["--dry-run", "--rollback", "--strict", "--force"]) {
      expect(section).toContain(flag);
    }
  });

  it("main_md_migration_section_references_quickstart_and_setup_skill", () => {
    const text = readRepoFile(MAIN_MD);
    const start = text.indexOf(PRECUTOVER_SECTION_HEADING);
    const section = text.slice(start);
    expect(section).toContain("QUICK-START.md");
    expect(section).toContain("skills/deft-directive-setup/SKILL.md");
  });

  it("no_install_step_taskfile_mutation_language", () => {
    for (const path of SURFACES) {
      const text = readRepoFile(path);
      for (const phrase of BANNED_SUBSTRINGS) {
        expect(text).not.toContain(phrase);
      }
    }
  });

  it("setup_skill_explicitly_prohibits_in_product_migrate_vbrief", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(text).toContain("migrate:vbrief");
    expect(text).toContain("#2068");
    expect(text.toLowerCase()).toContain("not bundled");
  });
});
