import { describe, expect, it } from "vitest";
import * as freshness from "./index.js";

describe("freshness index exports (#3117)", () => {
  it("re-exports core API surface", () => {
    expect(typeof freshness.stampLiveGeneration).toBe("function");
    expect(typeof freshness.bindSessionGeneration).toBe("function");
    expect(typeof freshness.compareFreshness).toBe("function");
    expect(typeof freshness.reportFreshness).toBe("function");
    expect(typeof freshness.runFreshnessCli).toBe("function");
    expect(typeof freshness.mainEntry).toBe("function");
    expect(freshness.FRESHNESS_SCHEMA_VERSION).toBe(1);
  });
});
