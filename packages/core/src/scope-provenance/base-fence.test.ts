import { describe, expect, it } from "vitest";
import {
  evaluateProductionScopeFence,
  isConcreteFileScopeEntry,
  isTestOrFixturePath,
  productionAllowance,
  PRODUCTION_ALLOWANCE_CAP,
  PRODUCTION_ALLOWANCE_FLOOR,
} from "./base-fence.js";

describe("production allowance (#4956)", () => {
  it("clamps concrete production count to floor 2 and cap 5", () => {
    expect(productionAllowance(0)).toBe(PRODUCTION_ALLOWANCE_FLOOR);
    expect(productionAllowance(1)).toBe(PRODUCTION_ALLOWANCE_FLOOR);
    expect(productionAllowance(3)).toBe(3);
    expect(productionAllowance(10)).toBe(PRODUCTION_ALLOWANCE_CAP);
  });

  it("treats globs as non-concrete", () => {
    expect(isConcreteFileScopeEntry("packages/core/src/a.ts")).toBe(true);
    expect(isConcreteFileScopeEntry("packages/core/src/**")).toBe(false);
    expect(isConcreteFileScopeEntry("src/*.ts")).toBe(false);
  });
});

describe("evaluateProductionScopeFence (#4956)", () => {
  it("lets test-root paths pass without spending allowance", () => {
    expect(isTestOrFixturePath("packages/core/src/foo.test.ts")).toBe(true);
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: [
        "packages/core/src/a.ts",
        "packages/core/src/a.test.ts",
        "tests/helpers/probe.ts",
        "CHANGELOG.md",
      ],
    });
    expect(hit).toBeNull();
  });

  it("admits production extras inside the allowance", () => {
    // concrete base count 1 → allowance 2
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: [
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
      ],
    });
    expect(hit).toBeNull();
  });

  it("fails past the cap with split remediation and no remint", () => {
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: [
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
      ],
    });
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe("production-scope-over-budget");
    expect(hit?.allowance).toBe(2);
    expect(hit?.remediation).toMatch(/follow-up story/i);
    expect(hit?.remediation).not.toMatch(/record-approved-scope/);
    expect(hit?.remediation).not.toMatch(/\bmint\b/);
  });

  it("does not treat head-only scope widening as authority (caller omits head)", () => {
    // Fence input is base scope only; extras are computed from changed files.
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: [
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
      ],
    });
    expect(hit?.kind).toBe("production-scope-over-budget");
    expect(hit?.expandedPaths.length).toBe(5);
  });

  it("counts only concrete production entries for the denominator", () => {
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/**", "packages/core/src/a.ts"],
      changedFiles: ["packages/core/src/a.ts", "packages/cli/src/z.ts"],
    });
    // glob is not concrete; concrete count 1 → allowance 2; one extra lands
    expect(hit).toBeNull();
  });
});
