import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cmdCoreLint,
  cmdCoreTest,
  cmdCoreValidate,
  formatFrameworkCommand,
  main,
  resolveFrameworkRoot,
  runFrameworkCommand,
} from "./framework-commands.js";

describe("framework-commands branch coverage", () => {
  it("cmdCoreLint and cmdCoreTest report removal", () => {
    expect(cmdCoreLint([])).toBe(2);
    expect(cmdCoreTest([])).toBe(2);
  });

  it("cmdCoreValidate rejects unexpected argv", () => {
    expect(cmdCoreValidate(["--extra"])).toBe(2);
  });

  // win32 keeps the global cap (#3616). A bare number here would LOWER win32
  // below the suite cap rather than raising the tight non-win32 default.
  it("cmdCoreValidate succeeds with capture", {
    timeout: process.platform === "win32" ? 240_000 : 5_000,
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "fw-core-val-"));
    writeFileSync(join(root, "sample.md"), "# sample\n", "utf8");
    try {
      const result = runFrameworkCommand("core:validate", [], {
        capture: true,
        frameworkRoot: root,
        projectRoot: root,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("sample.md");
      expect(result.stdout).toContain("All 1 markdown files validated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cmdCoreValidate skips node_modules and .deft-scratch under explicit root", () => {
    const root = mkdtempSync(join(tmpdir(), "fw-core-val-skip-"));
    writeFileSync(join(root, "good.md"), "# good\n", "utf8");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "bad.md"), "# bad\n", "utf8");
    mkdirSync(join(root, ".deft-scratch"), { recursive: true });
    writeFileSync(join(root, ".deft-scratch", "scratch.md"), "# scratch\n", "utf8");
    const prevWrite = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = (chunk) => {
      out += String(chunk);
      return true;
    };
    try {
      expect(cmdCoreValidate([], root)).toBe(0);
    } finally {
      process.stdout.write = prevWrite;
      rmSync(root, { recursive: true, force: true });
    }
    expect(out).toContain("good.md");
    expect(out).not.toContain("bad.md");
    expect(out).not.toContain("scratch.md");
    expect(out).toContain("All 1 markdown files validated");
  });

  it("formatFrameworkCommand supports task surface prefix", () => {
    expect(formatFrameworkCommand(["check"], { surface: "task", taskPrefix: "deft" })).toBe(
      "task deft:check",
    );
    expect(formatFrameworkCommand(["check"], { surface: "task", taskPrefix: "deft:" })).toBe(
      "task deft:check",
    );
  });

  it("main prints help and exits zero", () => {
    expect(main([])).toBe(0);
    expect(main(["help"])).toBe(0);
  });

  it("resolveFrameworkRoot honors DEFT_ROOT", () => {
    const previous = process.env.DEFT_ROOT;
    process.env.DEFT_ROOT = "/tmp/custom-deft-root";
    try {
      expect(resolveFrameworkRoot()).toBe(resolve("/tmp/custom-deft-root"));
    } finally {
      if (previous === undefined) delete process.env.DEFT_ROOT;
      else process.env.DEFT_ROOT = previous;
    }
  });

  it("runFrameworkCommand fails when deft CLI is not built", () => {
    const result = runFrameworkCommand("triage:welcome", [], {
      capture: true,
      frameworkRoot: "/tmp/missing-deft-cli-root",
      projectRoot: "/tmp/missing-deft-cli-root",
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("deft CLI not built");
  });
});
