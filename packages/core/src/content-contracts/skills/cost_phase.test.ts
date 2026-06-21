import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_cost_phase.py (#1838 #1530) */

const _COST_SKILL_PATH = "skills/deft-directive-cost/SKILL.md";
const _BUILD_SKILL_PATH = "skills/deft-directive-build/SKILL.md";
const _COST_TEMPLATE_PATH = "templates/COST-ESTIMATE.md";
const _COST_MODELS_PATH = "references/cost-models.md";
const _RFC2119_LEGEND = "!=MUST, ~=SHOULD";
const _JARGON_TERMS = [
  "TCO",
  "burn rate",
  "p50",
  "OPEX vs CAPEX",
  "amortised",
  "blended rate",
  "unit economics",
  "FTE",
];

function _read(rel_path: string) {
  return readRepoFile(rel_path);
}

describe("test_cost_phase", () => {
  it.each([
    [_COST_SKILL_PATH, "cost skill"],
    [_COST_TEMPLATE_PATH, "cost template"],
    [_COST_MODELS_PATH, "cost models"],
  ])("cost_phase_artifact_exists %s", (relPath) => {
    expect(repoFileExists(relPath)).toBe(true);
  });
  it("cost_skill_has_frontmatter", () => {
    const text = readRepoFile(_COST_SKILL_PATH);
    expect(text.startsWith("---")).toBeTruthy();
    expect(text).toContain("name: deft-directive-cost");
  });
  it("cost_skill_rfc2119_legend_present", () => {
    const text = readRepoFile(_COST_SKILL_PATH);
    expect(text).toContain(_RFC2119_LEGEND);
  });
  it("cost_skill_platform_detection_section", () => {
    const text = readRepoFile(_COST_SKILL_PATH);
    expect(text).toContain("## Platform Detection");
    expect(text).toContain("%APPDATA%");
    expect(text).toContain("~/.config/deft/USER.md");
    expect(text).toContain("$DEFT_USER_PATH");
  });
  it("cost_skill_decision_point_phase", () => {
    const text = readRepoFile(_COST_SKILL_PATH);
    expect(text.includes("Decision point") || text.includes("decision point")).toBe(true);
    for (const choice of ["Build", "Rescope", "No-build", "Skip"]) {
      expect(text).toContain(choice);
    }
  });
  it("cost_skill_kickoff_menu_discuss_back_final_two_options", () => {
    const text = readRepoFile(_COST_SKILL_PATH);
    const discussMatch = /^(\d+)\.\s+Discuss\b/m.exec(text);
    const backMatch = /^(\d+)\.\s+Back\b/m.exec(text);
    expect(discussMatch).not.toBeNull();
    expect(backMatch).not.toBeNull();
    const discussN = Number.parseInt(discussMatch?.[1] ?? "", 10);
    const backN = Number.parseInt(backMatch?.[1] ?? "", 10);
    expect(backN).toBe(discussN + 1);
    const fencePattern = /```[^\n]*\n([\s\S]*?)```/g;
    const menuBlocks: string[] = [];
    for (const m of text.matchAll(fencePattern)) {
      if (m[1]?.includes("Discuss") && m[1]?.includes("Back")) {
        menuBlocks.push(m[1]);
      }
    }
    expect(menuBlocks.length).toBeGreaterThan(0);
    const menuBlock = menuBlocks[0];
    const laterOptions = [...menuBlock.matchAll(/^(\d+)\.\s+\w+/gm)].map((m) =>
      Number.parseInt(m[1], 10),
    );
    expect(backN).toBe(Math.max(...laterOptions));
  });
  it("cost_skill_skip_requires_reason", () => {
    const text = readRepoFile(_COST_SKILL_PATH);
    const lower = text.toLowerCase();
    expect(lower).toContain("skip");
    expect(lower).toContain("reason");
  });
  it("cost_skill_rescope_loop", () => {
    const text = readRepoFile(_COST_SKILL_PATH);
    expect(text).toContain("Rescope");
    const lower = text.toLowerCase();
    expect(lower.includes("spec edit") || lower.includes("spec edits")).toBe(true);
    expect(lower.includes("re-run") || lower.includes("re-runs")).toBe(true);
  });
  it("cost_skill_anti_patterns_section", () => {
    const text = readRepoFile(_COST_SKILL_PATH);
    expect(text).toContain("## Anti-Patterns");
  });
  it("cost_skill_exit_block", () => {
    const text = readRepoFile(_COST_SKILL_PATH);
    expect(text).toContain("## EXIT");
    expect(text.toLowerCase()).toContain("exiting skill");
  });
  it("cost_template_has_required_sections", () => {
    const text = readRepoFile(_COST_TEMPLATE_PATH);
    const required = [
      "# Cost & Budget Estimate",
      "## TL;DR",
      "## What you will need to sign up for",
      "## Hosting & infrastructure",
      "## API & third-party fees",
      "## Monthly band",
      "## Scale considerations",
      "## Decision point",
      "### Decision recorded",
    ];
    for (const heading of required) {
      expect(text).toContain(heading);
    }
  });
  it("cost_template_low_typical_high_band", () => {
    const text = readRepoFile(_COST_TEMPLATE_PATH);
    for (const token of ["**Low**", "**Typical**", "**High**"]) {
      expect(text).toContain(token);
    }
  });
  it("cost_template_decision_options_all_four", () => {
    const text = readRepoFile(_COST_TEMPLATE_PATH);
    for (const choice of ["Build", "Rescope", "No-build", "Skip"]) {
      expect(text).toContain(`**${choice}**`);
    }
  });
  it("cost_template_usd_only_first_pass", () => {
    const text = readRepoFile(_COST_TEMPLATE_PATH);
    expect(text).toContain("USD");
  });
  it("cost_template_no_jargon_in_user_artifact", () => {
    const text = readRepoFile(_COST_TEMPLATE_PATH);
    for (const term of _JARGON_TERMS) {
      expect(text).not.toContain(term);
    }
  });
  it("cost_models_has_methodology_sections", () => {
    const text = readRepoFile(_COST_MODELS_PATH);
    const required = [
      "## Scope",
      "## Core Principles",
      "## Where Costs Come From",
      "## Building the Monthly Band",
      "## Decision Point",
      "## Plain-English Voice",
      "## Anti-Patterns",
    ];
    for (const heading of required) {
      expect(text).toContain(heading);
    }
  });
  it("cost_models_usd_only_documented", () => {
    const text = readRepoFile(_COST_MODELS_PATH);
    const lower = text.toLowerCase();
    expect(lower.includes("usd-only") || lower.includes("usd only")).toBe(true);
  });
  it("cost_models_no_hard_numbers_promise", () => {
    const text = readRepoFile(_COST_MODELS_PATH);
    const lower = text.toLowerCase();
    expect(lower).toContain("loose ranges");
  });
  it("build_skill_cost_phase_gate_section", () => {
    const text = readRepoFile(_BUILD_SKILL_PATH);
    expect(text).toContain("## Cost Phase Gate");
    expect(text).toContain("#739");
  });
  it("build_skill_cost_gate_refuses_without_artifact", () => {
    const text = readRepoFile(_BUILD_SKILL_PATH);
    expect(text).toContain("COST-ESTIMATE.md");
    expect(text).toContain("skills/deft-directive-cost/SKILL.md");
  });
  it("build_skill_cost_gate_decision_states", () => {
    const text = readRepoFile(_BUILD_SKILL_PATH);
    const gate_start = text.indexOf("## Cost Phase Gate");
    const gate_end = text.indexOf("\n## ", gate_start + 1);
    const gate_section =
      gate_end !== -1 ? text.slice(gate_start, gate_end) : text.slice(gate_start, undefined);
    for (const state of ["build", "rescope", "no-build", "skip"]) {
      expect(gate_section.toLowerCase()).toContain(state);
    }
  });
  it("build_skill_cost_gate_skip_requires_reason", () => {
    const text = readRepoFile(_BUILD_SKILL_PATH);
    const gate_start = text.indexOf("## Cost Phase Gate");
    const gate_end = text.indexOf("\n## ", gate_start + 1);
    const gate_section =
      gate_end !== -1 ? text.slice(gate_start, gate_end) : text.slice(gate_start, undefined);
    expect(gate_section.toLowerCase()).toContain("reason");
  });
  it("build_skill_cost_gate_anti_pattern", () => {
    const text = readRepoFile(_BUILD_SKILL_PATH);
    const lower = text.toLowerCase();
    expect(lower).toContain("cost-estimate.md");
    expect(lower).toContain("cost phase gate");
  });
  it("agents_md_cost_routing_entry", () => {
    const text = readRepoFile("AGENTS.md");
    expect(text).toContain("skills/deft-directive-cost/SKILL.md");
    expect(
      text.includes('"cost"') || text.includes('"budget"') || text.includes('"pre-build cost"'),
    ).toBe(true);
  });
  it.each(_JARGON_TERMS)("cost_skill_no_jargon_outside_anti_pattern %s", (term) => {
    const text = readRepoFile(_COST_SKILL_PATH);
    const apMarker = "## Anti-Patterns";
    const prose = text.includes(apMarker) ? text.split(apMarker, 1)[0] : text;
    const audienceMarker = "## Audience & Voice";
    const nextSection = "## Platform Detection";
    let proseForCheck = prose;
    if (prose.includes(audienceMarker) && prose.includes(nextSection)) {
      const before = prose.split(audienceMarker, 1)[0];
      const after = prose.split(nextSection, 1)[1] ?? "";
      proseForCheck = before + after;
    }
    expect(proseForCheck).not.toContain(term);
  });
});
