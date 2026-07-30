import { describe, expect, it } from "vitest";
import { fixtureCasesFor, HOOK_FIXTURE_CASES } from "./index.js";

describe("fixtures barrel (#2950)", () => {
  it("re-exports corpus helpers", () => {
    expect(HOOK_FIXTURE_CASES.length).toBeGreaterThan(0);
    expect(fixtureCasesFor({ host: "cursor" }).length).toBeGreaterThan(0);
  });
});
