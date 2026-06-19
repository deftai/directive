import { describe, expect, it } from "vitest";
import { parseRollbackFlags } from "./flags.js";

describe("parseRollbackFlags", () => {
  it("parses all flag forms", () => {
    const flags = parseRollbackFlags([
      "0.21.0",
      "--dry-run",
      "--repo=deftai/directive",
      "--base-branch=main",
      "--project-root=/tmp/root",
      "--allow-low-downloads=5",
      "--allow-data-loss",
      "--force-strict-0",
    ]);
    expect(flags.version).toBe("0.21.0");
    expect(flags.dryRun).toBe(true);
    expect(flags.repo).toBe("deftai/directive");
    expect(flags.baseBranch).toBe("main");
    expect(flags.projectRoot).toBe("/tmp/root");
    expect(flags.allowLowDownloads).toBe(5);
    expect(flags.allowDataLoss).toBe(true);
    expect(flags.forceStrict0).toBe(true);
  });

  it("parses space-separated flag values", () => {
    const flags = parseRollbackFlags([
      "0.21.0",
      "--repo",
      "owner/repo",
      "--base-branch",
      "develop",
      "--project-root",
      "/x",
      "--allow-low-downloads",
      "12",
    ]);
    expect(flags.repo).toBe("owner/repo");
    expect(flags.baseBranch).toBe("develop");
    expect(flags.projectRoot).toBe("/x");
    expect(flags.allowLowDownloads).toBe(12);
  });

  it("records empty equals-form values as unknown", () => {
    const flags = parseRollbackFlags(["0.21.0", "--repo=", "--base-branch=", "--project-root="]);
    expect(flags.unknown).toContain("--repo= (empty value)");
    expect(flags.unknown).toContain("--base-branch= (empty value)");
    expect(flags.unknown).toContain("--project-root= (empty value)");
  });

  it("records missing values as unknown", () => {
    const flags = parseRollbackFlags(["0.21.0", "--repo"]);
    expect(flags.unknown.some((u) => u.startsWith("--repo"))).toBe(true);
  });

  it("treats extra positional args as unknown", () => {
    const flags = parseRollbackFlags(["0.21.0", "extra"]);
    expect(flags.unknown).toContain("extra");
  });

  it("errors when allow-low-downloads is followed by another flag", () => {
    const flags = parseRollbackFlags(["0.21.0", "--allow-low-downloads", "--dry-run"]);
    expect(flags.parseError).toBe("argument --allow-low-downloads: expected one argument");
    expect(flags.dryRun).toBe(false);
  });

  it("errors when allow-low-downloads has no trailing value", () => {
    const flags = parseRollbackFlags(["0.21.0", "--allow-low-downloads"]);
    expect(flags.parseError).toBe("argument --allow-low-downloads: expected one argument");
  });
});
