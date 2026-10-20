import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-bridge-drift.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
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

describe("parseArgs", () => {
  it("defaults to null project root", () => {
    expect(parseArgs([])).toMatchObject({ projectRoot: null });
  });
  it("parses --project-root in space and = forms", () => {
    expect(parseArgs(["--project-root", "/r"]).projectRoot).toBe("/r");
    expect(parseArgs(["--project-root=/r2"]).projectRoot).toBe("/r2");
  });
  it("errors on missing value and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 2 when the SoT module is absent (config error)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-drift-cli-nosot-"));
    temps.push(root);
    expect(silentRun(["--project-root", root])).toBe(2);
  });

  it("returns 2 for a bad argument", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("returns 0 (clean) against the live repo where the SoT module exists", () => {
    // No --project-root => defaults to the repo CWD where packages/core/src/
    // legacy-bridge/sot.ts exists and no surface hardcodes a marked version.
    expect(silentRun([])).toBe(0);
  });

  it("writes a config-error message to stderr, not stdout", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-drift-cli-err-"));
    temps.push(root);
    writeFileSync(join(root, "placeholder.txt"), "x\n");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", root])).toBe(2);
      expect(err).toHaveBeenCalled();
      expect(out).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
