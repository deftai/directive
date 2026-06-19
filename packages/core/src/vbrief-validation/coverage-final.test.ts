import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseTopLevelSections,
  partitionSections,
  SPEC_KNOWN_MAPPINGS,
} from "./legacy-sections.js";
import * as main from "./main.js";
import { renderScenarioOutput, runParityScenario } from "./parity-scenarios.js";
import { isTreeDirty, planBackups } from "./safety.js";
import { storyQualityIssues } from "./story-quality.js";
import { slugifyId } from "./validation.js";

describe("vbrief-validation branch coverage final", () => {
  it("renders scenario output without fixture normalization", () => {
    const rendered = renderScenarioOutput({ scenario: "x", ok: true, payload: { a: 1 } });
    expect(rendered).toContain('"scenario": "x"');
  });

  it("cmdVbriefValidation handles thrown errors", () => {
    const spy = vi.spyOn(main, "run").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(main.cmdVbriefValidation([])).toBe(2);
    spy.mockRestore();
  });

  it("run allocates and cleans an owned fixture root", () => {
    expect(main.run(["--scenario", "slugify-basic"])).toBe(0);
  });

  it("partitionSections skips empty canonical bodies", () => {
    const sections = parseTopLevelSections("## Summary\n\n\n## Goals\n\nReal goals.\n");
    const [canonical, legacy] = partitionSections(sections, SPEC_KNOWN_MAPPINGS);
    expect(canonical.Overview).toBeUndefined();
    expect(canonical.Goals).toBe("Real goals.");
    expect(legacy).toHaveLength(0);
  });

  it("story-quality dedupes repeated issues and skips generic verify with multiple commands", () => {
    const issues = storyQualityIssues({
      title: "Auth model",
      description:
        "Auth model persistence stores user identity and session state. The story covers focused model changes plus matching unit tests for save and load behavior.",
      implementationPlan:
        "- Update the src/auth model persistence code so valid payloads are saved through the model boundary.\n" +
        "- Add focused tests for successful persistence and a missing-record fixture in tests/auth/model.",
      userStory:
        "As an auth maintainer, I want persisted user records, so that login state survives requests.",
      acceptanceTexts: ["It is updated.", "It is updated."],
      acceptanceCountJustification: "",
      swarm: {
        file_scope: ["src/auth/model.ts", "tests/auth/model.test.ts"],
        verify_commands: ["npm test -- auth/model", "task check"],
        expected_outputs: ["ok"],
        depends_on: [],
        conflict_group: "auth",
        size: "M",
        file_scope_confidence: "high",
        model_tier: "medium",
        parallel_safe: true,
      },
    });
    expect(issues.filter((i) => i.includes("specific observable behavior")).length).toBe(1);
    expect(issues.some((i) => i.includes("generic verify command"))).toBe(false);
  });

  it("planBackups includes vbrief json inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-plan-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "specification.vbrief.json"), "{}", "utf8");
    const pairs = planBackups(root);
    expect(pairs.some(([src]) => src.endsWith("specification.vbrief.json"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("slugifyId perturb loop reaches unique candidate", () => {
    const existing = new Set<string>(["hello"]);
    slugifyId("hello", existing);
    const seed = "hello";
    const baseMax = 80 - 1 - 6;
    const base = "hello".slice(0, baseMax);
    existing.add(`${base}-aaaaaa`);
    existing.add(`${base}-bbbbbb`);
    const result = slugifyId(seed, existing);
    expect(result.startsWith(`${base}-`)).toBe(true);
  });

  it("isTreeDirty returns false outside git repos", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-not-git-"));
    expect(isTreeDirty(root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("runParityScenario default branch returns unknown error", () => {
    expect(runParityScenario("not-a-real-scenario", { fixtureRoot: "/tmp" }).ok).toBe(false);
  });
});
