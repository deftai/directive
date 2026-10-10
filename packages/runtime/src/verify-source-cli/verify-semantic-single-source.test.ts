import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-semantic-single-source.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

describe("parseArgs", () => {
  it("defaults project root to dot", () => {
    expect(parseArgs([])).toMatchObject({ projectRoot: "." });
  });

  it("parses --project-root and --pack-root in space and equals forms", () => {
    expect(parseArgs(["--project-root", "/r"]).projectRoot).toBe("/r");
    expect(parseArgs(["--pack-root=/p"]).projectRoot).toBe("/p");
  });

  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 0 on the live framework source after the 0.8 canon repair", () => {
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
