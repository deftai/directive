import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-lifecycle-visible.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

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

describe("verify-lifecycle-visible CLI (#3505)", () => {
  it("parses --project-root and --enforce", () => {
    const p = parseArgs(["--project-root", "/tmp/x", "--enforce"]);
    expect(p.projectRoot).toBe("/tmp/x");
    expect(p.enforce).toBe(true);
    expect(p.error).toBeUndefined();
    expect(parseArgs(["--project-root=/tmp/y"]).projectRoot).toBe("/tmp/y");
  });

  it("rejects unknown flags and missing --project-root value", () => {
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized/);
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
    expect(silentRun(["--nope"])).toBe(2);
  });

  it("help exits 0 without scanning", () => {
    expect(silentRun(["--help"])).toBe(0);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("run returns 0 warn-only on a tree with no git repo (config is exit 2)", () => {
    const root = mkdtempSync(join(tmpdir(), "lv-cli-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    expect(silentRun(["--project-root", root])).toBe(2);
  });

  it("run returns 0 on a clean git repo and 1 under --enforce when a root is hidden", () => {
    const root = mkdtempSync(join(tmpdir(), "lv-cli-git-"));
    temps.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", ".gitkeep"), "", "utf8");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, stdio: "ignore" });
    expect(silentRun(["--project-root", root])).toBe(0);
    writeFileSync(join(root, ".git", "info", "exclude"), "xbrief/active/\n", "utf8");
    expect(silentRun(["--project-root", root, "--enforce"])).toBe(1);
  });
});
