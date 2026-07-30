import { describe, expect, it } from "vitest";
import { fixtureCaseById, fixtureCasesFor, HOOK_FIXTURE_CASES } from "./index.js";

describe("fixtures barrel (#2950 Phase B)", () => {
  it("re-exports corpus helpers", () => {
    expect(HOOK_FIXTURE_CASES.length).toBeGreaterThanOrEqual(24);
    expect(fixtureCasesFor({ host: "cursor" }).length).toBeGreaterThan(0);
    expect(fixtureCaseById("cursor-win32-write-structured")?.os).toBe("win32");
  });
});
