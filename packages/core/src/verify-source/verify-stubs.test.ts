import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateVerifyStubs, scanFileForStubs, sortedRglob } from "./verify-stubs.js";

describe("evaluateVerifyStubs", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("exits 0 when no stub patterns exist", () => {
    root = mkdtempSync(join(tmpdir(), "stubs-clean-"));
    mkdirSync(join(root, "cmd", "app"), { recursive: true });
    writeFileSync(join(root, "cmd", "app", "main.go"), "package main\nfunc main() {}\n", "utf8");
    const result = evaluateVerifyStubs(root);
    expect(result.code).toBe(0);
    expect(result.message).toBe("No stub patterns found in source files");
  });

  it("exits 1 when TODO is present", () => {
    root = mkdtempSync(join(tmpdir(), "stubs-todo-"));
    mkdirSync(join(root, "cmd", "app"), { recursive: true });
    writeFileSync(join(root, "cmd", "app", "main.go"), "// TODO fix\npackage main\n", "utf8");
    const result = evaluateVerifyStubs(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain("Found 1 stub(s)");
    expect(result.message).toContain("[TODO]");
  });

  it("skips excluded scripts directory", () => {
    root = mkdtempSync(join(tmpdir(), "stubs-skip-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "tool.py"), "# TODO\n", "utf8");
    const result = evaluateVerifyStubs(root);
    expect(result.code).toBe(0);
  });

  it("detects bare pass stubs in python", () => {
    root = mkdtempSync(join(tmpdir(), "stubs-pass-"));
    mkdirSync(join(root, "pkg"), { recursive: true });
    writeFileSync(join(root, "pkg", "mod.py"), "def f():\n    pass\n", "utf8");
    const findings = scanFileForStubs("pkg/mod.py", join(root, "pkg", "mod.py"));
    expect(findings.some((f) => f.label === "bare pass")).toBe(true);
  });
});

describe("scanFileForStubs branch coverage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scan-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): string {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
    return full;
  }

  it("ignores files whose extension is not scanned", () => {
    expect(scanFileForStubs("notes.txt", join(root, "notes.txt"))).toEqual([]);
  });

  it("ignores files with no extension at all", () => {
    expect(scanFileForStubs("Makefile", join(root, "Makefile"))).toEqual([]);
  });

  it("skips paths nested inside an excluded directory", () => {
    expect(scanFileForStubs("node_modules/pkg/a.py", join(root, "a.py"))).toEqual([]);
  });

  it("returns no findings when the file cannot be read", () => {
    expect(scanFileForStubs("missing.py", join(root, "does-not-exist.py"))).toEqual([]);
  });

  it("detects FIXME and HACK markers with word boundaries", () => {
    const full = write("a.go", "// FIXME later\n// HACK around\n");
    const labels = scanFileForStubs("a.go", full)
      .map((f) => f.label)
      .sort();
    expect(labels).toEqual(["FIXME", "HACK"]);
  });

  it("ignores marker-like substrings that lack word boundaries", () => {
    // leading word char (xTODO) and trailing word char (TODOz) both disqualify.
    const full = write("b.go", "xTODOx\nTODOz\nyFIXME\n");
    expect(scanFileForStubs("b.go", full)).toEqual([]);
  });

  it("detects 'return null' with arbitrary intervening whitespace", () => {
    const full = write("c.go", "func f() {\n\treturn   null\n}\n");
    expect(scanFileForStubs("c.go", full).some((f) => f.label === "return null")).toBe(true);
  });

  it("does not flag return of a non-null value or a non-boundary 'return'", () => {
    const full = write("d.go", "return value\nmyreturn null\n");
    expect(scanFileForStubs("d.go", full).some((f) => f.label === "return null")).toBe(false);
  });

  it("flags a bare pass only after a block-opening line", () => {
    const full = write("ok.py", "def f():\n    pass\n");
    expect(scanFileForStubs("ok.py", full).some((f) => f.label === "bare pass")).toBe(true);
  });

  it("does not flag a bare pass when the previous line is not a block opener", () => {
    const full = write("no-colon.py", "x = 1\n    pass\n");
    expect(scanFileForStubs("no-colon.py", full).some((f) => f.label === "bare pass")).toBe(false);
  });

  it("does not flag a bare pass when the previous line is a comment", () => {
    const full = write("comment.py", "# block:\n    pass\n");
    expect(scanFileForStubs("comment.py", full).some((f) => f.label === "bare pass")).toBe(false);
  });

  it("does not treat 'pass' on the first line as a bare-pass stub", () => {
    const full = write("first.py", "pass\n");
    expect(scanFileForStubs("first.py", full).some((f) => f.label === "bare pass")).toBe(false);
  });

  it("only treats bare pass as a stub in python, not other languages", () => {
    const full = write("g.go", "switch x {\npass\n}\n");
    expect(scanFileForStubs("g.go", full).some((f) => f.label === "bare pass")).toBe(false);
  });
});

describe("sortedRglob", () => {
  it("returns lexicographically sorted file paths", () => {
    const root = mkdtempSync(join(tmpdir(), "rglob-"));
    try {
      mkdirSync(join(root, "b"), { recursive: true });
      mkdirSync(join(root, "a"), { recursive: true });
      writeFileSync(join(root, "b", "z.go"), "", "utf8");
      writeFileSync(join(root, "a", "m.go"), "", "utf8");
      const paths = sortedRglob(root);
      expect(paths).toEqual(["a/m.go", "b/z.go"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
