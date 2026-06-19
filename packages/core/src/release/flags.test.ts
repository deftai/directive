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
