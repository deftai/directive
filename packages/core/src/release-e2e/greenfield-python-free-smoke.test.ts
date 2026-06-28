import { describe, expect, it } from "vitest";
import { rehearseGreenfieldPythonFreeSmoke } from "./greenfield-python-free-smoke.js";

describe("rehearseGreenfieldPythonFreeSmoke (#2022 Phase 3)", () => {
  it("soft-skips when npm is absent", () => {
    const [ok, reason] = rehearseGreenfieldPythonFreeSmoke("/tmp/unused", { which: () => null });
    expect(ok).toBe(true);
    expect(reason).toContain("SKIP");
  });
});
