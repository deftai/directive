import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTriggerCases,
  normalizeTriggerText,
  parseSkillsIndex,
  parseTriggerCell,
  resolveTriggerWinner,
  runTriggerEval,
  SKILLS_INDEX_REL,
  sanitizeTriggerLogLine,
  TRIGGER_CASES_REL,
  validateTriggerCoverage,
  wouldRouteToSkill,
} from "./triggers.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");

describe("eval triggers (#1586)", () => {
  const referencesText = readFileSync(resolve(repoRoot, SKILLS_INDEX_REL), "utf8");
  const index = parseSkillsIndex(referencesText);

  it("parses all indexed directive skills from REFERENCES.md", () => {
    expect(index.length).toBeGreaterThanOrEqual(20);
    expect(index.some((entry) => entry.skillId === "deft-directive-review-cycle")).toBe(true);
  });

  it("parseTriggerCell extracts backtick phrases", () => {
    expect(parseTriggerCell("`review cycle`, `babysit`, `shepherd`")).toEqual([
      "review cycle",
      "babysit",
      "shepherd",
    ]);
  });

  it("normalizeTriggerText lowercases and collapses whitespace", () => {
    expect(normalizeTriggerText("  Run   Review   Cycle  ")).toBe("run review cycle");
  });

  it("review-cycle babysit and sub-agent paraphrases route correctly (#2261)", () => {
    expect(wouldRouteToSkill("babysit this PR", "deft-directive-review-cycle", index)).toBe(true);
    expect(
      wouldRouteToSkill("use sub-agents for reviews", "deft-directive-review-cycle", index),
    ).toBe(true);
    expect(
      wouldRouteToSkill("shepherd the PR through review", "deft-directive-review-cycle", index),
    ).toBe(true);
  });

  it("longest trigger wins for triage hygiene vs bare triage", () => {
    const winner = resolveTriggerWinner("run triage hygiene on the cache", index);
    expect(winner?.skillId).toBe("deft-directive-triage");
  });

  it("bare arc does not steal architecture or archive queries (#4202)", () => {
    expect(
      wouldRouteToSkill(
        "summarize the project architecture overview",
        "deft-directive-design-critique",
        index,
      ),
    ).toBe(false);
    expect(
      wouldRouteToSkill("archive the old notes", "deft-directive-design-critique", index),
    ).toBe(false);
    expect(wouldRouteToSkill("arc", "deft-directive-design-critique", index)).toBe(true);
    expect(wouldRouteToSkill("arc #286", "deft-directive-design-critique", index)).toBe(true);
  });

  it("trigger-cases.jsonl meets per-skill coverage minimums", () => {
    const loaded = loadTriggerCases(resolve(repoRoot, TRIGGER_CASES_REL));
    expect("error" in loaded).toBe(false);
    if ("error" in loaded) {
      return;
    }
    expect(validateTriggerCoverage(loaded, index)).toEqual([]);
  });

  it("runTriggerEval passes committed trigger-cases against REFERENCES.md", () => {
    const result = runTriggerEval({ projectRoot: repoRoot });
    expect(result.code).toBe(0);
    expect(result.report?.failed).toBe(0);
  });

  it("runTriggerEval fails when trigger cases file is missing", () => {
    const result = runTriggerEval({
      projectRoot: repoRoot,
      casesPath: join(repoRoot, "evals", "missing-trigger-cases.jsonl"),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("missing trigger cases");
  });

  it("runTriggerEval fails when Skills Index parses empty", () => {
    const loaded = loadTriggerCases(join(repoRoot, TRIGGER_CASES_REL));
    if ("error" in loaded) {
      throw new Error(loaded.error);
    }
    const result = runTriggerEval({
      projectRoot: repoRoot,
      cases: loaded,
      indexText: "# no skills table\n",
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("no Skills Index rows");
  });

  it("sanitizeTriggerLogLine collapses embedded newlines", () => {
    expect(sanitizeTriggerLogLine("a\nb")).toBe("a b");
  });
});
