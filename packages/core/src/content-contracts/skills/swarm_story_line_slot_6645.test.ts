import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/**
 * #6645 / #6882 item 1 / #6934: the swarm worker prompt template names each
 * task's story issue and offers no choice of story line. A leaf writes
 * `deft-story: N`; `--part` is only for a task the envelope marks as split.
 */
const CORE_OPS = "content/skills/deft-directive-swarm/references/core-ops.md";
const CORE_PHASE_3 = "content/skills/deft-directive-swarm/references/core-phase-3.md";
const SPLIT = "split: a later product PR completes this story";

function promptTemplate(): string {
  const text = readRepoFile(CORE_OPS);
  const start = text.indexOf("## Prompt Template");
  const end = text.indexOf("### Template Rules", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("swarm worker template story line (#6645 / #6934)", () => {
  it("every task line names the xBRIEF and issue, with no story-line choice", () => {
    const tasks = promptTemplate()
      .split("\n")
      .filter((line) => /^Task [A-Z] \(xBRIEF:/.test(line));
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    for (const line of tasks) {
      expect(line).toContain("(xBRIEF: [filename], issue #[N])");
      expect(line).not.toContain("story line:");
      expect(line).not.toContain("deft-story-part");
    }
  });

  it("the PR step writes deft-story: N and keeps --part for a split story", () => {
    const template = promptTemplate();
    expect(template).toContain("write `deft-story: N` for each task's issue N");
    expect(template).toContain("--write-story-line` (#6316 / #6645 / #6934)");
    expect(template).not.toContain("--write-story-line [--part]");
    const partAt = template.indexOf("Pass `--part`");
    expect(partAt).toBeGreaterThan(0);
    expect(template.slice(partAt, partAt + 200)).toContain(SPLIT);
  });

  it("the template rules and phase 3 offer no choice and name the split marker", () => {
    const ops = readRepoFile(CORE_OPS);
    expect(ops).toMatch(/- ! Each task MUST include its xBRIEF filename and story issue number N/);
    expect(ops).toContain("the task offers no choice of line");
    expect(ops).toMatch(/A leaf that delivers a whole story never gets `deft-story-part`/);
    const phase3 = readRepoFile(CORE_PHASE_3);
    const at = phase3.indexOf("**Story line per story (#6316 / #6934):**");
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = phase3.slice(at, phase3.indexOf("\n", at));
    expect(rule).toContain("The worker writes `deft-story: N`");
    expect(rule).toContain(SPLIT);
    expect(rule).not.toContain("--write-story-line [--part]");
  });
});
