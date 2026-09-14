import { describe, expect, it, vi } from "vitest";
import { run } from "./release-wait-npm.js";

describe("release-wait-npm CLI wrapper (#4267)", () => {
  it("delegates argv to cmdReleaseWaitNpm", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(run(["--help"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects missing version with exit 2", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(run([])).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
