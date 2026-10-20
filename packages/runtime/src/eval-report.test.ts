import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./eval-report.js";

describe("eval-report CLI", () => {
  it("parses champion, challenger, and model", () => {
    expect(
      parseArgs(["--champion", "0.70.0", "--challenger", "0.71.0", "--model", "composer"]),
    ).toMatchObject({
      championVersion: "0.70.0",
      challengerVersion: "0.71.0",
      model: "composer",
    });
  });

  it("returns not-ready when ledger is empty", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        run([
          "--champion",
          "0.70.0",
          "--challenger",
          "0.71.0",
          "--model",
          "composer",
          "--project-root",
          ".",
        ]),
      ).toBe(1);
    } finally {
      err.mockRestore();
    }
  });
});
