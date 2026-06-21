import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_triage_skill.py (#1838 #1530) */

const _TRIAGE_PATH = "skills/deft-directive-triage/SKILL.md";
const _TRIAGE_POINTER_PATH = ".agents/skills/deft-directive-triage/SKILL.md";
const _REFINEMENT_PATH = "skills/deft-directive-refinement/SKILL.md";
const _MAX_SKILL_LINES = 150;
const _REQUIRED_TRIGGERS = [
  "triage",
  "triage hygiene",
  "work the cache",
  "what's next",
  "whats next",
  "what should I work on",
  "queue",
  "build a cohort",
  "build cohort",
];
const _REQUIRED_PHASES = [
  ["## Phase 0 -- Sync", "task verify:cache-fresh"],
  ["## Phase 1 -- Classify", "task triage:classify"],
  ["## Phase 2 -- Present", "task triage:queue"],
  ["## Phase 3 -- Decide", "task triage:accept"],
  ["## Phase 4 -- Audit", "task triage:audit"],
];

function _read(rel_path: string) {
  return readRepoFile(rel_path);
}

describe("test_triage_skill", () => {
  it("triage_skill_exists", () => {
    expect(repoFileExists(_TRIAGE_PATH)).toBeTruthy();
  });
  it("triage_skill_size_cap", () => {
    const line_count = readRepoFile(_TRIAGE_PATH).split("\n").length;
    expect(line_count).toBeLessThanOrEqual(_MAX_SKILL_LINES);
  });
  it("triage_skill_frontmatter_name", () => {
    const text = readRepoFile(_TRIAGE_PATH);
    expect(text.startsWith("---")).toBeTruthy();
    expect(text).toContain("name: deft-directive-triage");
  });
  it("triage_skill_rfc2119_legend", () => {
    const text = readRepoFile(_TRIAGE_PATH);
    expect(text).toContain("!=MUST, ~=SHOULD");
  });
  it("triage_skill_triggers_present", () => {
    const text = readRepoFile(_TRIAGE_PATH);
    const parts = text.split("---");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const frontmatter = parts[1];
    const missing = _REQUIRED_TRIGGERS.filter((t) => !frontmatter.includes(t));
    expect(missing.length).toBe(0);
  });
  it("triage_skill_all_phases_present", () => {
    const text = readRepoFile(_TRIAGE_PATH);
    for (const [heading, verb] of _REQUIRED_PHASES) {
      expect(text).toContain(heading);
      expect(text).toContain(verb);
    }
  });
  it("triage_skill_exit_block_present", () => {
    const text = readRepoFile(_TRIAGE_PATH);
    expect(text).toContain("## EXIT");
    expect(text.toLowerCase()).toContain("exiting skill");
    expect(text).toContain("deft-directive-refinement");
    expect(text).toContain("deft-directive-swarm");
  });
  it("triage_skill_reversibility_layer5_verb", () => {
    const text = readRepoFile(_TRIAGE_PATH);
    expect(text).toContain("task triage:reset");
    expect(text).toContain("## Reversibility");
  });
  it("triage_action_menu_is_host_portable_numbered_contract", () => {
    const text = readRepoFile(_TRIAGE_PATH);
    expect(text).toContain("1. Accept");
    expect(text).toContain("5. Mark duplicate");
    expect(text).toContain("6. Discuss");
    expect(text).toContain("7. Back");
    expect(text).toContain("displayed number (`1`-`7`) or exact displayed option text");
    expect(text).toContain("bare letters such as `d` / `b`");
  });
  it("triage_skill_pointer_exists", () => {
    expect(repoFileExists(_TRIAGE_POINTER_PATH)).toBeTruthy();
  });
  it("triage_skill_pointer_routes_to_real_skill", () => {
    const text = readRepoFile(_TRIAGE_POINTER_PATH);
    expect(text).toContain(_TRIAGE_PATH);
  });
  it("refinement_skill_cross_references_triage", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    const title_idx = text.indexOf("# Deft Directive Refinement");
    expect(title_idx).not.toBe(-1);
    const first_h2_idx = text.indexOf("## ", title_idx + "# Deft Directive Refinement".length);
    const intro =
      first_h2_idx !== -1 ? text.slice(title_idx, first_h2_idx) : text.slice(title_idx, undefined);
    expect(intro).toContain("deft-directive-triage");
  });
});
