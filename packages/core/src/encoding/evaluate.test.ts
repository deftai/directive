import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import { GitCommandError, gitStagedFiles, gitTrackedFiles } from "./git.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function buildRepo(files: Record<string, string | Buffer>, init = true): string {
  const root = mkdtempSync(join(tmpdir(), "deft-eval-test-"));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  if (init) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
  }
  return root;
}

describe("git enumeration", () => {
  it("lists tracked and staged files", () => {
    const root = buildRepo({ "a.md": "ok\n", "b.txt": "ok\n" });
    expect(gitTrackedFiles(root).sort()).toEqual(["a.md", "b.txt"]);
    expect(gitStagedFiles(root).sort()).toEqual(["a.md", "b.txt"]);
  });
  it("throws GitCommandError outside a git repo", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-nogit-"));
    temps.push(root);
    expect(() => gitTrackedFiles(root)).toThrow(GitCommandError);
  });
});

describe("evaluate", () => {
  it("returns exit 0 for a clean repo", () => {
    const root = buildRepo({ "clean.md": "# ok\n\nplain\n" });
    const result = evaluate(root, { mode: "all" });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.message).toContain("clean");
  });

  it("returns exit 1 with findings for corruption", () => {
    const root = buildRepo({ "bad.txt": "smart \u00e2\u20ac\u2122 quote\n" });
    const result = evaluate(root, { mode: "all" });
    expect(result.exitCode).toBe(1);
    expect(result.findings.length).toBe(1);
    expect(result.message).toContain("bad.txt:1");
  });

  it("detects in staged mode", () => {
    const root = buildRepo({ "bad.txt": "broken \ufffd marker\n" });
    expect(evaluate(root, { mode: "staged" }).exitCode).toBe(1);
  });

  it("honors the -798- builtin allow-list", () => {
    const root = buildRepo({
      "vbrief/active/2026-01-01-798-x.vbrief.json": `${JSON.stringify({ note: "catalogs \u0393\u00a3\u00f4" })}\n`,
    });
    expect(evaluate(root, { mode: "all" }).exitCode).toBe(0);
  });

  it("returns exit 2 for an unknown mode", () => {
    const root = buildRepo({ "a.md": "ok\n" });
    // @ts-expect-error deliberately invalid mode to exercise the guard
    expect(evaluate(root, { mode: "weird" }).exitCode).toBe(2);
  });

  it("returns exit 2 for a missing --allow-list path", () => {
    const root = buildRepo({ "a.md": "ok\n" });
    const result = evaluate(root, { mode: "all", allowListPath: join(root, "nope.txt") });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("not found");
  });

  it("returns exit 2 outside a git working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-nogit2-"));
    temps.push(root);
    expect(evaluate(root, { mode: "all" }).exitCode).toBe(2);
  });

  it("suppresses a file via a custom allow-list (comments + globs)", () => {
    const root = buildRepo({ "bad.txt": "broken \ufffd marker\n" });
    const allowDir = mkdtempSync(join(tmpdir(), "deft-allow-"));
    temps.push(allowDir);
    const allowFile = join(allowDir, "allow.txt");
    writeFileSync(allowFile, "# documented exception\n\nbad.txt\n");
    expect(evaluate(root, { mode: "all", allowListPath: allowFile }).exitCode).toBe(0);
  });
});
