import { describe, expect, it } from "vitest";
import * as surface from "./index.js";

describe("evaluator-surface index re-exports (#4386)", () => {
  it("exports evaluate and the declared surface list", () => {
    expect(typeof surface.evaluate).toBe("function");
    expect(surface.EVALUATOR_SURFACE_PATH_PATTERNS.length).toBeGreaterThan(0);
    expect(surface.DISPOSITION_REL).toBe("xbrief/evaluator-surface-disposition.json");
  });
});
