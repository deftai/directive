import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/**
 * #6205 clause.8: one advance owner. Neither the pre-pr nor the review-cycle
 * skill tells the agent to run `plan-sequence:advance` at CLEAN for an entry
 * that has a brief; the derived cursor moves on when the brief is completed.
 */

const PRE_PR = "skills/deft-directive-pre-pr/SKILL.md";
const REVIEW_CYCLE = "skills/deft-directive-review-cycle/SKILL.md";
const PREAMBLE = "templates/agent-prompt-preamble.md";

/** Lines that mention plan-sequence:advance. */
function advanceLines(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("plan-sequence:advance"));
}

describe("plan-sequence advance owner (#6205)", () => {
  for (const path of [PRE_PR, REVIEW_CYCLE]) {
    it(`${path} limits plan-sequence:advance to entries with no brief`, () => {
      const lines = advanceLines(readRepoFile(path));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/no brief/);
      }
      const text = readRepoFile(path);
      expect(text).not.toContain(
        "After the PR's review cycle completes successfully, run `task plan-sequence:advance`",
      );
      expect(text).not.toMatch(/matched the current entry, run `task plan-sequence:advance`\./);
      expect(text).toContain("#6205");
    });
  }

  it("the preamble names the derived cursor and the approved insert", () => {
    const text = readRepoFile(PREAMBLE);
    expect(text).toContain("readers derive the next entry");
    expect(text).toContain("plan-sequence:insert");
    expect(text).not.toContain("(after `plan-sequence:advance` for the completed PR)");
  });
});
