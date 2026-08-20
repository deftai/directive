import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-forward-coverage.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

/** Temp git repo with a seeded base commit + `files` written and staged. */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-fwdcov-"));
  temps.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# base\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
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
  it("defaults to mode=head, root='.', no allow-list", () => {
    expect(parseArgs([])).toMatchObject({
      mode: "head",
      projectRoot: ".",
      allowList: null,
      quiet: false,
    });
  });
  it("parses --staged and --quiet", () => {
    expect(parseArgs(["--staged", "--quiet"])).toMatchObject({ mode: "staged", quiet: true });
  });
  it("parses --enforce and --help", () => {
    expect(parseArgs(["--enforce"]).enforce).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });
  it("parses --coverage-dir and --coverage-report", () => {
    expect(parseArgs(["--coverage-dir", "/c"]).coverageDir).toBe("/c");
    expect(parseArgs(["--coverage-report=/r.json"]).coverageReport).toBe("/r.json");
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
  it("returns 0 when a new source file ships with its test", () => {
    const root = repo({
      "src/foo.ts": "export const foo = 1;\n",
      "src/foo.test.ts": "import { foo } from './foo';\n",
    });
    expect(silentRun(["--staged", "--project-root", root])).toBe(0);
  });
  it("returns 0 with --quiet for a clean diff", () => {
    const root = repo({
      "src/foo.ts": "export const foo = 1;\n",
      "src/foo.test.ts": "import { foo } from './foo';\n",
    });
    expect(silentRun(["--staged", "--quiet", "--project-root", root])).toBe(0);
  });
  it("returns 1 for a new source file with no test", () => {
    const root = repo({ "src/foo.ts": "export const foo = 1;\n" });
    expect(silentRun(["--staged", "--project-root", root])).toBe(1);
  });
  it("returns 2 for a bad argument", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });
  it("returns 2 outside a git working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-fwdcov-nogit-"));
    temps.push(root);
    expect(silentRun(["--staged", "--project-root", root])).toBe(2);
  });
  it("returns 0 for --help", () => {
    expect(silentRun(["--help"])).toBe(0);
  });
  it("returns 0 warn-first when a modified file has uncovered changed branches", () => {
    const root = repo({
      "src/foo.ts": "export const foo = 1;\n",
      "src/foo.test.ts": "import { foo } from './foo';\n",
    });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
    writeFileSync(
      join(root, "src/foo.ts"),
      "export const foo = 1;\nexport const bar = true ? 1 : 0;\n",
    );
    execFileSync("git", ["add", "-A"], { cwd: root });
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage", "coverage-final.json"),
      JSON.stringify({
        "src/foo.ts": {
          path: "src/foo.ts",
          b: { "0": [1, 0] },
          branchMap: {
            "0": {
              type: "cond-expr",
              line: 2,
              loc: { start: { line: 2 } },
              locations: [{ start: { line: 2 } }, { start: { line: 2 } }],
            },
          },
        },
      }),
      "utf8",
    );
    expect(silentRun(["--staged", "--project-root", root])).toBe(0);
    expect(silentRun(["--staged", "--enforce", "--project-root", root])).toBe(1);
  });
});
