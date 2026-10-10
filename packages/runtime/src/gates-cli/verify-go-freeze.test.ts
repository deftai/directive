import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-go-freeze.js";

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
  it("returns 0 (advisory) on a repo where the SoT is null", () => {
    // The live SoT (lastGoInstaller) is null, so the gate passes regardless of
    // the installer source -- an empty repo root suffices.
    const root = mkdtempSync(join(tmpdir(), "deft-gofreeze-cli-"));
    temps.push(root);
    expect(silentRun(["--project-root", root])).toBe(0);
  });

  it("returns 2 for a bad argument", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("writes the advisory message to stdout, not stderr", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-gofreeze-cli-out-"));
    temps.push(root);
    mkdirSync(join(root, "cmd", "deft-install"), { recursive: true });
    writeFileSync(join(root, "cmd", "deft-install", "main.go"), 'var version = "0.1.0"\n');
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", root])).toBe(0);
      expect(out).toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
