import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_probe_skill.py (#1838 #1530) */

const _PROBE_PATH = "skills/deft-directive-probe/SKILL.md";
const _AGENTS_MD = "AGENTS.md";
const _TEMPLATE = "templates/agents-entry.md";
const _MAX_SKILL_LINES = 150;
const _REQUIRED_TRIGGERS = ["run probe", "/deft:run:probe", "probe"];

function _read(rel_path: string) {
  return readRepoFile(rel_path);
}

describe("test_probe_skill", () => {
  it("probe_skill_exists", () => {
    expect(repoFileExists(_PROBE_PATH)).toBeTruthy();
  });
  it("probe_skill_size_cap", () => {
    const line_count = readRepoFile(_PROBE_PATH).split("\n").length;
    expect(line_count).toBeLessThanOrEqual(_MAX_SKILL_LINES);
  });
  it("probe_skill_frontmatter_name", () => {
    const text = readRepoFile(_PROBE_PATH);
    expect(text.startsWith("---")).toBeTruthy();
    expect(text).toContain("name: deft-directive-probe");
  });
  it("probe_skill_rfc2119_legend", () => {
    const text = readRepoFile(_PROBE_PATH);
    expect(text).toContain("!=MUST, ~=SHOULD");
  });
  it("probe_skill_triggers_present", () => {
    const text = readRepoFile(_PROBE_PATH);
    const parts = text.split("---");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const frontmatter = parts[1];
    const missing = _REQUIRED_TRIGGERS.filter((t) => !frontmatter.includes(t));
    expect(missing.length).toBe(0);
  });
  it("probe_skill_first_turn_one_question_rule", () => {
    const text = readRepoFile(_PROBE_PATH);
    expect(
      text.includes("First-turn contract") ||
        text.toLowerCase().includes("first user-facing probe turn"),
    ).toBe(true);
    expect(text).toContain("ONE");
    expect(text).toContain("focused question");
  });
  it("probe_skill_first_turn_recommended_answer", () => {
    const text = readRepoFile(_PROBE_PATH);
    expect(text.toLowerCase()).toContain("recommended answer");
  });
  it("probe_skill_forbids_batched_decisions", () => {
    const text = readRepoFile(_PROBE_PATH);
    expect(
      text.toLowerCase().includes("batched decision") ||
        text.toLowerCase().includes("multiple questions"),
    ).toBe(true);
  });
  it("probe_skill_no_artifact_guard_section", () => {
    const text = readRepoFile(_PROBE_PATH);
    expect(text.includes("No-Artifact Guard") || text.toLowerCase().includes("no-artifact")).toBe(
      true,
    );
  });
  it("probe_skill_forbids_premature_vbrief_writes", () => {
    const text = readRepoFile(_PROBE_PATH);
    const guard_region = text.split("## Output")[0];
    expect(guard_region.toLowerCase()).toContain("vbrief");
    expect(guard_region.includes("⊗") || guard_region.includes("MUST NOT")).toBe(true);
  });
  it("probe_skill_forbids_premature_plan_updates", () => {
    const text = readRepoFile(_PROBE_PATH);
    const guard_region = text.split("## Output")[0];
    expect(guard_region).toContain("plan.vbrief.json");
  });
  it("probe_skill_forbids_premature_github_comments", () => {
    const text = readRepoFile(_PROBE_PATH);
    const guard_region = text.split("## Output")[0];
    expect(guard_region.toLowerCase()).toContain("github");
  });
  it("agents_md_probe_routing_entry", () => {
    const text = readRepoFile(_AGENTS_MD);
    expect(text).toContain("skills/deft-directive-probe/SKILL.md");
    expect(text.includes('"run probe"') || text.includes('"/deft:run:probe"')).toBe(true);
  });
  it("agents_entry_template_probe_routing_entry", () => {
    const text = readRepoFile(_TEMPLATE);
    expect(text).toContain("deft-directive-probe/SKILL.md");
    expect(text.includes('"run probe"') || text.includes('"/deft:run:probe"')).toBe(true);
  });
  it("probe_skill_exit_block_present", () => {
    const text = readRepoFile(_PROBE_PATH);
    expect(text).toContain("## EXIT");
    expect(text.toLowerCase()).toContain("exiting skill");
  });
});
