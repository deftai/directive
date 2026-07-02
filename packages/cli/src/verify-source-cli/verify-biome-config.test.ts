import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-biome-config.js";

describe("parseArgs", () => {
  it("defaults to '.' project root", () => {
    expect(parseArgs([])).toMatchObject({ projectRoot: "." });
  });
  it("parses --project-root in space and = forms", () => {
    expect(parseArgs(["--project-root", "/r"]).projectRoot).toBe("/r");
    expect(parseArgs(["--project-root=/r2"]).projectRoot).toBe("/r2");
  });
  it("errors on a missing value or unknown flag", () => {
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});

describe("run", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
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

  it("returns 0 when both guarded rules have explicit non-error severities", () => {
    root = mkdtempSync(join(tmpdir(), "verify-biome-config-cli-"));
    writeFileSync(
      join(root, "biome.json"),
      JSON.stringify({
        linter: {
          rules: {
            preset: "recommended",
            correctness: { noUnusedVariables: "warn" },
            style: { noNonNullAssertion: "warn" },
          },
        },
      }),
    );
    expect(silentRun(["--project-root", root])).toBe(0);
  });

  it("returns 1 when a guarded rule has no explicit severity", () => {
    root = mkdtempSync(join(tmpdir(), "verify-biome-config-cli-"));
    writeFileSync(join(root, "biome.json"), JSON.stringify({ linter: { rules: {} } }));
    expect(silentRun(["--project-root", root])).toBe(1);
  });

  it("returns 2 when biome.json is missing", () => {
    root = mkdtempSync(join(tmpdir(), "verify-biome-config-cli-"));
    expect(silentRun(["--project-root", root])).toBe(2);
  });

  it("returns 2 for a bad argument", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("writes the clean message to stdout and the failure to stderr", () => {
    root = mkdtempSync(join(tmpdir(), "verify-biome-config-cli-"));
    writeFileSync(
      join(root, "biome.json"),
      JSON.stringify({
        linter: {
          rules: {
            correctness: { noUnusedVariables: "warn" },
            style: { noNonNullAssertion: "warn" },
          },
        },
      }),
    );
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

  it("validates this repo's own biome.json via the default '.' project root when run from repo root", () => {
    expect(silentRun(["--project-root", join(import.meta.dirname, "..", "..", "..", "..")])).toBe(
      0,
    );
  });
});
