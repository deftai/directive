import { describe, expect, it } from "vitest";
import {
  BODY_AC4_EMPTY,
  BODY_AC4_INLINE_SHA_CLEAN,
  BODY_AC4_MARKDOWN_LINK_CLEAN,
  BODY_AC4_THIRD_CONFIDENCE_FORM,
  BODY_AC4_TRUNCATED,
  BODY_CLEAN,
  BODY_CONFIDENCE_HEADING_ONLY,
  BODY_ESCAPED_BRACKET_LINK_TEXT,
  BODY_FENCED_IMG_P0,
  BODY_FENCED_NOT_SAFE,
  BODY_HTML_CODE_IMG_P0,
  BODY_NEGATION_GUARDED,
  BODY_SLIZARD_HEADING_NEGATION,
  BODY_SLIZARD_HEADING_P1,
  BODY_TIER1_BADGES_ONLY,
  BODY_TIER2_P1_ONLY,
  BODY_TIER3_COUNT_PROSE_ONLY,
  BODY_TIER3_NOT_SAFE_ONLY,
  BODY_UNFENCED_IMG_P0,
  detect,
  evaluateCleanGate,
  parseConfidence,
  parseLastReviewedShaMarkdownLink,
  parseLastReviewedShaNaiveInline,
  simulatePollLoop,
} from "./greptile-detector.js";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_swarm_poller_template.py (#1838 #1530) */

const templateText = readRepoFile("templates/swarm-greptile-poller-prompt.md");

const CONFIDENCE_INLINE_RE = /Confidence Score:\s*(\d+)\s*\/\s*5/;
const CONFIDENCE_HEADING_RE = /^#{1,6}\s*Confidence Score:\s*(\d+)\s*\/\s*5\s*$/m;
const GREEDY_NEGATED_BRACKET_SHA_RE =
  /Last reviewed commit:\s*\[[^\]]*\]\(https?:\/\/github\.com\/[^/]+\/[^/]+\/commit\/(?<sha>[0-9a-f]{7,40})/;

const ESCAPED_BRACKET_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334";
const HEAD_SHA = "abcdef1234567";

function formatTemplate(text: string, overrides: Record<string, string | number> = {}): string {
  const vals = {
    pr_number: 910,
    repo: "deftai/directive",
    poll_interval_seconds: 90,
    poll_cap_minutes: 30,
    parent_agent_id: "parent-id",
    ...overrides,
  };
  let rendered = text.replace(/\{\{/g, "\0OPEN\0").replace(/\}\}/g, "\0CLOSE\0");
  for (const [k, v] of Object.entries(vals)) {
    rendered = rendered.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return rendered.replace(/\0OPEN\0/g, "{").replace(/\0CLOSE\0/g, "}");
}

describe("test_swarm_poller_template", () => {
  it("tier2_markdown_bullet_p1_only_triggers_blocking", () => {
    const result = detect(BODY_TIER2_P1_ONLY);
    expect(result.tier1_p0).toBe(0);
    expect(result.tier1_p1).toBe(0);
    expect(result.tier2_p1).toBeGreaterThanOrEqual(1);
    expect(result.has_blocking === true).toBe(true);
  });
  it("tier3_not_safe_to_merge_sentinel_only_triggers_blocking", () => {
    const result = detect(BODY_TIER3_NOT_SAFE_ONLY);
    expect(result.tier1_p0).toBe(0);
    expect(result.tier1_p1).toBe(0);
    expect(result.tier2_p0).toBe(0);
    expect(result.tier2_p1).toBe(0);
    expect(result.tier3_sentinel === true).toBe(true);
    expect(result.has_blocking === true).toBe(true);
  });
  it("tier3_count_prose_three_p1_findings_triggers_blocking", () => {
    const result = detect(BODY_TIER3_COUNT_PROSE_ONLY);
    expect(result.tier1_p0).toBe(0);
    expect(result.tier1_p1).toBe(0);
    expect(result.tier2_p0).toBe(0);
    expect(result.tier2_p1).toBe(0);
    expect(result.tier3_sentinel === true).toBe(true);
    expect(result.has_blocking === true).toBe(true);
  });
  it("negation_guard_no_p0_zero_p1_does_not_trigger", () => {
    const result = detect(BODY_NEGATION_GUARDED);
    expect(result.tier1_p0).toBe(0);
    expect(result.tier1_p1).toBe(0);
    expect(result.tier2_p0).toBe(0);
    expect(result.tier2_p1).toBe(0);
    expect(result.tier3_sentinel === false).toBe(true);
    expect(result.has_blocking === false).toBe(true);
  });
  it("clean_body_no_findings_does_not_trigger", () => {
    const result = detect(BODY_CLEAN);
    expect(result.has_blocking === false).toBe(true);
    expect(result.p0_count).toBe(0);
    expect(result.p1_count).toBe(0);
  });
  it("tier1_pure_badge_body_still_triggers", () => {
    const result = detect(BODY_TIER1_BADGES_ONLY);
    expect(result.tier1_p0).toBe(1);
    expect(result.tier1_p1).toBe(2);
    expect(result.has_blocking === true).toBe(true);
  });
  it("fenced_img_p0_does_not_trigger_tier1", () => {
    const result = detect(BODY_FENCED_IMG_P0);
    expect(result.tier1_p0).toBe(0);
    expect(result.tier1_p1).toBe(0);
    expect(result.has_blocking === false).toBe(true);
  });
  it("fenced_not_safe_to_merge_does_not_trigger_tier3", () => {
    const result = detect(BODY_FENCED_NOT_SAFE);
    expect(result.tier3_sentinel === false).toBe(true);
    expect(result.has_blocking === false).toBe(true);
  });
  it("unfenced_img_p0_still_triggers_tier1", () => {
    const result = detect(BODY_UNFENCED_IMG_P0);
    expect(result.tier1_p0).toBe(1);
    expect(result.has_blocking === true).toBe(true);
  });
  it("html_code_block_img_p0_does_not_trigger_tier1", () => {
    const result = detect(BODY_HTML_CODE_IMG_P0);
    expect(result.tier1_p0).toBe(0);
    expect(result.tier1_p1).toBe(0);
    expect(result.has_blocking === false).toBe(true);
  });
  it("negative_control_pre_tier25_detector_misses_slizard_heading", () => {
    const result = detect(BODY_SLIZARD_HEADING_P1);
    expect(result.tier1_p0).toBe(0);
    expect(result.tier1_p1).toBe(0);
    expect(result.tier2_p0).toBe(0);
    expect(result.tier2_p1).toBe(0);
    expect(result.tier3_sentinel === false).toBe(true);
  });
  it("tier25_slizard_heading_p1_triggers_blocking", () => {
    const result = detect(BODY_SLIZARD_HEADING_P1);
    expect(result.tier25_p1).toBe(1);
    expect(result.tier25_p0).toBe(0);
    expect(result.p1_count).toBe(1);
    expect(result.has_blocking === true).toBe(true);
  });
  it("tier25_negation_guard_rejects_no_p1_heading", () => {
    const result = detect(BODY_SLIZARD_HEADING_NEGATION);
    expect(result.tier25_p0).toBe(0);
    expect(result.tier25_p1).toBe(0);
    expect(result.has_blocking === false).toBe(true);
  });
  it("confidence_heading_form_parses_to_same_score_as_inline", () => {
    const body = BODY_CONFIDENCE_HEADING_ONLY;
    const inlineMatch = CONFIDENCE_INLINE_RE.exec(body);
    const headingMatch = CONFIDENCE_HEADING_RE.exec(body);
    expect(inlineMatch).not.toBeNull();
    expect(headingMatch).not.toBeNull();
    expect(Number.parseInt(inlineMatch?.[1] ?? "", 10)).toBe(
      Number.parseInt(headingMatch?.[1] ?? "", 10),
    );
    expect(Number.parseInt(headingMatch?.[1] ?? "", 10)).toBe(3);
    expect(parseConfidence(body)).toBe(3);
  });
  it("confidence_heading_form_only_parses_when_inline_misses", () => {
    const body = "#### Confidence Score: 4/5\n\nbody text\n";
    expect(parseConfidence(body)).toBe(4);
  });
  it("confidence_zero_score_parses_via_slash_form", () => {
    expect(parseConfidence("## Confidence Score: 0/5\n")).toBe(0);
    const bodyStray = "## Confidence Score: 0 out of 5\n";
    expect(CONFIDENCE_HEADING_RE.exec(bodyStray)).toBeNull();
    expect(parseConfidence(bodyStray)).toBeNull();
  });
  it("confidence_parses_inline_form_unchanged", () => {
    expect(parseConfidence(BODY_TIER2_P1_ONLY)).toBe(4);
    expect(parseConfidence(BODY_TIER3_NOT_SAFE_ONLY)).toBe(3);
    expect(parseConfidence(BODY_CLEAN)).toBe(5);
  });
  it("template_contains_non_greedy_last_reviewed_sha_regex", () => {
    expect(templateText).toContain("Last reviewed commit:\\s*\\[.*?\\]\\(");
    expect(templateText).not.toContain("Last reviewed commit:\\s*\\[[^\\]]*\\]\\(");
    expect(templateText).toContain("#1326");
    const rendered = formatTemplate(templateText, { pr_number: 1326 });
    expect(rendered).toContain("Last reviewed commit:\\s*\\[.*?\\]\\(");
  });
  it("template_contains_code_fence_strip", () => {
    expect(templateText).toContain("`{{3}}.*?`{{3}}");
    expect(templateText).toContain("<(code|pre)\\b[^>]*>.*?</\\1>");
    expect(templateText).toContain("def strip_code_fences(");
    expect(templateText).toContain("body = strip_code_fences(body)");
    expect(templateText).toContain("#1004");
    const rendered = formatTemplate(templateText, { pr_number: 1004 });
    expect(rendered).toContain("`{3}.*?`{3}");
  });
  it("template_documents_residual_self_reference", () => {
    expect(templateText).toContain("residual self-reference false-positive remains (#1004)");
  });
  it("template_contains_tier2_regex", () => {
    expect(templateText).toContain("^[\\s\\-\\*]*\\*\\*P([01])\\b[^*]*\\*\\*");
    for (const token of ['"No "', '"Zero "', '"0 "', '"no "']) {
      expect(templateText).toContain(token);
    }
  });
  it("template_contains_tier3_count_prose_regex", () => {
    expect(templateText).toContain(
      "\\b(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\\d+)\\s+P[01]\\s+findings?\\b",
    );
  });
  it("template_contains_tier3_line_anchored_regex", () => {
    expect(templateText).toContain("^\\s*P[01]\\s+--\\s");
  });
  it("template_contains_not_safe_to_merge_substring", () => {
    expect(templateText).toContain("Not safe to merge");
  });
  it("template_contains_tier1_badge_count_strings", () => {
    expect(templateText).toContain("body.count('<img alt=\"P0\"')");
    expect(templateText).toContain("body.count('<img alt=\"P1\"')");
  });
  it("template_combined_verdict_uses_max_per_severity", () => {
    expect(templateText).toContain("max(tier1_p0, tier2_p0, tier25_p0)");
    expect(templateText).toContain("max(tier1_p1, tier2_p1, tier25_p1)");
    expect(templateText).toContain("tier3_sentinel");
  });
  it("template_contains_tier25_regex", () => {
    expect(templateText).toContain("^#{{1,6}}\\s+P([01])\\s*[\\u00b7\\u2027\\u2022\\-]\\s");
    const rendered = formatTemplate(templateText, { pr_number: 1035 });
    expect(rendered).toContain("^#{1,6}\\s+P([01])\\s*[\\u00b7\\u2027\\u2022\\-]\\s");
  });
  it("template_contains_confidence_heading_regex", () => {
    expect(templateText).toContain("^#{{1,6}}\\s*Confidence Score:\\s*(\\d+)\\s*/\\s*5\\s*$");
    const rendered = formatTemplate(templateText, { pr_number: 1035 });
    expect(rendered).toContain("^#{1,6}\\s*Confidence Score:\\s*(\\d+)\\s*/\\s*5\\s*$");
  });
  it("template_tier25_recurrence_citation", () => {
    expect(templateText).toContain("#1035");
    expect(templateText).toContain("Tier 2.5");
  });
  it("template_section_heading_marks_triple_tier", () => {
    expect(templateText).toContain("TRIPLE-TIER");
    expect(templateText).toContain("#910");
  });
  it("template_recurrence_record_three_false_negatives", () => {
    expect(
      templateText.toLowerCase().includes("three false-negatives") ||
        templateText.toLowerCase().includes("three false-negative"),
    ).toBe(true);
  });
  it("template_renders_via_format", () => {
    const rendered = formatTemplate(templateText, {
      pr_number: 910,
      parent_agent_id: "parent-id-xyz",
    });
    expect(rendered).toContain("PR #910");
    expect(rendered).toContain("deftai/directive");
  });
  it("escaped_bracket_link_text_extracts_sha_non_greedy", () => {
    expect(GREEDY_NEGATED_BRACKET_SHA_RE.exec(BODY_ESCAPED_BRACKET_LINK_TEXT)).toBeNull();
    expect(parseLastReviewedShaMarkdownLink(BODY_ESCAPED_BRACKET_LINK_TEXT)).toBe(
      ESCAPED_BRACKET_SHA,
    );
  });
  it("escaped_bracket_link_text_clean_review_exits_clean", () => {
    const [exitClass, pollsRun, holdout] = simulatePollLoop({
      body: BODY_ESCAPED_BRACKET_LINK_TEXT,
      headSha: ESCAPED_BRACKET_SHA,
      maxPolls: 5,
    });
    expect(exitClass).toBe("CLEAN");
    expect(pollsRun).toBe(1);
    expect(holdout).toBeNull();
  });
  it("ac4_markdown_link_sha_clean_exits_clean_within_one_poll", () => {
    const [exitClass, pollsRun, holdout] = simulatePollLoop({
      body: BODY_AC4_MARKDOWN_LINK_CLEAN,
      headSha: HEAD_SHA,
      maxPolls: 5,
    });
    expect(exitClass).toBe("CLEAN");
    expect(pollsRun).toBe(1);
    expect(holdout).toBeNull();
  });
  it("ac4_inline_sha_clean_exits_stall_within_three_polls", () => {
    expect(parseLastReviewedShaNaiveInline(BODY_AC4_INLINE_SHA_CLEAN)).toBe(HEAD_SHA);
    expect(parseLastReviewedShaMarkdownLink(BODY_AC4_INLINE_SHA_CLEAN)).toBeNull();
    const [exitClass, pollsRun, holdout] = simulatePollLoop({
      body: BODY_AC4_INLINE_SHA_CLEAN,
      headSha: HEAD_SHA,
      maxPolls: 5,
    });
    expect(exitClass).toBe("STALL");
    expect(pollsRun).toBe(3);
    expect(holdout).toBe("sha_match");
  });
  it("ac4_third_confidence_form_exits_stall_within_three_polls", () => {
    expect(parseLastReviewedShaMarkdownLink(BODY_AC4_THIRD_CONFIDENCE_FORM)).toBe(HEAD_SHA);
    expect(parseConfidence(BODY_AC4_THIRD_CONFIDENCE_FORM)).toBeNull();
    const [exitClass, pollsRun, holdout] = simulatePollLoop({
      body: BODY_AC4_THIRD_CONFIDENCE_FORM,
      headSha: HEAD_SHA,
      maxPolls: 5,
    });
    expect(exitClass).toBe("STALL");
    expect(pollsRun).toBe(3);
    expect(holdout).toBe("confidence");
  });
  it.each([
    ["empty", BODY_AC4_EMPTY],
    ["truncated", BODY_AC4_TRUNCATED],
  ])("ac4_empty_or_truncated_body_exits_stall_within_three_polls %s", (_, body) => {
    const [exitClass, pollsRun, holdout] = simulatePollLoop({
      body,
      headSha: HEAD_SHA,
      maxPolls: 5,
    });
    expect(exitClass).toBe("STALL");
    expect(pollsRun).toBe(3);
    expect(holdout).toBe("sha_match");
  });
  it("ac4_per_poll_instrumentation_line_present_in_log", () => {
    const [, , , logLines] = simulatePollLoop({
      body: BODY_AC4_INLINE_SHA_CLEAN,
      headSha: HEAD_SHA,
      maxPolls: 5,
    });
    expect(logLines.length).toBeGreaterThanOrEqual(1);
    const expectedFieldOrder = [
      "last_reviewed_sha=",
      "head=",
      "sha_match=",
      "confidence=",
      "has_blocking=",
      "p0=",
      "p1=",
      "errored=",
      "ci_failures=",
      "is_clean=",
      "clean_gate_holdout=",
    ];
    for (const line of logLines) {
      expect(line.startsWith("[poll ")).toBe(true);
      let prevIdx = -1;
      for (const field of expectedFieldOrder) {
        const idx = line.indexOf(field);
        expect(idx).not.toBe(-1);
        expect(idx).toBeGreaterThan(prevIdx);
        prevIdx = idx;
      }
    }
  });
  it("ac3_clean_gate_holdout_names_first_failing_condition", () => {
    expect(
      evaluateCleanGate({
        lastReviewedSha: null,
        headSha: HEAD_SHA,
        hasBlocking: false,
        confidence: null,
        ciFailures: 0,
        errored: false,
      }),
    ).toEqual([false, "sha_match"]);
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD_SHA,
        headSha: HEAD_SHA,
        hasBlocking: true,
        confidence: 2,
        ciFailures: 0,
        errored: false,
      }),
    ).toEqual([false, "has_blocking"]);
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD_SHA,
        headSha: HEAD_SHA,
        hasBlocking: false,
        confidence: 2,
        ciFailures: 3,
        errored: false,
      }),
    ).toEqual([false, "confidence"]);
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD_SHA,
        headSha: HEAD_SHA,
        hasBlocking: false,
        confidence: 5,
        ciFailures: 1,
        errored: true,
      }),
    ).toEqual([false, "ci_failures"]);
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD_SHA,
        headSha: HEAD_SHA,
        hasBlocking: false,
        confidence: 5,
        ciFailures: 0,
        errored: true,
      }),
    ).toEqual([false, "errored"]);
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD_SHA,
        headSha: HEAD_SHA,
        hasBlocking: false,
        confidence: 5,
        ciFailures: 0,
        errored: false,
      }),
    ).toEqual([true, null]);
  });
  it("ac4_regression_clean_exit_unchanged_on_pre_1039_bodies", () => {
    const cleanHead = "1111111aaa2222b";
    expect(simulatePollLoop({ body: BODY_CLEAN, headSha: cleanHead, maxPolls: 5 })).toEqual([
      "CLEAN",
      1,
      null,
      expect.any(Array),
    ]);
    const slizardHead = "3333333abcdef12";
    const [exitClass, pollsRun, holdout] = simulatePollLoop({
      body: BODY_SLIZARD_HEADING_P1,
      headSha: slizardHead,
      maxPolls: 5,
    });
    expect(exitClass).toBe("NEW_P0P1");
    expect(pollsRun).toBe(1);
    expect(holdout).toBe("has_blocking");
  });
  it("incomplete_but_rated_non_terminal_check_run_does_not_exit_clean", () => {
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD_SHA,
        headSha: HEAD_SHA,
        hasBlocking: false,
        confidence: 5,
        ciFailures: 0,
        errored: false,
        terminalCheckRun: false,
      }),
    ).toEqual([false, "terminal_check_run"]);
    const [exitClass, , holdout] = simulatePollLoop({
      body: BODY_AC4_MARKDOWN_LINK_CLEAN,
      headSha: HEAD_SHA,
      ciFailures: 0,
      maxPolls: 5,
      stallThreshold: 3,
      terminalCheckRun: false,
    });
    expect(exitClass).not.toBe("CLEAN");
    expect(exitClass).toBe("STALL");
    expect(holdout).toBe("terminal_check_run");
    const [cleanExit, , cleanHoldout] = simulatePollLoop({
      body: BODY_AC4_MARKDOWN_LINK_CLEAN,
      headSha: HEAD_SHA,
      terminalCheckRun: true,
    });
    expect([cleanExit, cleanHoldout]).toEqual(["CLEAN", null]);
  });
  it("template_section_intro_says_six_terminal_exits", () => {
    expect(templateText).toContain("six terminal exit conditions");
    expect(templateText).toContain("When ANY of the six conditions below fires");
  });
  it("template_contains_evaluate_clean_gate_function", () => {
    expect(templateText).toContain("def evaluate_clean_gate(");
    for (const holdout_name of [
      '"sha_match"',
      '"has_blocking"',
      '"confidence"',
      '"ci_failures"',
      '"errored"',
    ]) {
      expect(templateText).toContain(holdout_name);
    }
  });
  it("template_clean_gate_enforces_terminal_check_run", () => {
    const gate_start = templateText.indexOf("def evaluate_clean_gate(");
    const gate_block = templateText.slice(gate_start, gate_start + 2200);
    expect(gate_block).toContain("terminal_check_run,");
    expect(gate_block).toContain("if not terminal_check_run:");
    expect(gate_block).toContain('return False, "terminal_check_run"');
    expect(templateText).toContain("terminal_check_run=greptile_terminal");
    const clean_start = templateText.indexOf("### (1) CLEAN\n\nALL of:");
    const clean_block = templateText.slice(clean_start, clean_start + 1600);
    expect(clean_block).toContain("terminal_check_run");
    expect(clean_block).toContain('status == "completed"');
    expect(clean_block).toContain("{{success, neutral}}");
    expect(clean_block).toContain("INCOMPLETE_BUT_RATED");
  });
  it("template_contains_stall_terminal_exit", () => {
    expect(templateText).toContain("### (5) STALL");
    expect(templateText).toContain("poll loop wedged -- terminal-condition detection failure");
    const stall_idx = templateText.indexOf("### (5) STALL");
    const stall_block = templateText.slice(stall_idx, stall_idx + 2000);
    expect(stall_block).toContain("clean_gate_holdout:");
    expect(stall_block).toContain("-- no more polling, exiting now");
    expect(
      templateText.includes("3 consecutive wedged polls") ||
        (templateText.includes("N=3") && templateText.includes("3 consecutive polls")) ||
        templateText.includes("stall_streak >= 3"),
    ).toBe(true);
    expect(templateText).toContain("~4.5 min");
  });
  it("template_contains_clean_gate_holdout_in_timeout", () => {
    const timeout_idx = templateText.indexOf("### (4) TIMEOUT");
    const next_section_idx = templateText.indexOf("### (5) STALL", timeout_idx);
    const timeout_block = templateText.slice(timeout_idx, next_section_idx);
    expect(timeout_block).toContain("clean_gate_holdout:");
  });
  it("template_contains_tier1_instrumentation_log", () => {
    expect(templateText).toContain("[poll {{i}}/{{cap}}]");
    const instr_start = templateText.indexOf("[poll {{i}}/{{cap}}]");
    const instr_window = templateText.slice(instr_start, instr_start + 800);
    const expected_field_tokens = [
      "last_reviewed_sha=",
      "head=",
      "sha_match=",
      "confidence=",
      "has_blocking=",
      "p0=",
      "p1=",
      "errored=",
      "ci_failures=",
      "is_clean=",
      "clean_gate_holdout=",
    ];
    let prevIdx = -1;
    for (const token of expected_field_tokens) {
      const idx = instr_window.indexOf(token);
      expect(idx).not.toBe(-1);
      expect(idx).toBeGreaterThan(prevIdx);
      prevIdx = idx;
    }
    const rendered = formatTemplate(templateText, { pr_number: 1039 });
    expect(rendered).toContain("[poll {i}/{cap}]");
  });
  it("template_status_message_list_includes_stall", () => {
    expect(templateText).toContain(
      "(CLEAN / NEW P0/P1 FINDINGS escalation / ERRORED / TIMEOUT / STALL)",
    );
  });
  it("template_recurrence_record_cites_1039", () => {
    expect(templateText).toContain("#1039");
    expect(templateText).toContain("PR #1038");
    expect(templateText).toContain("5794b0e7");
  });
  it("greptile_informal_clean_detector_in_template", () => {
    expect(templateText).toContain("is_informal_clean_missing_canonical_fields");
    expect(templateText).toContain("informal-clean missing-canonical-fields");
    expect(templateText).toContain("current diff is clean");
  });
  it("greptile_informal_clean_terminal_exit_in_template", () => {
    expect(templateText).toContain("### (6) INFORMAL-CLEAN");
    expect(templateText).toContain("informal-clean missing canonical fields -- recovery required");
    const informal_idx = templateText.indexOf(
      "Subject: PR #{pr_number} informal-clean missing canonical fields",
    );
    const informal_block = templateText.slice(informal_idx, informal_idx + 1500);
    expect(informal_block).toContain("@greptileai review");
    expect(informal_block).toContain("-- no more polling, exiting now");
    expect(
      !informal_block.includes("swarm:verify-review-clean") ||
        informal_block.includes('NOT a "review complete" signal'),
    ).toBe(true);
  });
  it("greptile_informal_clean_not_stall_fallback", () => {
    expect(templateText).toContain("Do NOT increment `stall_streak` toward `(5) STALL`");
  });
  it("template_platform_adapter_unification_1342_phase6", () => {
    expect(templateText).toContain("platform adapter");
    expect(templateText.includes("spawn_subagent") || templateText.includes("Grok Build")).toBe(
      true,
    );
    expect(templateText).toContain("#1342");
  });
});
