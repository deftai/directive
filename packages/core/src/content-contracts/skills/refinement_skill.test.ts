import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_refinement_skill.py (#1838 #1530) */

const _REFINEMENT_PATH = "skills/deft-directive-refinement/SKILL.md";

function _read(rel_path: string) {
  return readRepoFile(rel_path);
}

describe("test_refinement_skill", () => {
  it("refinement_phase0_top_heading_present", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    expect(text).toContain("## Phase 0 -- Triage-first consultation (cache-first, #1141)");
  });
  it("refinement_deterministic_questions_are_host_portable", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    expect(text).toContain("render the canonical numbered menu in chat");
    expect(text).toContain("numeric option labels");
    expect(text).toContain("exact displayed option text");
    expect(text).toContain("fallback chat replies MUST map only to the displayed number");
  });
  it("refinement_phase0_three_subphases_in_canonical_order", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    const heading_0a = "### Phase 0a -- Triage gate (`task triage:summary`)";
    const heading_0b = "### Phase 0b -- Cache-first ingestion (`task triage:queue --state=accept`)";
    const heading_0c = "### Phase 0c -- Resume conditions (`[RESUME]`-tagged items first)";
    for (const heading of [heading_0a, heading_0b, heading_0c]) {
      expect(text).toContain(heading);
    }
    const idx_0a = text.indexOf(heading_0a);
    const idx_0b = text.indexOf(heading_0b);
    const idx_0c = text.indexOf(heading_0c);
    expect(idx_0a).toBeLessThan(idx_0b);
    expect(idx_0b).toBeLessThan(idx_0c);
  });
  it("refinement_phase0_sub_phases_inside_phase0_section", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    const phase0_start = text.indexOf(
      "## Phase 0 -- Triage-first consultation (cache-first, #1141)",
    );
    const phase1_start = text.indexOf("## Phase 1 -- Ingest");
    const phase0_body = text.slice(phase0_start, phase1_start);
    for (const heading of [
      "### Phase 0a -- Triage gate (`task triage:summary`)",
      "### Phase 0b -- Cache-first ingestion (`task triage:queue --state=accept`)",
      "### Phase 0c -- Resume conditions (`[RESUME]`-tagged items first)",
    ]) {
      expect(phase0_body).toContain(heading);
    }
  });
  it("refinement_phase0_invokes_triage_summary", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    expect(text).toContain("task triage:summary");
    expect(text).toContain("#1122");
  });
  it("refinement_phase0_consumes_triage_queue_accept_state", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    expect(text).toContain("task triage:queue --state=accept");
    expect(text).toContain("#1128");
  });
  it("refinement_phase0_references_resume_tag_and_d3", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    expect(text).toContain("[RESUME]");
    expect(text).toContain("#1123");
  });
  it("refinement_phase0_stale_defer_priority_documented", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    expect(text.includes("Stale-defer") || text.includes("stale-defer")).toBe(true);
    expect(text).toContain("take priority over fresh untriaged");
  });
  it("refinement_phase0_empty_cache_fallback_prompt_points_at_triage_welcome", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    expect(text).toContain("task triage:welcome");
    expect(text).toContain("#1143");
  });
  it("refinement_phase0_empty_cache_fallback_block_present", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    const phase0a_start = text.indexOf("### Phase 0a -- Triage gate");
    const phase0b_start = text.indexOf("### Phase 0b -- Cache-first ingestion");
    const phase0a_body = text.slice(phase0a_start, phase0b_start);
    expect(phase0a_body).toContain("Empty-cache backward-compat fallback");
    expect(phase0a_body).toContain("stderr");
    expect(phase0a_body).toContain("task triage:welcome");
  });
  it("refinement_phase4_verb_table_includes_scope_undo", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    const phase4_start = text.indexOf("## Phase 4 -- Promote/Demote");
    const phase5_start = text.indexOf("## Phase 5 -- Prioritize");
    const phase4_body = text.slice(phase4_start, phase5_start);
    expect(phase4_body).toContain("`task scope:undo");
    expect(phase4_body).toContain("#1134");
  });
  it("refinement_see_also_footer_present", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    expect(text).toContain("\n## See also\n");
  });
  it("refinement_see_also_footer_points_at_triage_skill", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    const footerIdx = text.lastIndexOf("## See also");
    const footer = text.slice(footerIdx);
    expect(footer).toContain("deft-directive-triage/SKILL.md");
    expect(footer.includes("Upstream skill") || footer.includes("upstream skill")).toBe(true);
  });
  it("refinement_see_also_footer_cites_all_consumed_surfaces", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    const footerIdx = text.lastIndexOf("## See also");
    const footer = text.slice(footerIdx);
    for (const issue_ref of ["#1122", "#1128", "#1123", "#1130", "#1134", "#1143", "#1141"]) {
      expect(footer).toContain(issue_ref);
    }
  });
  it("refinement_phase0_does_not_route_decision_verbs", () => {
    const text = readRepoFile(_REFINEMENT_PATH);
    const phase0_start = text.indexOf(
      "## Phase 0 -- Triage-first consultation (cache-first, #1141)",
    );
    const phase1_start = text.indexOf("## Phase 1 -- Ingest");
    const phase0_body = text.slice(phase0_start, phase1_start);
    const forbidden = "task triage:accept|reject|defer|needs-ac|mark-duplicate";
    expect(phase0_body).not.toContain(forbidden);
  });
});
