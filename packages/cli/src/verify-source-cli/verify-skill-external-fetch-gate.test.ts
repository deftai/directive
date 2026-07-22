import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-skill-external-fetch-gate.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

describe("parseArgs", () => {
  it("defaults to null project root", () => {
    expect(parseArgs([])).toMatchObject({ projectRoot: null });
  });

  it("parses --project-root in space and = forms", () => {
    expect(parseArgs(["--project-root", "/r"]).projectRoot).toBe("/r");
    expect(parseArgs(["--project-root=/r2"]).projectRoot).toBe("/r2");
  });

  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns_0_on_real_framework_source_tree", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", REPO_ROOT])).toBe(0);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
