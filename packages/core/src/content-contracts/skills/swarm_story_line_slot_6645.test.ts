import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/**
 * #6645 / #6882 item 1: the swarm worker prompt template names the story line
 * each task needs, so a parent does not give `deft-story-part` to a leaf that
 * delivers a whole story.
 */
const CORE_OPS = "content/skills/deft-directive-swarm/references/core-ops.md";

function promptTemplate(): string {
  const text = readRepoFile(CORE_OPS);
  const start = text.indexOf("## Prompt Template");
  const end = text.indexOf("### Template Rules", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("swarm worker template story-line slot (#6645)", () => {
  it("every task line carries a story-line slot", () => {
    const tasks = promptTemplate()
      .split("\n")
      .filter((line) => /^Task [A-Z] \(xBRIEF:/.test(line));
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    for (const line of tasks) {
      expect(line).toContain("story line: [deft-story: N | deft-story-part: N]");
    }
  });

  it("the PR step says which line completes a story and points at the writer", () => {
    const template = promptTemplate();
    expect(template).toMatch(/`deft-story: N` when this PR completes story N/);
    expect(template).toMatch(/a leaf that delivers a whole story uses it/);
    expect(template).toContain("--write-story-line [--part]");
  });

  it("the template rules require the slot", () => {
    const text = readRepoFile(CORE_OPS);
    expect(text).toMatch(/- ! Each task MUST name its story line/);
    expect(text).toMatch(/A leaf that delivers a whole story never gets `deft-story-part`/);
  });
});
