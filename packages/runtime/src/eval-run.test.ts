import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./eval-run.js";

describe("eval-run CLI", () => {
  it("parses model and seeds", () => {
    expect(parseArgs(["--model", "composer", "--seed", "1", "--seed", "2"])).toMatchObject({
      model: "composer",
      seeds: [1, 2],
    });
  });

  it("returns config error when model is missing", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", "."])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("rejects non-numeric seed values", () => {
    const result = parseArgs(["--model", "composer", "--seed", "foo"]);
    expect(result.error).toContain("expected an integer");
  });
});
