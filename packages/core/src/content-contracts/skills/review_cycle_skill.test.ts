import { describe, expect, it } from "vitest";
import { readSkill } from "./helpers.js";

/** Port of tests/content/test_review_cycle_skill.py (#1838 #1530) */

const REVIEW_CYCLE_PATH = "skills/deft-directive-review-cycle/SKILL.md";

function readReviewCycleSkill(): string {
  return readSkill(REVIEW_CYCLE_PATH);
}

function phase2Step1Section(): string {
  const text = readReviewCycleSkill();
  const step1Start = text.indexOf("### Step 1: Fetch ALL bot comments");
  const step2Start = text.indexOf("### Step 2: Analyze ALL findings before changing anything");
  expect(step1Start).not.toBe(-1);
  expect(step2Start).not.toBe(-1);
  expect(step1Start).toBeLessThan(step2Start);
  return text.slice(step1Start, step2Start);
}

function informalCleanSection(): string {
  const text = readReviewCycleSkill();
  const start = text.indexOf("### Informal-clean missing canonical fields (#1543)");
  expect(start).not.toBe(-1);
  const endMarkers = [
    text.indexOf("## Submitting GitHub Reviews", start),
    text.indexOf("## Anti-Patterns", start),
  ].filter((i) => i !== -1);
  const end = Math.min(...endMarkers);
  return text.slice(start, end);
}

function step6Section(): string {
  const text = readReviewCycleSkill();
  const start = text.indexOf("### Step 6:");
  expect(start).not.toBe(-1);
  const end = text.indexOf("\n## ", start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("test_review_cycle_skill", () => {
  it("phase2_step1_late_arriving_bot_review_should_rule_present", () => {
    const section = phase2Step1Section();
    expect(section).toContain("Late-arriving bot review re-check");
    expect(/^~ \*\*Late-arriving bot review re-check:\*\*/m.test(section)).toBe(true);
  });

  it("phase2_step1_late_arriving_re_fetch_token", () => {
    expect(phase2Step1Section()).toContain("re-fetch");
  });

  it("phase2_step1_late_arriving_60s_token", () => {
    expect(phase2Step1Section()).toContain("60s");
  });

  it("phase2_step1_late_arriving_before_evaluating_token", () => {
    expect(phase2Step1Section()).toContain("before evaluating");
  });

  it("phase2_step1_no_single_fetch_exit_must_not_rule_present", () => {
    expect(
      /^\u2297 Declare the exit condition met based on a single fetch/m.test(phase2Step1Section()),
    ).toBe(true);
  });

  it("phase2_step1_no_single_fetch_exit_re_fetch_recovery_token", () => {
    expect(phase2Step1Section()).toContain("re-fetch at least once");
  });

  it("phase2_step1_late_arriving_references_poller_template", () => {
    expect(phase2Step1Section()).toContain("templates/swarm-greptile-poller-prompt.md");
  });

  it("greptile_informal_clean_section_present", () => {
    expect(informalCleanSection()).toContain("informal-clean missing-canonical-fields");
  });

  it("greptile_informal_clean_recovery_path_tokens", () => {
    const section = informalCleanSection();
    expect(section).toContain("@greptileai review");
    expect(section.includes("documented override") || section.includes("operator override")).toBe(
      true,
    );
    expect(
      section.includes("Do NOT keep polling") ||
        section.toLowerCase().includes("do not keep polling"),
    ).toBe(true);
  });

  it("greptile_informal_clean_must_not_accept_prose_alone", () => {
    expect(/^\u2297 Treat informal clean Greptile prose/m.test(informalCleanSection())).toBe(true);
  });

  it("greptile_informal_clean_references_poller_template", () => {
    const section = informalCleanSection();
    expect(section).toContain("templates/swarm-greptile-poller-prompt.md");
    expect(section).toContain("(6) INFORMAL-CLEAN");
  });

  it("step6_is_fail_closed_all_of", () => {
    const section = step6Section();
    expect(section).toContain("fail-closed");
    expect(section).toContain("ReviewerStatus");
    expect(section).toContain("unknown");
    expect(section).toContain("#1259");
  });

  it("step6_requires_terminal_check_run", () => {
    const section = step6Section();
    expect(section).toContain('status == "completed"');
    expect(section).toContain("success");
    expect(section).toContain("neutral");
    for (const bad of ["cancelled", "timed_out", "stale", "action_required", "failure"]) {
      expect(section).toContain(bad);
    }
  });

  it("step6_requires_sha_pinned_completion_marker", () => {
    const section = step6Section();
    expect(section).toContain("Last reviewed commit:");
    expect(
      section.includes("AT READ TIME") || section.includes("head_sha_reviewed == current HEAD"),
    ).toBe(true);
    expect(section).toContain(String.raw`Last reviewed commit:\s*\[.*?\]\(`);
  });

  it("step6_requires_confidence_and_no_p0_p1", () => {
    const section = step6Section();
    expect(section).toContain("Confidence");
    expect(section.includes("> 3") || section.includes("greater than 3")).toBe(true);
    expect(section).toContain("P0");
    expect(section).toContain("P1");
  });

  it("step6_confidence_alone_anti_pattern_present", () => {
    expect(/^\u2297 Exit the loop on a confidence number alone/m.test(step6Section())).toBe(true);
  });

  it("pre_merge_re_poll_gate_present", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("## Pre-Merge Re-Poll Gate (#1259)");
    const start = text.indexOf("## Pre-Merge Re-Poll Gate (#1259)");
    const end = text.indexOf("\n## ", start + 1);
    const section = text.slice(start, end === -1 ? undefined : end);
    expect(section).toContain("gh pr merge");
    expect(section).toContain("re-fetch");
    expect(/^\u2297 Call `gh pr merge` on the strength of a review verdict/m.test(section)).toBe(
      true,
    );
  });

  it("incomplete_but_rated_stall_signature_present", () => {
    expect(readReviewCycleSkill()).toContain("INCOMPLETE_BUT_RATED");
  });

  it("phase2_step1_no_cp1252_mojibake", () => {
    expect(phase2Step1Section()).not.toContain("\u0393\u00E8\u00F9");
  });
});
