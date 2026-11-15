import { describe, expect, it } from "vitest";
import { readSkill } from "./helpers.js";

/**
 * #6280 -- Lifecycle-only PRs keep review.
 * Pins the review decision and the completion-PR routing (#6277 / #6303) in
 * both the review-cycle and pre-pr skills. No PR class skips the review bot.
 */

const LIFECYCLE_REVIEW_HEADING = "## Lifecycle-only PRs keep review (#6280)";

const SKILLS = [
  "skills/deft-directive-review-cycle/SKILL.md",
  "skills/deft-directive-pre-pr/SKILL.md",
] as const;

/** Slice the #6280 passage: from its heading to the next level-2 heading. */
function lifecycleReviewPassage(relPath: string): string {
  const text = readSkill(relPath);
  const start = text.indexOf(LIFECYCLE_REVIEW_HEADING);
  expect(start, `${relPath} lacks the #6280 passage`).not.toBe(-1);
  const end = text.indexOf("\n## ", start + LIFECYCLE_REVIEW_HEADING.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("lifecycle_pr_review_6280", () => {
  for (const rel of SKILLS) {
    describe(rel, () => {
      it("no_pr_class_skips_the_review_bot", () => {
        const passage = lifecycleReviewPassage(rel);
        expect(passage).toContain("! No PR class skips the review bot.");
        expect(passage).toMatch(/⊗ Skip the review bot on a lifecycle-only PR/);
        expect(passage).toMatch(/path-filter the reviewer over the lifecycle folders/);
      });

      it("activation_and_widen_keep_review_for_new_acceptance_text", () => {
        const passage = lifecycleReviewPassage(rel);
        expect(passage).toMatch(
          /! Activation and widen PRs keep the review they have today, because they carry new acceptance text\./,
        );
      });

      it("mint_record_and_cancel_keep_review_for_authority", () => {
        const passage = lifecycleReviewPassage(rel);
        expect(passage).toMatch(
          /! Mint-record and cancel PRs keep their review, because they carry authority\./,
        );
      });

      it("completion_rides_last_product_pr_and_rest_batch_under_6303", () => {
        const passage = lifecycleReviewPassage(rel);
        expect(passage).toMatch(/completion normally rides in its last product PR \(#6277\)/);
        expect(passage).toMatch(/remaining completion PRs are batched under #6303/);
        expect(passage).toMatch(/owns their review cost and the reviewer-side setting/);
      });
    });
  }

  it("both_skills_carry_the_same_passage", () => {
    const [reviewCycle, prePr] = SKILLS.map((rel) => lifecycleReviewPassage(rel));
    expect(prePr).toBe(reviewCycle);
  });
});
