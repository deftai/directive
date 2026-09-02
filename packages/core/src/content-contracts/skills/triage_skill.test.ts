import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_triage_skill.py (#1838 #1530). Recut for #4070 withdraw stub. */

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
    const missing = _REQUIRED_TRIGGERS.filter((t) => !frontmatter?.includes(t));
    expect(missing.length).toBe(0);
  });
  it("triage_skill_is_withdrawn_stub_4070", () => {
    const text = readRepoFile(_TRIAGE_PATH);
    expect(text).toContain("Withdrawn (#4070)");
    expect(text).toContain("#4071");
    expect(text).toContain("#3579");
    expect(text).toContain("task plan-sequence:current");
    expect(text).toContain("task triage:queue");
    expect(text).not.toContain("## Phase 1 -- Classify");
    expect(text).not.toContain("## Phase 3 -- Decide");
  });
  it("triage_skill_exit_block_present", () => {
    const text = readRepoFile(_TRIAGE_PATH);
    expect(text).toContain("## EXIT");
    expect(text.toLowerCase()).toContain("exiting skill");
    expect(text).toContain("#4070");
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
