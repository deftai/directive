import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Content pins for deft-directive-portfolio-prioritize (#3198). */

const _SKILL_PATH = "skills/deft-directive-portfolio-prioritize/SKILL.md";
const _TEMPLATE_PATH =
  "skills/deft-directive-portfolio-prioritize/references/priority-brief-template.md";
const _REFERENCES_MD = "REFERENCES.md";
const _MAX_SKILL_LINES = 150;
const _REQUIRED_TRIGGERS = [
  "portfolio prioritization",
  "priority brief",
  "portfolio pass",
  "prioritize portfolio",
  "shortlist and park",
  "RFC portfolio",
  "park list",
];

function _read(rel_path: string) {
  return readRepoFile(rel_path);
}

describe("test_portfolio_prioritize_skill", () => {
  it("portfolio_prioritize_skill_exists", () => {
    expect(repoFileExists(_SKILL_PATH)).toBeTruthy();
  });

  it("portfolio_prioritize_skill_size_cap", () => {
    const line_count = _read(_SKILL_PATH).split("\n").length;
    expect(line_count).toBeLessThanOrEqual(_MAX_SKILL_LINES);
  });

  it("portfolio_prioritize_skill_frontmatter_name", () => {
    const text = _read(_SKILL_PATH);
    expect(text.startsWith("---")).toBeTruthy();
    expect(text).toContain("name: deft-directive-portfolio-prioritize");
  });

  it("portfolio_prioritize_skill_rfc2119_legend", () => {
    expect(_read(_SKILL_PATH)).toContain("!=MUST, ~=SHOULD");
  });

  it("portfolio_prioritize_skill_triggers_present", () => {
    const text = _read(_SKILL_PATH);
    const parts = text.split("---");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const frontmatter = parts[1];
    const missing = _REQUIRED_TRIGGERS.filter((t) => !frontmatter.includes(t));
    expect(missing).toEqual([]);
  });

  it("portfolio_prioritize_phases_and_gates", () => {
    const text = _read(_SKILL_PATH);
    expect(text).toContain("## Phase 0 — Cache freshness");
    expect(text).toContain("task verify:cache-fresh");
    expect(text).toContain("## Phase 1 — Scope + filter");
    expect(text).toContain("## Phase 2 — Cluster");
    expect(text).toContain("## Phase 3 — Shortlist + park");
    expect(text).toContain("## Phase 4 — Emit brief + dispose checklist");
    expect(text).toContain("propose-not-apply");
    expect(text).toContain("#3179");
    expect(text).toContain("#1396");
    expect(text).toContain("#886");
    expect(text).toContain("#3198");
  });

  it("portfolio_prioritize_epistemic_gates", () => {
    const text = _read(_SKILL_PATH);
    expect(text).toMatch(/Epistemic gates/i);
    expect(text.toLowerCase()).toContain("body");
    expect(text.toLowerCase()).toContain("comment");
    expect(text).toContain("Title-only supersession");
    expect(text).toContain("gh api repos/");
  });

  it("portfolio_prioritize_forbids_scm_mutations", () => {
    const text = _read(_SKILL_PATH);
    expect(text).toContain("SCM label");
    expect(text).toContain("triage:accept");
    expect(text).toMatch(/scope:promote|scope lifecycle/i);
    expect(text).toContain("⊗");
  });

  it("portfolio_prioritize_classify_is_filter_not_ranker", () => {
    const text = _read(_SKILL_PATH);
    expect(text).toMatch(/filter/i);
    expect(text).toMatch(/\*\*not\*\* as the ranker|not as the ranker|sole ranking order/i);
  });

  it("portfolio_prioritize_template_exists", () => {
    expect(repoFileExists(_TEMPLATE_PATH)).toBeTruthy();
    const tpl = _read(_TEMPLATE_PATH);
    expect(tpl).toContain("Shortlist");
    expect(tpl).toContain("Park list");
    expect(tpl).toContain("Conflict / supersession matrix");
    expect(tpl).toContain("Operator dispose checklist");
    expect(tpl).toContain("#1396");
  });

  it("portfolio_prioritize_exit_block", () => {
    const text = _read(_SKILL_PATH);
    expect(text).toContain("## EXIT");
    expect(text.toLowerCase()).toContain("exiting skill");
    expect(text).toContain("deft-directive-portfolio-prioritize complete");
  });

  it("references_md_portfolio_prioritize_index_entry", () => {
    const text = _read(_REFERENCES_MD);
    expect(text).toContain("deft-directive-portfolio-prioritize/SKILL.md");
    const missing = _REQUIRED_TRIGGERS.filter((t) => !text.includes(t));
    expect(missing).toEqual([]);
  });

  it("skills_pack_lists_portfolio_prioritize", () => {
    const pack = _read("packs/skills/skills-pack-0.1.json");
    expect(pack).toContain("deft-directive-portfolio-prioritize");
    expect(pack).toContain("priority-brief-template.md");
  });
});
