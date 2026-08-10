import { describe, expect, it } from "vitest";
import { readRepoFile, readSkill } from "./helpers.js";

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

  it("babysit_intent_triggers_present_in_references_index", () => {
    const references = readRepoFile("REFERENCES.md");
    for (const trigger of [
      "babysit-pull-request-in-cloud",
      "babysit",
      "shepherd",
      "watch the PR",
    ]) {
      expect(references).toContain(trigger);
    }
  });

  it("cursor_global_babysit_supersession_section_present", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("Cursor global babysit supersession (#2261)");
    expect(text).toContain("babysit-pull-request-in-cloud");
    expect(text).toContain("skills-cursor/babysit");
  });

  it("ad_hoc_slizard_fix_not_exit_predicate_anti_pattern_present", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("ad hoc fix commit as the review-cycle exit predicate");
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

  it("mechanical_mergeability_necessary_never_sufficient_section_present (#3225)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("## Mechanical mergeability is necessary, never sufficient (#3225)");
    expect(text).toContain("should-not-merge");
    expect(text).toContain("minGreptileConfidence");
    expect(text).toContain("necessary but never sufficient");
    expect(
      text.includes(
        "Merge on mechanical Ready-to-merge / green checks while bot comment prose records should-not-merge",
      ),
    ).toBe(true);
  });

  it("incomplete_but_rated_stall_signature_present", () => {
    expect(readReviewCycleSkill()).toContain("INCOMPLETE_BUT_RATED");
  });

  it("phase2_step1_no_cp1252_mojibake", () => {
    expect(phase2Step1Section()).not.toContain("\u0393\u00E8\u00F9");
  });

  it("plan_approved_lifecycle_event_command_documented", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("task lifecycle:event");
    expect(text).toContain("emit plan:approved");
    expect(text).toContain("--plan-ref");
    expect(text).toContain("--approver");
    expect(text).toContain("--approval-phrase");
    expect(text).toContain("--pr-number");
  });

  it("ci_failures_holdout_section_present (#2688)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("Greptile CLEAN vs CI holdout");
    expect(text).toContain("clean_gate_holdout=ci_failures");
    expect(text).toMatch(/pr:watch/);
    expect(text).toContain("same ownership");
    expect(text).toContain("Test plan");
    expect(text).toContain("CI-holdout carve-out (#2688)");
  });

  it("gates_surface_dual_invoke_order (#2893)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("Gates-surface dual invoke order (#2893");
    expect(text).toContain("`deft` / `directive` CLI first");
    expect(text).toContain("`task deft:<verb>` second");
    expect(text).toContain("#2878 gh-only fallback last");
    expect(text).toContain("bare `task pr:watch` is **not** the sole");
    // CLI form: no go-task bare -- separator on the prescribed probe
    expect(text).toContain("deft pr:watch --help");
    expect(text).toContain("task deft:pr:watch -- --help");
    expect(text).toContain("Pass go-task's bare `--` separator into `deft`/`directive` CLI forms");
    // Anti-pattern: bare task-only consumer form
    expect(text).toContain("Treat bare `task pr:watch` as the only consumer gate form");
    // Positive probe must be `deft pr:watch --help` (without go-task bare --)
    const probeLine = text.split("\n").find((l) => l.includes("`deft` / `directive` CLI first"));
    expect(probeLine).toBeDefined();
    expect(probeLine).toContain("deft pr:watch --help");
    expect(probeLine).not.toMatch(/deft pr:watch -- --help/);
  });

  it("ci_failures_must_not_idle_poll (#2688)", () => {
    const text = readReviewCycleSkill();
    expect(text).toMatch(/MUST NOT.*idle-poll|idle-poll hoping CI heals/i);
    expect(text).toContain("ci_failed_checks");
  });

  it("runner_capacity_stall wait for auto-failover (#2672)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("runner_capacity_stall");
    expect(text).toContain("RUNNER_CAPACITY_STALL");
    expect(text).toContain("wait for auto-failover");
    expect(text).toContain("--skip-ci");
    expect(text).toContain("#2672");
  });

  it("ci_weather reason codes thrash caps and BLOCKED (#3167)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("CI weather reason codes + thrash caps (#3167)");
    expect(text).toContain("ci_never_scheduled");
    expect(text).toContain("ci_cancelled_no_failover");
    expect(text).toContain("ci_failures");
    expect(text).toContain("BLOCKED: ci_weather");
    expect(text).toContain("at most 2");
    expect(text).toContain("#3153");
    expect(text).toContain("#3168");
  });

  it("platform status probe attribution and BLOCKED fields (#3180)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("Platform status probe + outage attribution (#3180)");
    expect(text).toContain("https://www.githubstatus.com/");
    expect(text).toContain("https://status.blacksmith.sh/");
    expect(text).toContain("platform_status_github");
    expect(text).toContain("platform_status_blacksmith");
    expect(text).toContain("attribution: platform|capacity|repo_config|unknown");
    expect(text).toContain("Anti-thrash during attributed platform outage");
    expect(text).toContain("#3167");
    expect(text).toContain("#3168");
    expect(text).toContain("#2672");
    expect(text).toContain("#2688");
  });

  it("slizard advisory-only for merge-ready wait (#3167)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("SLizard advisory-only for merge-ready wait (#3167)");
    expect(text).toContain("advisory only");
    expect(text).toMatch(/Required bot for \*\*merge-ready wait\*\*.*Greptile/s);
  });

  it("outage admin-merge playbook opt-in (#3167)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("Outage admin-merge playbook");
    expect(text).toContain("opt-in");
    expect(text).toContain("audit note");
    expect(text).toContain("never the autonomous agent default");
  });

  it("empty_announce_not_done_and_single_lease (#3044)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("Empty announce");
    expect(text).toContain("FC04 residual");
    expect(text).toContain("same-turn ground truth");
    expect(text).toContain("Single review-monitor lease");
    expect(text).toContain("<!-- deft:review-owner -->");
    expect(text).toContain("Required non-empty monitor handback");
    expect(text).toContain("STATUS: DONE|BLOCKED|FAILED");
    expect(text).toContain("enterprize PR #43");
    expect(text).toContain("visible:true");
    expect(
      /^- \u2297 Treat empty\/unknown review-monitor settle as DONE\/CLEAN\/merge-ready/m.test(
        text,
      ),
    ).toBe(true);
    expect(/^- \u2297 Spawn a second review-monitor while prior owner is running/m.test(text)).toBe(
      true,
    );
  });

  it("owner_continuity_gate_and_review_cycle_enum (#3090)", () => {
    const text = readReviewCycleSkill();
    expect(text).toContain("### Owner Continuity Gate (#3090)");
    expect(text).toContain("silent hold");
    expect(text).toContain("review_cycle");
    expect(text).toContain("in_progress:<pr>#<monitor_or_lease_ref>");
    expect(text).toContain("skipped:<reason>");
    expect(text).toContain("verify:l4-owner");
    // Enum tokens
    expect(text).toMatch(/`done`/);
    expect(text).toContain("n/a");
    // A/B/C same-turn ends
    expect(text).toContain("**A.**");
    expect(text).toContain("**B.**");
    expect(text).toContain("**C.**");
    // Anti freeform + check SUCCESS alone
    expect(text).toContain("started");
    expect(text).toContain("pending");
    expect(text).toContain("initiated");
    expect(text).toMatch(/SUCCESS alone/);
    // Eval FAIL case narrative
    expect(text).toContain("Eval / regression (#3090)");
    expect(text).toContain("0 subagents");
    expect(text).toMatch(/FAIL.*Owner Continuity Gate|Owner Continuity Gate.*FAIL/s);
    // Anti-patterns block
    expect(text).toContain("silent hold (#3090)");
  });
});
