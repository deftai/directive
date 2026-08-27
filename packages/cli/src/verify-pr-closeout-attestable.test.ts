import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-pr-closeout-attestable.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-closeout-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  return root;
}

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("parseArgs", () => {
  it("parses all flags", () => {
    expect(
      parseArgs([
        "--project-root",
        "/root",
        "--repo",
        "deftai/directive",
        "--pr",
        "3786",
        "--quiet",
      ]),
    ).toMatchObject({
      projectRoot: "/root",
      repo: "deftai/directive",
      pr: 3786,
      quiet: true,
    });
  });

  it("parses --flag=value forms and a leading #", () => {
    expect(parseArgs(["--project-root=/root", "--repo=o/r", "--pr=#42"])).toMatchObject({
      projectRoot: "/root",
      repo: "o/r",
      pr: 42,
    });
  });

  it("requires --pr", () => {
    expect(parseArgs([]).error).toBe("argument --pr is required");
  });

  it("rejects a non-numeric --pr", () => {
    expect(parseArgs(["--pr", "abc"]).error).toContain("expected a positive integer");
  });

  it("rejects a missing option value", () => {
    expect(parseArgs(["--repo"]).error).toContain("expected one argument");
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
    expect(parseArgs(["--pr"]).error).toContain("expected one argument");
  });

  it("rejects an unknown argument", () => {
    expect(parseArgs(["--nope"]).error).toBe("unrecognized argument: --nope");
  });
});

describe("run", () => {
  it("exits 2 on a parse error", () => {
    expect(silentRun([])).toBe(2);
  });

  it("exits 0 without a forge read when the project has no xbrief/ lifecycle root", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-closeout-bare-"));
    temps.push(root);
    expect(silentRun(["--project-root", root, "--pr", "3786", "--quiet"])).toBe(0);
  });

  it("exits 2 for a project root that does not exist", () => {
    const root = buildRepo();
    expect(silentRun(["--project-root", join(root, "absent"), "--pr", "3786"])).toBe(2);
  });
});
