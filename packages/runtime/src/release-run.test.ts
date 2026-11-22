import { describe, expect, it, vi } from "vitest";
import { run } from "./release-run.js";

describe("release-run CLI wrapper (#6876)", () => {
  it("delegates argv to cmdReleaseRun", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(run(["--help"])).toBe(0);
      expect(String(spy.mock.calls[0]?.[0])).toContain("deft release:run <version>");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a missing version with exit 2", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(run([])).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
