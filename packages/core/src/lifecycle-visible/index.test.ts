/**
 * Public barrel for verify:lifecycle-visible (#3505).
 */
import { describe, expect, it } from "vitest";
import {
  evaluateLifecycleVisible,
  formatLifecycleVisibleSessionLines,
  LIFECYCLE_STAGE_DIRS,
  lifecycleRootRelPaths,
} from "./index.js";

describe("lifecycle-visible public API (#3505)", () => {
  it("re-exports the evaluator and root list", () => {
    expect(typeof evaluateLifecycleVisible).toBe("function");
    expect(typeof formatLifecycleVisibleSessionLines).toBe("function");
    expect(LIFECYCLE_STAGE_DIRS).toContain("active");
    expect(lifecycleRootRelPaths()).toContain("xbrief/active/");
  });
});
