import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
