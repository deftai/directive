import { describe, expect, it } from "vitest";
import * as cache from "./index.js";

describe("cache barrel", () => {
  it("exports core symbols", () => {
    expect(typeof cache.cachePut).toBe("function");
    expect(typeof cache.main).toBe("function");
    expect(cache.SCANNER_VERSION).toBe("2.1.0");
  });
});
