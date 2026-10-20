import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./eval-health.js";

describe("eval-health CLI", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      json: false,
      noPersist: false,
    });
  });

  it("runs with --no-persist and --json", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = run(["--no-persist", "--json", "--project-root", "."]);
      expect([0, 1, 2]).toContain(code);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
