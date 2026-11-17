import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Pre-PR skill: once-before-push `deft check --no-suite` step (#6469). */

describe("pre-PR skill deft check --no-suite step (#6469)", () => {
  const text = readRepoFile("skills/deft-directive-pre-pr/SKILL.md");
  const exit = text.slice(text.indexOf("## Exit Condition"));

  it("names the once-before-push no-suite run after the zero-change exit", () => {
    expect(text).toContain(
      "**Merge-gate run without the suite (#6469):** once, after the loop's zero-change exit and before push, run `deft check --no-suite`",
    );
    expect(exit).toContain("Run `deft check --no-suite` once before push (#6469)");
    expect(text).toContain("A red is a finding: fix it and restart the loop");
  });

  it("names the run-again-after-PR rule", () => {
    expect(text).toContain(
      "When the run says there is no PR and a red needs the PR, open the PR and run it once more before waiting on CI.",
    );
    expect(exit).toContain("open the PR, then run it once more before waiting on CI");
  });

  it("still keeps the test suite and the full gate out of ordinary pre-PR", () => {
    expect(text).toContain(
      "ordinary pre-PR does **not** run or require a post-loop full `deft check` / `task check` (the full gate runs the test suite)",
    );
    expect(text).toContain(
      "⊗ Prompt ordinary pre-PR for a post-loop full `task check` / `deft check` (with the test suite) or a coverage run (#6040).",
    );
    expect(exit).toContain(
      "Do **not** prompt a post-loop full `task check` / `deft check` (with the test suite) or a coverage run for ordinary pre-PR.",
    );
  });

  it("keeps the no-suite run out of each loop iteration", () => {
    expect(text).toContain(
      "⊗ Run full `task check` or `deft check --no-suite` inside every pre-PR Phase 3 iteration",
    );
  });
});
