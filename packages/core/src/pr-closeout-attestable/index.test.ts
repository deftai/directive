import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";

describe("pr-closeout-attestable barrel", () => {
  it("re-exports the gate entry point consumers import by subpath", () => {
    expect(typeof barrel.evaluate).toBe("function");
  });
});
