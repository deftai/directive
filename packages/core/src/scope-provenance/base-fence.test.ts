import { describe, expect, it } from "vitest";
import {
  evaluateApprovedScopeMembership,
  evaluateProductionScopeFence,
  isConcreteFileScopeEntry,
  isTestOrFixturePath,
  PRODUCTION_ALLOWANCE_CAP,
  PRODUCTION_ALLOWANCE_FLOOR,
  productionAllowance,
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
      changedFiles: ["packages/core/src/a.ts", "packages/core/src/b.ts", "packages/core/src/c.ts"],
    });
    expect(hit).toBeNull();
  });

  it("fails past the cap with split remediation and no remint", () => {
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: ["packages/core/src/b.ts", "packages/core/src/c.ts", "packages/core/src/d.ts"],
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

describe("evaluateApprovedScopeMembership (#4774)", () => {
  it("allows first-story when declared file_scope covers the change set", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts", "CHANGELOG.md"],
    });
    expect(hit).toBeNull();
  });

  it("allows xBRIEF-only change set when allowlist is missing (#5192)", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: null,
      allowlistAuthority: "missing",
      changedFiles: ["xbrief/active/story.xbrief.json", "CHANGELOG.md"],
    });
    expect(hit).toBeNull();
  });

  it("fails closed when non-exempt product paths ride with no declared allowlist", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: null,
      allowlistAuthority: "missing",
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts", ".gitignore"],
    });
    expect(hit?.kind).toBe("active-xbrief-modified-without-digest");
    expect(hit?.expandedPaths).toEqual(
      expect.arrayContaining(["packages/core/src/a.ts", ".gitignore"]),
    );
    expect(hit?.remediation).toMatch(/not undeclared-by-design attestation/i);
    expect(hit?.remediation).toMatch(/Same-PR approval rewrite stays fail-closed/i);
    expect(hit?.remediation).not.toMatch(/renewed merge-base approval/i);
  });

  it("peer coverage does not clear a missing own allowlist", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      planId: "story-a",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: null,
      peerXbriefRelPaths: ["xbrief/active/story-b.xbrief.json"],
      peerApprovedFileScopes: [["packages/core/src/a.ts"]],
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "xbrief/active/story-b.xbrief.json",
        "packages/core/src/a.ts",
      ],
    });
    expect(hit?.kind).toBe("active-xbrief-modified-without-digest");
    expect(hit?.expandedPaths).toContain("packages/core/src/a.ts");
  });

  it("unions peer approved scopes so multi-story PRs do not flag peer files", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      planId: "story-a",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      peerXbriefRelPaths: ["xbrief/active/story-b.xbrief.json"],
      peerApprovedFileScopes: [["packages/core/src/b.ts"]],
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "xbrief/active/story-b.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "CHANGELOG.md",
      ],
    });
    expect(hit).toBeNull();
  });

  it("still flags paths outside own and peer approved scopes", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      planId: "story-a",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "mint",
      peerXbriefRelPaths: ["xbrief/active/story-b.xbrief.json"],
      peerApprovedFileScopes: [["packages/core/src/b.ts"]],
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/orphan.ts",
        ".gitignore",
      ],
    });
    expect(hit?.kind).toBe("change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toContain(".gitignore");
    expect(hit?.remediation).not.toMatch(/renewed merge-base approval/i);
  });

  it("admits one in-allowance concrete source-root extra under a mint (#5192)", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "mint",
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
      ],
    });
    expect(hit).toBeNull();
  });

  it("refuses undeclared test paths even when source-root extras are in allowance (#5192)", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "precommitment",
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "tests/helpers/probe.ts",
      ],
    });
    expect(hit?.kind).toBe("change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toContain("tests/helpers/probe.ts");
    expect(hit?.remediation).toMatch(/widened concrete brief|follow-up story/i);
    expect(hit?.remediation).not.toMatch(/renewed merge-base approval/i);
  });

  it("does not admit glob-only precommitment matches without a mint (#5192 F4)", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/**"],
      allowlistAuthority: "precommitment",
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
      ],
    });
    // Glob filtered out → no concrete allowlist → C24-style missing declaration.
    expect(hit?.kind).toBe("active-xbrief-modified-without-digest");
  });
});
