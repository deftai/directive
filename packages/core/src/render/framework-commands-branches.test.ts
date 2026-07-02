import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("cmdCoreValidate succeeds with capture", () => {
    const root = mkdtempSync(join(tmpdir(), "fw-core-val-"));
    writeFileSync(join(root, "sample.md"), "# sample\n", "utf8");
    try {
      const result = runFrameworkCommand("core:validate", [], {
        capture: true,
        frameworkRoot: root,
        projectRoot: root,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("markdown files validated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      expect(resolveFrameworkRoot()).toBe("/tmp/custom-deft-root");
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
