import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_interview_deterministic.py (#1838 #1530) */

const _INTERVIEW_PATH = "skills/deft-directive-interview/SKILL.md";
const _AGENTS_POINTER_PATH = ".agents/skills/deft-directive-interview/SKILL.md";
const _CANONICAL_LEGEND = "Enter confirm / b back / 0 discuss";

const interview_text = readRepoFile(_INTERVIEW_PATH);

describe("test_interview_deterministic", () => {
  it("rule8_heading_present", () => {
    expect(interview_text).toContain("### Rule 8: Deterministic Selection Confirmation");
  });
  it("rule2_host_portable_numeric_labels", () => {
    expect(interview_text).toContain("Host-portable numeric labels (#1563)");
    expect(interview_text).toContain("visibly preserves each canonical numeric option label");
    expect(interview_text).toContain("exact displayed option text");
    expect(interview_text).toContain("do not infer from host-added letters");
  });
  it("rule8_confirm_step_is_mandatory", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("confirm-after-number-press");
    expect(lower).toContain("number entry alone must not advance");
  });
  it("rule8_echoes_selected_option", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("echo the selected option");
  });
  it("rule8_waits_for_enter", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("enter to confirm");
    expect(lower).toContain("wait for enter");
  });
  it("rule8_anti_pattern_auto_advance", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("auto-advance");
    expect(lower).toContain("number key");
  });
  it("rule9_heading_present", () => {
    expect(interview_text).toContain("### Rule 9: Backward Navigation");
  });
  it("rule9_back_keys_listed", () => {
    for (const key of ["`b`", "`back`", "`prev`"]) {
      expect(interview_text).toContain(key);
    }
  });
  it("rule9_back_nav_visible_in_legend", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("back-navigation affordance must be visible on every question");
  });
  it("rule9_anti_pattern_hidden_back", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("hide the back-navigation affordance");
  });
  it("rule10_heading_present", () => {
    expect(interview_text).toContain("### Rule 10: Freeform Conversation Escape");
  });
  it("rule10_slot0_label_is_discuss_with_agent", () => {
    expect(interview_text).toContain("0. Discuss with agent");
  });
  it("rule10_slot0_distinct_from_other", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("distinct from `other / i don't know`");
  });
  it("rule10_slot0_visually_separated", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("visually separated");
    expect(lower.includes("horizontal rule") || lower.includes("blank line")).toBe(true);
  });
  it("rule10_anti_pattern_merge_discuss_with_other", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("merge slot-0 `discuss with agent` with `other");
  });
  it("rule10_anti_pattern_no_pause_escape_labels", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("non-self-describing label for slot 0");
  });
  it("rule10_old_pause_label_not_present", () => {
    expect(interview_text).not.toContain("Pause -- discuss this question with the agent");
  });
  it("rule11_heading_present", () => {
    expect(interview_text).toContain("### Rule 11: Persistent Legend Under Each Question");
  });
  it("rule11_canonical_legend_present", () => {
    expect(interview_text).toContain(_CANONICAL_LEGEND);
  });
  it("rule11_legend_in_rule2_example", () => {
    const rule2_start = interview_text.indexOf("### Rule 2:");
    const rule3_start = interview_text.indexOf("### Rule 3:");
    expect(rule2_start).not.toBe(-1);
    expect(rule3_start).not.toBe(-1);
    const rule2_block = interview_text.slice(rule2_start, rule3_start);
    expect(rule2_block).toContain(_CANONICAL_LEGEND);
  });
  it("rule11_legend_in_rule8_example", () => {
    const rule8_start = interview_text.indexOf("### Rule 8:");
    const rule9_start = interview_text.indexOf("### Rule 9:");
    expect(rule8_start).not.toBe(-1);
    expect(rule9_start).not.toBe(-1);
    const rule8_block = interview_text.slice(rule8_start, rule9_start);
    expect(rule8_block).toContain(_CANONICAL_LEGEND);
  });
  it("rule11_legend_every_question", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("must be present under every deterministic question");
  });
  it("rule11_anti_pattern_missing_legend", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("without the persistent");
    expect(lower).toContain("legend");
  });
  it("agents_pointer_exists_and_points_to_canonical", () => {
    const pointer = _AGENTS_POINTER_PATH;
    expect(repoFileExists(pointer)).toBeTruthy();
    const text = readRepoFile(pointer);
    expect(text).toContain("skills/deft-directive-interview/SKILL.md");
  });
});
