import { describe, expect, it } from "vitest";
import { readRepoFile, readSkill } from "./helpers.js";

/**
 * #3452 -- Policy-anchored review-response loop.
 * Anchor precondition, classify-then-act + head-blob, batch discipline,
 * rounds tripwire composing with #3448 (no second detector).
 */

const SECTION = "Policy-anchored review-response (#3452)";
const REVIEW_MD = "coding/review.md";
const SKILL = "skills/deft-directive-review-cycle/SKILL.md";

function reviewCycle(): string {
  return readSkill(SKILL);
}

function policySection(): string {
  const text = reviewCycle();
  const start = text.indexOf(SECTION);
  expect(start).not.toBe(-1);
  const dual = text.indexOf("### Dual stop", start);
  expect(dual).toBeGreaterThan(start);
  return text.slice(start, dual);
}
describe("policy_anchored_review_response_3452", () => {
  it("review_cycle_names_policy_anchored_section", () => {
    expect(reviewCycle()).toContain(SECTION);
    expect(reviewCycle()).toContain("deft-directive-review-response");
  });

  it("refuses_out_of_model_until_head_anchor", () => {
    const section = policySection();
    expect(section).toMatch(/current HEAD/);
    expect(section).toMatch(/assumptions/);
    expect(section).toMatch(/guarantees/);
    expect(section).toMatch(/non-goals/);
    expect(section).toMatch(/refuse out-of-model classification/);
    expect(section).toMatch(/write the anchor first/);
    expect(section).toMatch(/revise the anchor/);
    expect(section).toMatch(/concurrency/);
    expect(section).toMatch(/error handling|error-handling|error policy/);
    expect(section).toMatch(/containment/);
  });
  it("classify_then_act_includes_head_blob_check", () => {
    const section = policySection();
    expect(section).toMatch(/In-model/);
    expect(section).toMatch(/Out-of-model/);
    expect(section).toMatch(/accepted-risk/);
    expect(section).toContain("git show <head-sha>:<file>");
    expect(section).toMatch(/slizard#2694/);
    expect(section).toMatch(/presume false/);
    expect(section).toMatch(/check every time/);
    expect(section).toMatch(/dead export/);
  });

  it("batch_discipline_one_push_per_round", () => {
    const section = policySection();
    expect(section).toMatch(/one consolidated push per review round/i);
    expect(section).toMatch(/Local review pass/);
    expect(section).toMatch(/Never push per finding|never push per finding/);
    expect(section).toMatch(/[Rr]iders/);
    expect(section).toMatch(/mechanical rebases/);
  });
  it("rounds_tripwire_composes_3448_escalates_3434", () => {
    const section = policySection();
    expect(section).toMatch(/>\s*3 review rounds|more than 3 review rounds/i);
    expect(section).toContain("#3448");
    expect(section).toMatch(/do not invent a second detector/i);
    expect(section).toContain("#3434");
    expect(section).toMatch(/not round K\+1/);
    expect(section).toMatch(/not parking/);
    expect(section).not.toMatch(/2 consecutive re-review observations/);
  });

  it("does_not_own_adjacent_issues", () => {
    const section = policySection();
    expect(section).toContain("#3457");
    expect(section).toContain("#3462");
    expect(section).toMatch(/ADR-004/);
    expect(section).toMatch(/Do not duplicate|#3448.*park-vs-continue|park vs continue/);
  });
  it("review_md_carries_lean_universal_3452_principles", () => {
    const text = readRepoFile(REVIEW_MD);
    expect(text.split("\n").length).toBeLessThanOrEqual(120);
    expect(text).toContain("#3452");
    expect(text).toMatch(/current HEAD/);
    expect(text).toMatch(/out-of-model/);
    expect(text).toMatch(/one consolidated push per review round/i);
    expect(text).toMatch(/design pass/);
  });

  it("pack_triggers_include_review_response_phrases", () => {
    const pack = JSON.parse(readRepoFile("packs/skills/skills-pack-0.1.json")) as {
      skills: Array<{ id?: string; triggers?: string[] }>;
    };
    const skill = pack.skills.find((s) => s.id === "deft-directive-review-cycle");
    expect(skill).toBeDefined();
    const triggers = skill?.triggers ?? [];
    expect(triggers).toContain("policy-anchored review-response");
    expect(triggers).toContain("review-response");
  });
  it("consumer_agents_entry_points_at_3452", () => {
    const entry = readRepoFile("templates/agents-entry.md");
    expect(entry).toContain("#3452");
    expect(entry).toMatch(/Policy-anchored review-response/);
    expect(entry).toMatch(/HEAD policy before out-of-model/);
  });
  it("commands_and_changelog_cite_3452", () => {
    const commands = readRepoFile("commands.md");
    expect(commands).toContain("#3452");
    expect(commands).toContain("Policy-anchored review-response");
    const changelog = readRepoFile("CHANGELOG.md");
    expect(changelog).toMatch(/## \[Unreleased\][\s\S]*#3452/);
  });

  it("anti_patterns_forbid_unanchored_out_of_model_and_per_finding_push", () => {
    const text = reviewCycle();
    expect(text).toMatch(/\u2297 Classify an invariant-shaped finding out-of-model/);
    expect(text).toMatch(/\u2297 Invent a second same-fingerprint detector/);
    expect(text).toMatch(/\u2297 Run round K\+1 or park when the rounds tripwire fires/);
  });
});
