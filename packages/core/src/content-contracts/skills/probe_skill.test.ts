import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_probe_skill.py (#1838 #1530) */

const _PROBE_PATH = "skills/deft-directive-probe/SKILL.md";
const _REFERENCES_MD = "REFERENCES.md";
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
  it("probe_skill_forbids_premature_xbrief_writes", () => {
    const text = readRepoFile(_PROBE_PATH);
    const guard_region = text.split("## Output")[0];
    expect(guard_region.toLowerCase()).toContain("xbrief");
    expect(guard_region.includes("⊗") || guard_region.includes("MUST NOT")).toBe(true);
  });
  it("probe_skill_forbids_premature_plan_updates", () => {
    const text = readRepoFile(_PROBE_PATH);
    const guard_region = text.split("## Output")[0];
    expect(guard_region).toContain("plan.xbrief.json");
  });
  it("probe_skill_forbids_premature_github_comments", () => {
    const text = readRepoFile(_PROBE_PATH);
    const guard_region = text.split("## Output")[0];
    expect(guard_region.toLowerCase()).toContain("github");
  });
  it("references_md_probe_index_entry", () => {
    // #838: skill routing moved from AGENTS.md / the agents-entry template to the
    // REFERENCES.md Skills Index. Probe discoverability (#1518) now lives there.
    const text = readRepoFile(_REFERENCES_MD);
    expect(text).toContain("deft-directive-probe/SKILL.md");
    const missing = _REQUIRED_TRIGGERS.filter((t) => !text.includes(t));
    expect(missing.length).toBe(0);
    const probeRow = text
      .split("\n")
      .find((line) => line.includes("deft-directive-probe/SKILL.md"));
    expect(probeRow).toBeDefined();
    expect(probeRow).toContain("deft probe-session");
    expect(probeRow?.toLowerCase()).not.toContain("task probe");
  });
  it("probe_skill_waiver_keeps_no_artifact_guard_without_cli_must", () => {
    const text = readRepoFile(_PROBE_PATH);
    expect(text).toMatch(/Waiver[\s\S]*#3556/);
    expect(text.includes("No-Artifact Guard") || text.toLowerCase().includes("no-artifact")).toBe(
      true,
    );
    const mustLines = text.split("\n").filter((line) => line.includes("deft probe-session"));
    expect(mustLines.length).toBeGreaterThan(0);
    for (const line of mustLines) {
      expect(line).not.toMatch(/^\s*- !/);
    }
  });
  it("probe_skill_exit_block_present", () => {
    const text = readRepoFile(_PROBE_PATH);
    expect(text).toContain("## EXIT");
    expect(text.toLowerCase()).toContain("exiting skill");
  });
});
