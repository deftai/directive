import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_interview_always_structured.py (#1838 #1530) */

const _INTERVIEW_PATH = "skills/deft-directive-interview/SKILL.md";
const _SETUP_PATH = "skills/deft-directive-setup/SKILL.md";

const interview_text = readRepoFile(_INTERVIEW_PATH);

const setup_text = readRepoFile(_SETUP_PATH);

describe("test_interview_always_structured", () => {
  it("always_structured_subsection_present", () => {
    expect(interview_text).toContain("Always-Structured Rendering");
  });
  it("always_structured_option_a_label", () => {
    expect(interview_text).toContain("Option A");
  });
  it("always_structured_every_user_facing_question", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("every user-facing question must render via the structured");
  });
  it("always_structured_two_step_freeform", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("two-step flow");
  });
  it("always_structured_permissible_plain_text_emissions", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("only permissible plain-text-to-user emissions");
    expect(lower).toContain("status update");
  });
  it("always_structured_prose_anti_pattern", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("answer content is prose");
    expect(lower).toContain("preamble is long");
    expect(lower).toContain("feels conversational");
    expect(lower).toContain("prior question was plain-text");
  });
  it("rule6_mode_restore_subsection", () => {
    const rule6_start = interview_text.indexOf("### Rule 6:");
    const rule7_start = interview_text.indexOf("### Rule 7:");
    expect(rule6_start).not.toBe(-1);
    expect(rule7_start).not.toBe(-1);
    const rule6_block = interview_text.slice(rule6_start, rule7_start);
    expect(rule6_block).toContain("Mode Restore");
  });
  it("rule6_mode_released_after_commit", () => {
    const rule6_start = interview_text.indexOf("### Rule 6:");
    const rule7_start = interview_text.indexOf("### Rule 7:");
    const rule6_block = interview_text.slice(rule6_start, rule7_start);
    expect(rule6_block).toContain("RELEASED");
  });
  it("rule6_sticky_mode_anti_pattern", () => {
    const rule6_start = interview_text.indexOf("### Rule 6:");
    const rule7_start = interview_text.indexOf("### Rule 7:");
    const rule6_block = interview_text.slice(rule6_start, rule7_start).toLowerCase();
    expect(rule6_block).toContain("⊗ render the next user-facing question as plain-text");
  });
  it("rule6_gate_does_not_establish_sticky_mode", () => {
    const rule6_start = interview_text.indexOf("### Rule 6:");
    const rule7_start = interview_text.indexOf("### Rule 7:");
    const rule6_block = interview_text.slice(rule6_start, rule7_start).toLowerCase();
    expect(rule6_block).toContain("does not establish a sticky mode");
  });
  it("preamble_placement_subsection", () => {
    expect(interview_text).toContain("Preamble Placement");
  });
  it("preamble_above_tool_call", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("above the structured-tool call");
  });
  it("preamble_question_in_tool_field", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("`question` field");
    expect(lower).toContain("`options` field");
  });
  it("preamble_anti_pattern", () => {
    const lower = interview_text.toLowerCase();
    expect(
      lower.includes("⊗ render a user-facing question as plain-text because you wanted") ||
        lower.includes(
          "⊗ render a user-facing question as plain-text because you wanted to include",
        ),
    ).toBe(true);
  });
  it("setup_no_ask_if_user_wants_to_continue", () => {
    expect(setup_text).not.toContain("Ask if user wants to continue");
  });
  it("setup_phase_transition_structured_tool_must_rule", () => {
    const count = setup_text.split("Emit a structured-tool question").length - 1;
    expect(count).toBeGreaterThanOrEqual(3);
  });
  it("setup_phase_transition_options_yes_not_now_discuss_back", () => {
    expect(setup_text).toContain("Yes (continue)");
    expect(setup_text).toContain("Not now");
    expect(setup_text).toContain("Discuss");
    expect(setup_text).toContain("Back (revisit previous phase)");
  });
  it("setup_phase1_to_phase2_transition_structured", () => {
    const phase1_then_start = setup_text.indexOf("### Then", setup_text.indexOf("## Phase 1"));
    const phase2_start = setup_text.indexOf("## Phase 2");
    expect(phase1_then_start).not.toBe(-1);
    expect(phase2_start).not.toBe(-1);
    expect(phase1_then_start).toBeLessThan(phase2_start);
    const block = setup_text.slice(phase1_then_start, phase2_start);
    expect(block).toContain("Emit a structured-tool question");
    expect(block).toContain("Phase 2");
  });
  it("setup_phase2_to_phase3_transition_structured", () => {
    const phase2_then_start = setup_text.indexOf("### Then", setup_text.indexOf("## Phase 2"));
    const phase3_start = setup_text.indexOf("## Phase 3");
    expect(phase2_then_start).not.toBe(-1);
    expect(phase3_start).not.toBe(-1);
    expect(phase2_then_start).toBeLessThan(phase3_start);
    const block = setup_text.slice(phase2_then_start, phase3_start);
    expect(block).toContain("Emit a structured-tool question");
    expect(block).toContain("Phase 3");
  });
  it("setup_phase3_to_build_transition_structured", () => {
    const handoff_start = setup_text.indexOf("### Handoff to deft-directive-build");
    expect(handoff_start).not.toBe(-1);
    const block = setup_text.slice(handoff_start, handoff_start + 2000);
    expect(block).toContain("Emit a structured-tool question");
    expect(block).toContain("build phase");
    expect(block).toContain("Yes (continue)");
    expect(block).toContain("Back (revisit previous phase)");
    expect(block).not.toContain("Yes (start building now)");
    expect(block).not.toContain("Back (revisit the spec)");
  });
  it("no_rendering_policy_frontmatter", () => {
    expect(interview_text.startsWith("---")).toBeTruthy();
    const frontmatter_end = interview_text.indexOf("---", 3);
    expect(frontmatter_end).not.toBe(-1);
    const frontmatter = interview_text.slice(0, frontmatter_end);
    expect(frontmatter).not.toContain("rendering_policy");
  });
});
