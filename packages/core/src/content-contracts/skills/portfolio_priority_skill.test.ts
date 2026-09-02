import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Content contract for deft-directive-portfolio-priority (#3201 / #3198). */

const SKILL_PATH = "skills/deft-directive-portfolio-priority/SKILL.md";
const POINTER_PATH = ".agents/skills/deft-directive-portfolio-priority/SKILL.md";
const REFERENCES_MD = "REFERENCES.md";
const MAX_SKILL_LINES = 180;
const REQUIRED_TRIGGERS = [
  "portfolio priority",
  "priority brief",
  "competing RFCs",
  "cluster open issues",
];

describe("test_portfolio_priority_skill", () => {
  it("portfolio_priority_skill_exists", () => {
    expect(repoFileExists(SKILL_PATH)).toBeTruthy();
  });

  it("portfolio_priority_skill_size_cap", () => {
    const lineCount = readRepoFile(SKILL_PATH).split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(MAX_SKILL_LINES);
  });

  it("portfolio_priority_skill_frontmatter_name", () => {
    const text = readRepoFile(SKILL_PATH);
    expect(text.startsWith("---")).toBeTruthy();
    expect(text).toContain("name: deft-directive-portfolio-priority");
  });

  it("portfolio_priority_skill_rfc2119_legend", () => {
    const text = readRepoFile(SKILL_PATH);
    expect(text).toContain("!=MUST, ~=SHOULD");
  });

  it("portfolio_priority_skill_triggers_present", () => {
    const text = readRepoFile(SKILL_PATH);
    const parts = text.split("---");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const frontmatter = parts[1];
    const missing = REQUIRED_TRIGGERS.filter((t) => !frontmatter.includes(t));
    expect(missing).toEqual([]);
  });

  it("portfolio_priority_skill_phases_and_classify_filter", () => {
    const text = readRepoFile(SKILL_PATH);
    expect(text).toContain("Phase 0");
    expect(text).toContain("task verify:cache-fresh");
    expect(text).toContain("Phase 1");
    expect(text).toContain("#4070");
    expect(text).toMatch(/FILTER only|filter only/i);
    expect(text).toContain("task triage:queue");
    expect(text).toContain("Phase 4");
    expect(text).toContain("Epistemic");
  });

  it("portfolio_priority_skill_epistemic_gates", () => {
    const text = readRepoFile(SKILL_PATH);
    expect(text).toMatch(/Title-only supersession[\s*]*[,].*duplicate/i);
    expect(text).toMatch(/Read the body|read the body|read bodies/i);
    expect(text).toContain("duplicate/consolidate classification");
    expect(text).toContain("gh api");
    expect(text).toMatch(/open\/closed|open\/closed accurately/i);
  });

  it("portfolio_priority_skill_overlap_dispose_suppression", () => {
    const text = readRepoFile(SKILL_PATH);
    expect(text).toMatch(/List-before-re-recommend/i);
    expect(text).toContain("task decision:list -- --issue N --json");
    expect(text).toMatch(/#3066\/#3082/);
    expect(text).toContain("#3310");
  });

  it("portfolio_priority_skill_brief_template_sections", () => {
    const text = readRepoFile(SKILL_PATH);
    expect(text).toMatch(/Scope of this pass|scope counts/i);
    expect(text).toMatch(/Interrupt|non-portfolio/i);
    expect(text).toMatch(/family matrix|Conflict \/ family/i);
    expect(text).toContain("Shortlist");
    expect(text).toMatch(/Park list/i);
    expect(text).toMatch(/Epistemic limits/i);
    expect(text).toMatch(/dispose checklist|Dispose checklist/i);
  });

  it("portfolio_priority_skill_forbids_scm_and_lifecycle", () => {
    const text = readRepoFile(SKILL_PATH);
    expect(text).toMatch(/SCM label writes|no SCM label writes/i);
    expect(text).toContain("triage:accept");
    expect(text).toMatch(/scope:promote|Scope lifecycle/i);
    expect(text).toMatch(/decision record|not a decision record/i);
  });

  it("portfolio_priority_skill_links_worked_example", () => {
    const text = readRepoFile(SKILL_PATH);
    expect(text).toContain("#3200");
    expect(text).toContain("2026-08-07-portfolio-priority-brief-patterns-pilot.md");
    expect(text).toContain("#3198");
    expect(text).toContain("#1396");
  });

  it("portfolio_priority_skill_exit_block", () => {
    const text = readRepoFile(SKILL_PATH);
    expect(text).toContain("## EXIT");
    expect(text.toLowerCase()).toContain("exiting skill");
    expect(text).toContain("deft-directive-portfolio-priority complete");
  });

  it("portfolio_priority_skill_pointer_exists", () => {
    expect(repoFileExists(POINTER_PATH)).toBeTruthy();
  });

  it("portfolio_priority_skill_pointer_routes_to_real_skill", () => {
    const text = readRepoFile(POINTER_PATH);
    expect(text).toContain(SKILL_PATH);
  });

  it("portfolio_priority_skill_indexed_in_references", () => {
    const text = readRepoFile(REFERENCES_MD);
    expect(text).toContain("deft-directive-portfolio-priority");
    expect(text).toContain("portfolio priority");
  });

  it("portfolio_priority_skill_in_consumer_discovery_inventory", () => {
    // Install-time multi-host deposit SoT (#75 residual / Greptile on #3203).
    const inventory = readRepoFile("packages/core/src/init-deposit/skill-discovery-deposit.ts");
    expect(inventory).toContain('dir: "deft-directive-portfolio-priority"');
    expect(inventory).toContain(
      "Read and follow: .deft/core/skills/deft-directive-portfolio-priority/SKILL.md",
    );
  });
});
