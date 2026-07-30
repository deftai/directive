import { describe, expect, it } from "vitest";
import { RELEASE_HELP } from "./constants.js";
import { formatReleaseHelp, parseReleaseFlags } from "./flags.js";

describe("parseReleaseFlags", () => {
  it("parses full argv set", () => {
    const flags = parseReleaseFlags([
      "0.21.0",
      "--dry-run",
      "--skip-tag",
      "--skip-release",
      "--allow-dirty",
      "--allow-vbrief-drift",
      "--skip-ci",
      "--allow-skip-ci=716",
      "--skip-build",
      "--no-draft",
      "--repo",
      "org/repo",
      "--base-branch",
      "main",
      "--project-root",
      "/tmp",
      "--summary",
      "One line",
    ]);
    expect(flags.version).toBe("0.21.0");
    expect(flags.dryRun).toBe(true);
    expect(flags.skipTag).toBe(true);
    expect(flags.skipRelease).toBe(true);
    expect(flags.allowDirty).toBe(true);
    expect(flags.allowVbriefDrift).toBe(true);
    expect(flags.skipCi).toBe(true);
    expect(flags.allowSkipCiIssue).toBe(716);
    expect(flags.skipBuild).toBe(true);
    expect(flags.draft).toBe(false);
    expect(flags.repo).toBe("org/repo");
    expect(flags.baseBranch).toBe("main");
    expect(flags.projectRoot).toBe("/tmp");
    expect(flags.summary).toBe("One line");
    expect(flags.unknown).toEqual([]);
  });

  it("parses equals-form flags", () => {
    const flags = parseReleaseFlags([
      "1.0.0",
      "--repo=acme/widget",
      "--base-branch=develop",
      "--project-root=/x",
      "--summary=hi",
    ]);
    expect(flags.repo).toBe("acme/widget");
    expect(flags.baseBranch).toBe("develop");
    expect(flags.projectRoot).toBe("/x");
    expect(flags.summary).toBe("hi");
  });

  it("records unknown flags and missing values", () => {
    const flags = parseReleaseFlags(["--nope", "--repo", "--project-root="]);
    expect(flags.unknown.length).toBeGreaterThan(0);
  });

  it("parses --allow-coverage-debt issue number", () => {
    expect(
      parseReleaseFlags(["0.21.0", "--allow-coverage-debt=#2573"]).allowCoverageDebtIssue,
    ).toBe(2573);
    expect(parseReleaseFlags(["0.21.0", "--allow-coverage-debt=2573"]).allowCoverageDebtIssue).toBe(
      2573,
    );
  });

  it("records malformed --allow-coverage-debt values as unknown", () => {
    const flags = parseReleaseFlags(["0.21.0", "--allow-coverage-debt=#"]);
    expect(flags.allowCoverageDebtIssue).toBeNull();
    expect(flags.unknown.some((u) => u.includes("allow-coverage-debt"))).toBe(true);
  });

  it("covers coverage-debt and equals-form edge branches (#2952)", () => {
    // spaced form with valid N
    expect(
      parseReleaseFlags(["0.21.0", "--allow-coverage-debt", "2952"]).allowCoverageDebtIssue,
    ).toBe(2952);
    // missing value for spaced form
    const missing = parseReleaseFlags(["0.21.0", "--allow-coverage-debt"]);
    expect(missing.allowCoverageDebtIssue).toBeNull();
    expect(missing.unknown.some((u) => u.includes("allow-coverage-debt"))).toBe(true);
    // malformed spaced value
    const badSpaced = parseReleaseFlags(["0.21.0", "--allow-coverage-debt", "abc"]);
    expect(badSpaced.allowCoverageDebtIssue).toBeNull();
    expect(badSpaced.unknown.some((u) => u.includes("malformed"))).toBe(true);
    // empty equals-form values
    const emptyEq = parseReleaseFlags([
      "0.21.0",
      "--repo=",
      "--base-branch=",
      "--project-root=",
      "--summary=",
    ]);
    expect(emptyEq.repo).toBeNull();
    expect(emptyEq.unknown.some((u) => u.includes("--repo="))).toBe(true);
    expect(emptyEq.unknown.some((u) => u.includes("--base-branch="))).toBe(true);
    expect(emptyEq.unknown.some((u) => u.includes("--project-root="))).toBe(true);
    expect(emptyEq.unknown.some((u) => u.includes("--summary="))).toBe(true);
    // sparse argv hole while scanning
    const sparse: string[] = [];
    sparse[0] = "0.21.0";
    sparse[2] = "--dry-run";
    expect(parseReleaseFlags(sparse).dryRun).toBe(true);
    // --allow-skip-ci spaced form advances past the value
    expect(parseReleaseFlags(["0.21.0", "--allow-skip-ci", "716"]).allowSkipCiIssue).toBe(716);
  });

  it("records malformed --allow-skip-ci values as unknown (#2652)", () => {
    const flags = parseReleaseFlags(["0.21.0", "--allow-skip-ci=#"]);
    expect(flags.allowSkipCiIssue).toBeNull();
    expect(flags.unknown.some((u) => u.includes("allow-skip-ci"))).toBe(true);
    expect(parseReleaseFlags(["0.21.0", "--allow-skip-ci=0"]).allowSkipCiIssue).toBeNull();
  });

  it("sets help flag", () => {
    expect(parseReleaseFlags(["--help"]).help).toBe(true);
    expect(parseReleaseFlags(["-h"]).help).toBe(true);
  });

  it("rejects duplicate positional version", () => {
    const flags = parseReleaseFlags(["0.1.0", "0.2.0"]);
    expect(flags.version).toBe("0.1.0");
    expect(flags.unknown).toContain("0.2.0");
  });
});

describe("formatReleaseHelp", () => {
  it("matches embedded argparse help", () => {
    expect(formatReleaseHelp()).toBe(RELEASE_HELP);
  });
});
