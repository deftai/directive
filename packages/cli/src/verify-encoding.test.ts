import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-encoding.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function repo(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-test-"));
  temps.push(root);
  writeFileSync(join(root, "f.txt"), content);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
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
  it("defaults to mode=all, root='.', no allow-list", () => {
    expect(parseArgs([])).toMatchObject({
      mode: "all",
      projectRoot: ".",
      allowList: null,
      quiet: false,
    });
  });
  it("parses --staged and --quiet", () => {
    expect(parseArgs(["--staged", "--quiet"])).toMatchObject({ mode: "staged", quiet: true });
  });
  it("rejects --all with --staged", () => {
    expect(parseArgs(["--all", "--staged"]).error).toBeDefined();
  });
  it("parses --project-root and --allow-list in space and = forms", () => {
    expect(parseArgs(["--project-root", "/x"]).projectRoot).toBe("/x");
    expect(parseArgs(["--project-root=/y"]).projectRoot).toBe("/y");
    expect(parseArgs(["--allow-list", "/a"]).allowList).toBe("/a");
    expect(parseArgs(["--allow-list=/b"]).allowList).toBe("/b");
  });
  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--allow-list"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 0 for a clean repo", () => {
    expect(silentRun(["--all", "--project-root", repo("clean ascii\n")])).toBe(0);
  });
  it("returns 0 with --quiet for a clean repo", () => {
    expect(silentRun(["--quiet", "--project-root", repo("clean ascii\n")])).toBe(0);
  });
  it("returns 1 for corruption", () => {
    expect(silentRun(["--all", "--project-root", repo("broken \ufffd\n")])).toBe(1);
  });
  it("returns 2 for a bad argument", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });
});
