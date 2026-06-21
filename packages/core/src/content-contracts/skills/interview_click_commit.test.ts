import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_interview_click_commit.py (#1838 #1530) */

const _INTERVIEW_PATH = "skills/deft-directive-interview/SKILL.md";

const interview_text = readRepoFile(_INTERVIEW_PATH);

describe("test_interview_click_commit", () => {
  it("click_commit_rendering_subsection_present", () => {
    expect(interview_text).toContain("Click-Commit Rendering");
  });
  it("click_commit_rendering_under_rule2", () => {
    const rule2_start = interview_text.indexOf("### Rule 2:");
    const rule3_start = interview_text.indexOf("### Rule 3:");
    expect(rule2_start).not.toBe(-1);
    expect(rule3_start).not.toBe(-1);
    const rule2_block = interview_text.slice(rule2_start, rule3_start);
    expect(rule2_block).toContain("Click-Commit Rendering");
  });
  it("click_commit_back_on_every_question_except_first", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("back` must appear on every question except the first");
  });
  it("click_commit_discuss_on_every_question", () => {
    const lower = interview_text.toLowerCase();
    expect(lower).toContain("discuss with agent` must appear on every question");
  });
  it("click_commit_default_marker", () => {
    const rule2_start = interview_text.indexOf("### Rule 2:");
    const rule3_start = interview_text.indexOf("### Rule 3:");
    const rule2_block = interview_text.slice(rule2_start, rule3_start).toLowerCase();
    expect(rule2_block).toContain("default marker");
    expect(rule2_block).toContain("[default]");
  });
  it("click_commit_back_anti_pattern", () => {
    expect(interview_text).toContain("⊗ Omit `Back`");
  });
  it("click_commit_discuss_anti_pattern", () => {
    expect(interview_text).toContain("⊗ Omit `Discuss with agent`");
  });
  it("click_commit_not_rule8_compliant", () => {
    const lower = interview_text.toLowerCase();
    expect(
      lower.includes("treat a click-commit tool's returned selection as a rule-8") ||
        lower.includes("treat a click-commit tool's atomic return as a rule-8-compliant"),
    ).toBe(true);
  });
  it("click_commit_example_block_present", () => {
    expect(interview_text).toContain("[ Back");
    expect(interview_text).toContain("[ Discuss with agent");
  });
  it("rule6_click_commit_plain_text_gate", () => {
    const rule6_start = interview_text.indexOf("### Rule 6:");
    const rule7_start = interview_text.indexOf("### Rule 7:");
    expect(rule6_start).not.toBe(-1);
    expect(rule7_start).not.toBe(-1);
    const rule6_block = interview_text.slice(rule6_start, rule7_start).toLowerCase();
    expect(rule6_block).toContain("click-commit");
    expect(rule6_block).toContain("plain-text");
    expect(rule6_block).toContain("typed response");
  });
  it("rule6_click_commit_gate_anti_pattern", () => {
    const rule6_start = interview_text.indexOf("### Rule 6:");
    const rule7_start = interview_text.indexOf("### Rule 7:");
    const rule6_block = interview_text.slice(rule6_start, rule7_start).toLowerCase();
    expect(rule6_block).toContain(
      "⊗ render the confirmation gate via a click-commit structured tool",
    );
  });
  it("rule6_strict_affirmative_tokens", () => {
    const rule6_start = interview_text.indexOf("### Rule 6:");
    const rule7_start = interview_text.indexOf("### Rule 7:");
    const rule6_block = interview_text.slice(rule6_start, rule7_start);
    expect(rule6_block).toContain("`yes`");
    expect(rule6_block).toContain("`confirmed`");
    expect(rule6_block).toContain("`approve`");
  });
  it("rule11_plain_text_mode_subsection", () => {
    const rule11_start = interview_text.indexOf("### Rule 11:");
    const anti_patterns_start = interview_text.indexOf("## Anti-Patterns");
    expect(rule11_start).not.toBe(-1);
    expect(anti_patterns_start).not.toBe(-1);
    const rule11_block = interview_text.slice(rule11_start, anti_patterns_start);
    expect(rule11_block).toContain("Plain-Text Rendering Mode");
  });
  it("rule11_click_commit_mode_subsection", () => {
    const rule11_start = interview_text.indexOf("### Rule 11:");
    const anti_patterns_start = interview_text.indexOf("## Anti-Patterns");
    const rule11_block = interview_text.slice(rule11_start, anti_patterns_start);
    expect(rule11_block).toContain("Click-Commit Rendering Mode");
  });
  it("rule11_plain_text_legend_every_question", () => {
    const rule11_start = interview_text.indexOf("### Rule 11:");
    const anti_patterns_start = interview_text.indexOf("## Anti-Patterns");
    const rule11_block = interview_text.slice(rule11_start, anti_patterns_start).toLowerCase();
    const expected = "must be present under every deterministic question in plain-text mode";
    expect(rule11_block).toContain(expected);
  });
  it("rule11_click_commit_affordances_as_options", () => {
    const rule11_start = interview_text.indexOf("### Rule 11:");
    const anti_patterns_start = interview_text.indexOf("## Anti-Patterns");
    const rule11_block = interview_text.slice(rule11_start, anti_patterns_start).toLowerCase();
    expect(rule11_block).toContain("clickable option");
  });
  it("rule11_click_commit_legend_may_be_omitted", () => {
    const rule11_start = interview_text.indexOf("### Rule 11:");
    const anti_patterns_start = interview_text.indexOf("## Anti-Patterns");
    const rule11_block = interview_text.slice(rule11_start, anti_patterns_start).toLowerCase();
    expect(rule11_block).toContain("may be omitted in click-commit");
  });
  it("rule11_click_commit_affordances_still_present", () => {
    const rule11_start = interview_text.indexOf("### Rule 11:");
    const anti_patterns_start = interview_text.indexOf("## Anti-Patterns");
    const rule11_block = interview_text.slice(rule11_start, anti_patterns_start);
    expect(rule11_block).toContain("⊗ Omit `Back`");
    expect(rule11_block).toContain("Discuss with agent`");
  });
});
