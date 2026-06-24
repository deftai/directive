import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./triage-actions.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-cli-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  return root;
}

describe("parseArgs", () => {
  it("parses equals-form flags", () => {
    const parsed = parseArgs([
      "defer",
      "--issue=7",
      "--repo=deftai/directive",
      "--reason=later",
      "--project-root=/tmp/x",
    ]);
    expect(parsed.issue).toBe(7);
    expect(parsed.repo).toBe("deftai/directive");
    expect(parsed.projectRoot).toBe("/tmp/x");
  });

  it("returns error for unknown flag", () => {
    expect(parseArgs(["defer", "--nope"]).error).toMatch(/unrecognized argument/);
  });

  it("returns error when subcommand missing", () => {
    expect(parseArgs([]).error).toBe("missing subcommand");
  });

  it("returns error when --issue value missing", () => {
    expect(parseArgs(["defer", "--issue"]).error).toMatch(/--issue/);
  });
});

describe("run", () => {
  it("returns 2 when defer lacks reason", () => {
    expect(run(["defer", "--issue", "7", "--repo", "deftai/directive"])).toBe(2);
  });

  it("returns 1 for invalid resume-on via CLI", () => {
    const root = makeProjectRoot();
    expect(
      run([
        "defer",
        "--issue",
        "7",
        "--repo",
        "deftai/directive",
        "--reason",
        "later",
        "--resume-on",
        "not-valid",
        "--project-root",
        root,
      ]),
    ).toBe(1);
  });

  it("returns 0 for successful defer", () => {
    const root = makeProjectRoot();
    expect(
      run([
        "defer",
        "--issue",
        "7",
        "--repo",
        "deftai/directive",
        "--reason",
        "later",
        "--project-root",
        root,
      ]),
    ).toBe(0);
  });

  it("returns 2 for missing repo", () => {
    expect(run(["defer", "--issue", "7", "--reason", "later"])).toBe(2);
  });

  it("returns 2 for reject without reason", () => {
    expect(run(["reject", "--issue", "7", "--repo", "deftai/directive"])).toBe(2);
  });

  it("returns 2 for accept subcommand with missing issue", () => {
    expect(run(["accept", "--repo", "deftai/directive"])).toBe(2);
  });

  it("returns 2 for mark-duplicate with invalid --of", () => {
    expect(
      run(["mark-duplicate", "--issue", "7", "--repo", "deftai/directive", "--of", "abc"]),
    ).toBe(2);
  });

  it("returns 2 for mark-duplicate without --of", () => {
    expect(run(["mark-duplicate", "--issue", "7", "--repo", "deftai/directive"])).toBe(2);
  });

  it("returns 0 for status with no prior decision", () => {
    const root = makeProjectRoot();
    expect(
      run(["status", "--issue", "7", "--repo", "deftai/directive", "--project-root", root]),
    ).toBe(0);
  });

  it("returns 1 for reset without prior decision", () => {
    const root = makeProjectRoot();
    expect(
      run(["reset", "--issue", "7", "--repo", "deftai/directive", "--project-root", root]),
    ).toBe(1);
  });

  it("parses --of and --comment flags", () => {
    const parsed = parseArgs([
      "mark-duplicate",
      "--issue=7",
      "--repo=deftai/directive",
      "--of=42",
      "--comment=needs AC",
    ]);
    expect(parsed.ofN).toBe(42);
    expect(parsed.comment).toBe("needs AC");
  });

  it("returns 2 for unrecognized flag", () => {
    expect(parseArgs(["defer", "--bogus"]).error).toMatch(/unrecognized argument/);
  });
});
