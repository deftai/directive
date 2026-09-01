import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultTestBoundaryPolicy } from "../test-boundary/policy.js";
import {
  evaluateForwardCoverage,
  expectedTestBasenames,
  isSourceFile,
  isTestFile,
} from "./evaluate.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

/** Create a temp git repo, write `files`, and optionally make an initial commit. */
function buildRepo(files: Record<string, string>, commit = true): string {
  const root = mkdtempSync(join(tmpdir(), "deft-fwdcov-"));
  temps.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  // Seed an initial commit so HEAD exists (base for the head-relative diff).
  writeFileSync(join(root, "README.md"), "# base\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  if (commit) {
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function stage(root: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
}

describe("classification helpers", () => {
  it("recognises test files across TS/Go/Python conventions", () => {
    expect(isTestFile("packages/core/src/a.test.ts")).toBe(true);
    expect(isTestFile("packages/core/src/a.spec.tsx")).toBe(true);
    expect(isTestFile("cmd/foo_test.go")).toBe(true);
    expect(isTestFile("tests/test_foo.py")).toBe(true);
    expect(isTestFile("tests/foo_test.py")).toBe(true);
    expect(isTestFile("src/foo.ts")).toBe(false);
  });

  it("treats non-test source extensions as source, excluding .d.ts", () => {
    expect(isSourceFile("src/foo.ts")).toBe(true);
    expect(isSourceFile("scripts/foo.py")).toBe(true);
    expect(isSourceFile("cmd/foo.go")).toBe(true);
    expect(isSourceFile("src/widget.tsx")).toBe(true);
    expect(isSourceFile("src/types.d.ts")).toBe(false);
    expect(isSourceFile("docs/readme.md")).toBe(false);
    expect(isSourceFile("src/foo.test.ts")).toBe(false);
  });

  it("derives expected test basenames per extension", () => {
    expect(expectedTestBasenames("src/foo.ts")).toContain("foo.test.ts");
    expect(expectedTestBasenames("src/foo.tsx")).toContain("foo.test.tsx");
    expect(expectedTestBasenames("scripts/foo.py")).toEqual(["test_foo.py", "foo_test.py"]);
    expect(expectedTestBasenames("cmd/foo.go")).toEqual(["foo_test.go"]);
  });
});

describe("evaluateForwardCoverage", () => {
  it("returns exit 0 when a new source file ships with a co-located test (staged)", () => {
    const root = buildRepo({
      "src/foo.ts": "export const foo = 1;\n",
      "src/foo.test.ts": "import { foo } from './foo';\n",
    });
    stage(root);
    const result = evaluateForwardCoverage(root, { mode: "staged" });
    expect(result.exitCode).toBe(0);
    expect(result.missing).toEqual([]);
    expect(result.message).toContain("forward coverage");
  });

  it("returns exit 1 when a new source file has no test in the diff (staged)", () => {
    const root = buildRepo({ "src/foo.ts": "export const foo = 1;\n" });
    stage(root);
    const result = evaluateForwardCoverage(root, { mode: "staged" });
    expect(result.exitCode).toBe(1);
    expect(result.missing.map((m) => m.path)).toEqual(["src/foo.ts"]);
    expect(result.message).toContain("src/foo.ts");
  });

  it("matches a Python test under tests/ by path relative to the source", () => {
    const root = buildRepo({
      "scripts/thing.py": "x = 1\n",
      "tests/scripts/test_thing.py": "def test_x():\n    assert True\n",
    });
    stage(root);
    expect(evaluateForwardCoverage(root, { mode: "staged" }).exitCode).toBe(0);
  });

  it("does not treat an unrelated same-stem test as coverage", () => {
    const root = buildRepo({
      "src/ui/ledger-table/index.ts": "export const n = 1;\n",
      "src/other/index.test.ts": "export {};\n",
    });
    stage(root);
    const result = evaluateForwardCoverage(root, { mode: "staged" });
    expect(result.exitCode).toBe(1);
    expect(result.missing.map((m) => m.path)).toEqual(["src/ui/ledger-table/index.ts"]);
    expect(result.message).toContain("searched:");
    expect(result.message).toContain("src/ui/ledger-table/index.test.ts");
    expect(result.missing[0]?.expectedTests).toContain("src/ui/ledger-table/index.test.ts");
    expect(result.missing[0]?.expectedTests).not.toContain("index.test.ts");
  });

  it("counts a pre-existing colocated test that is not in the current diff", () => {
    const root = buildRepo({ "src/foo.test.ts": 'import { foo } from "./foo";\n' });
    stage(root);
    execFileSync("git", ["commit", "-q", "-m", "seed-test"], { cwd: root });
    writeFileSync(join(root, "src/foo.ts"), "export const foo = 1;\n");
    stage(root);
    const result = evaluateForwardCoverage(root, { mode: "staged" });
    expect(result.exitCode).toBe(0);
    expect(result.missing).toEqual([]);
  });

  it("uses an injected test-boundary policy rather than a second testRoots field", () => {
    const root = buildRepo({
      "app/mod/x.ts": "export const x = 1;\n",
      "spec/mod/x.test.ts": "export {};\n",
    });
    stage(root);
    const policy = {
      ...defaultTestBoundaryPolicy("warn"),
      sourceRoots: ["app/**"],
      testRoots: ["spec/**"],
    };
    expect(evaluateForwardCoverage(root, { mode: "staged", policy }).exitCode).toBe(0);
  });

  it("counts a pre-existing tests/ path-relative test", () => {
    const root = buildRepo({
      "tests/ui/ledger-table/index.test.ts": "export {};\n",
    });
    stage(root);
    execFileSync("git", ["commit", "-q", "-m", "seed-test"], { cwd: root });
    mkdirSync(join(root, "src/ui/ledger-table"), { recursive: true });
    writeFileSync(join(root, "src/ui/ledger-table/index.ts"), "export const n = 1;\n");
    stage(root);
    const result = evaluateForwardCoverage(root, { mode: "staged" });
    expect(result.exitCode).toBe(0);
  });

  it("detects new files in head mode (untracked working tree)", () => {
    const root = buildRepo({ "src/bar.go": "package bar\n" });
    // Not staged -- head mode still sees the untracked file.
    const result = evaluateForwardCoverage(root, { mode: "head" });
    expect(result.exitCode).toBe(1);
    expect(result.missing.map((m) => m.path)).toEqual(["src/bar.go"]);
  });

  it("returns exit 0 in head mode when nothing new was added", () => {
    const root = buildRepo({});
    expect(evaluateForwardCoverage(root, { mode: "head" }).exitCode).toBe(0);
  });

  it("suppresses a new source file via an allow-list glob", () => {
    const root = buildRepo({ "src/generated.ts": "export const g = 1;\n" });
    stage(root);
    const allowDir = mkdtempSync(join(tmpdir(), "deft-fwdcov-allow-"));
    temps.push(allowDir);
    const allowFile = join(allowDir, "allow.txt");
    writeFileSync(allowFile, "# generated code\n\nsrc/generated.ts\n");
    const result = evaluateForwardCoverage(root, { mode: "staged", allowListPath: allowFile });
    expect(result.exitCode).toBe(0);
  });

  it("returns exit 2 for an unknown mode", () => {
    const root = buildRepo({});
    // @ts-expect-error deliberately invalid mode to exercise the guard
    expect(evaluateForwardCoverage(root, { mode: "weird" }).exitCode).toBe(2);
  });

  it("returns exit 2 for a missing --allow-list path", () => {
    const root = buildRepo({});
    const result = evaluateForwardCoverage(root, {
      mode: "staged",
      allowListPath: join(root, "nope.txt"),
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("not found");
  });

  it("returns exit 2 outside a git working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-fwdcov-nogit-"));
    temps.push(root);
    expect(evaluateForwardCoverage(root, { mode: "staged" }).exitCode).toBe(2);
  });

  it("reports uncovered branches on a modified existing file without failing (warn-first)", () => {
    const root = buildRepo({
      "src/foo.ts": "export const foo = 1;\n",
      "src/foo.test.ts": "import { foo } from './foo';\n",
    });
    stage(root);
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
    writeFileSync(
      join(root, "src/foo.ts"),
      "export const foo = 1;\nexport const bar = true ? 1 : 0;\n",
    );
    stage(root);
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
    const result = evaluateForwardCoverage(root, { mode: "staged" });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("uncovered changed branch");
    expect(result.message).toContain("src/foo.ts:2");
    expect(result.message).toContain("ADVISORY");
    expect(result.diffCoverage?.uncovered.map((u) => `${u.path}:${u.line}`)).toEqual([
      "src/foo.ts:2",
    ]);
  });

  it("fails closed on uncovered changed branches when enforceDiffCoverage is set", () => {
    const root = buildRepo({
      "src/foo.ts": "export const foo = 1;\n",
      "src/foo.test.ts": "import { foo } from './foo';\n",
    });
    stage(root);
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
    writeFileSync(
      join(root, "src/foo.ts"),
      "export const foo = 1;\nexport const bar = true ? 1 : 0;\n",
    );
    stage(root);
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
    const result = evaluateForwardCoverage(root, { mode: "staged", enforceDiffCoverage: true });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("FAIL: --enforce");
  });

  it("passes a well-covered new file with a matching test when the report is clean", () => {
    const root = buildRepo({
      "src/foo.ts": "export const foo = true ? 1 : 0;\n",
      "src/foo.test.ts": "import { foo } from './foo';\n",
    });
    stage(root);
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage", "coverage-final.json"),
      JSON.stringify({
        "src/foo.ts": {
          path: "src/foo.ts",
          b: { "0": [1, 1] },
          branchMap: {
            "0": {
              type: "cond-expr",
              line: 1,
              loc: { start: { line: 1 } },
              locations: [{ start: { line: 1 } }, { start: { line: 1 } }],
            },
          },
        },
      }),
      "utf8",
    );
    const result = evaluateForwardCoverage(root, { mode: "staged" });
    expect(result.exitCode).toBe(0);
    expect(result.missing).toEqual([]);
    expect(result.diffCoverage?.uncovered).toEqual([]);
    expect(result.message).toContain("all have forward coverage");
  });

  it("still fails existence when a new source file has no test even if diff coverage is clean", () => {
    const root = buildRepo({ "src/foo.ts": "export const foo = true ? 1 : 0;\n" });
    stage(root);
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage", "coverage-final.json"),
      JSON.stringify({
        "src/foo.ts": {
          path: "src/foo.ts",
          b: { "0": [1, 1] },
          branchMap: {
            "0": {
              type: "cond-expr",
              line: 1,
              loc: { start: { line: 1 } },
              locations: [{ start: { line: 1 } }, { start: { line: 1 } }],
            },
          },
        },
      }),
      "utf8",
    );
    const result = evaluateForwardCoverage(root, { mode: "staged" });
    expect(result.exitCode).toBe(1);
    expect(result.missing.map((m) => m.path)).toEqual(["src/foo.ts"]);
  });

  it("reports uncovered branches on a renamed and edited source file", () => {
    const root = buildRepo({
      "src/old.ts": "export const foo = 1;\n",
      "src/old.test.ts": "import { foo } from './old';\n",
    });
    stage(root);
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], { cwd: root });
    writeFileSync(
      join(root, "src/new.ts"),
      "export const foo = 1;\nexport const bar = true ? 1 : 0;\n",
    );
    stage(root);
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage", "coverage-final.json"),
      JSON.stringify({
        "src/new.ts": {
          path: "src/new.ts",
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
    const result = evaluateForwardCoverage(root, { mode: "staged", enforceDiffCoverage: true });
    expect(result.exitCode).toBe(1);
    expect(result.diffCoverage?.uncovered.map((u) => `${u.path}:${u.line}`)).toEqual([
      "src/new.ts:2",
    ]);
  });

  it("does not report uncovered branches on unchanged lines of a modified file", () => {
    const root = buildRepo({
      "src/foo.ts": "export const foo = true ? 1 : 0;\nexport const keep = 1;\n",
      "src/foo.test.ts": "import { foo } from './foo';\n",
    });
    stage(root);
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
    writeFileSync(
      join(root, "src/foo.ts"),
      "export const foo = true ? 1 : 0;\nexport const keep = 2;\n",
    );
    stage(root);
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
              line: 1,
              loc: { start: { line: 1 } },
              locations: [{ start: { line: 1 } }, { start: { line: 1 } }],
            },
          },
        },
      }),
      "utf8",
    );
    const result = evaluateForwardCoverage(root, { mode: "staged" });
    expect(result.exitCode).toBe(0);
    expect(result.diffCoverage?.uncovered).toEqual([]);
    expect(result.message).not.toContain("uncovered changed branch");
  });
});
