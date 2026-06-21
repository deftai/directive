import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_500_discoverability.py (#1838 #1530) */

const FALLBACK_CMD = "task -t ./deft/Taskfile.yml migrate:vbrief";
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
    expect(text).toContain(FALLBACK_CMD);
  });

  it("quickstart_cross_links_main_migration_section", () => {
    const text = readRepoFile(QUICKSTART_MD);
    expect(text).toContain("main.md#migrating-from-pre-v020");
  });

  it("setup_skill_pre_cutover_guard_fallback_command", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(text).toContain("Pre-Cutover Detection Guard");
    expect(text).toContain(FALLBACK_CMD);
  });

  it("setup_skill_documents_task_resolvability_check", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(
      text.includes("Task resolvability") || text.toLowerCase().includes("task resolvability"),
    ).toBe(true);
    expect(text).toContain("task --list");
    expect(text).toContain("migrate:vbrief");
  });

  it("setup_skill_documents_uv_preflight", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(text).toContain("uv");
    expect(text.includes("on PATH") || text.includes("`uv --version`")).toBe(true);
  });

  it("setup_skill_documents_migrate_script_preflight", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(text).toContain("migrate_vbrief.py");
  });

  it("setup_skill_preflight_reports_before_prompt", () => {
    const text = readRepoFile(SETUP_SKILL);
    const preflightIntro = text.indexOf("Environment Preflight");
    const promptIndex = text.indexOf("Prompt and Run");
    expect(preflightIntro).not.toBe(-1);
    expect(promptIndex).not.toBe(-1);
    expect(preflightIntro).toBeLessThan(promptIndex);
  });

  it("agents_entry_template_has_pre_cutover_branch", () => {
    const text = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    expect(text.includes("Pre-Cutover Check") || text.includes("Pre-Cutover")).toBe(true);
    const preCutoverPos = text.indexOf("Pre-Cutover");
    const firstSessionPos = text.indexOf("## First Session");
    const returningPos = text.indexOf("## Returning Sessions");
    expect(preCutoverPos).not.toBe(-1);
    expect(firstSessionPos).not.toBe(-1);
    expect(returningPos).not.toBe(-1);
    expect(preCutoverPos).toBeLessThan(firstSessionPos);
    expect(preCutoverPos).toBeLessThan(returningPos);
  });

  it("agents_entry_template_references_deprecated_redirect_sentinel", () => {
    const text = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    expect(text).toContain("deft:deprecated-redirect");
  });

  it("agents_entry_template_references_lifecycle_folders", () => {
    const text = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    for (const folder of LIFECYCLE_FOLDERS) {
      expect(text).toContain(folder);
    }
  });

  it("agents_entry_template_routes_to_setup_skill", () => {
    const text = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    expect(text).toContain(".deft/core/skills/deft-directive-setup/SKILL.md");
    expect(text).toContain("Pre-Cutover Detection Guard");
  });

  it("setup_go_mirrors_pre_cutover_branch", () => {
    const setupGoContent = readRepoFile(SETUP_GO);
    expect(setupGoContent).toContain("templates.AgentsEntry");
    expect(setupGoContent).not.toContain("agentsMDEntry = `");
    const entry = readRepoFile(AGENTS_ENTRY_TEMPLATE);
    expect(entry).toContain("Pre-Cutover Check");
    expect(entry).toContain("deft:deprecated-redirect");
    for (const folder of LIFECYCLE_FOLDERS) {
      expect(entry).toContain(folder);
    }
    expect(entry.split(".deft/core/main.md").length - 1).toBe(1);
    expect(entry).toContain("Migrating from pre-v0.20");
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
    expect(section).toContain("task deft:migrate:vbrief");
    expect(section).toContain("task -t ./.deft/core/Taskfile.yml migrate:vbrief");
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

  it("setup_skill_explicitly_prohibits_install_step_mutation", () => {
    const text = readRepoFile(SETUP_SKILL);
    expect(
      text.toLowerCase().includes("install-step") || text.toLowerCase().includes("install step"),
    ).toBe(true);
    expect(
      text.includes("includes: deft: deft/Taskfile.yml") || text.includes("deft/Taskfile.yml"),
    ).toBe(true);
  });
});
