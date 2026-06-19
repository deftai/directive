import { describe, expect, it } from "vitest";
import * as vbriefBuild from "./index.js";

describe("vbrief-build barrel exports", () => {
  it("re-exports core helpers", () => {
    expect(vbriefBuild.slugify("Hello World")).toBe("hello-world");
    expect(vbriefBuild.PARITY_SCENARIO_NAMES.length).toBeGreaterThan(0);
    expect(vbriefBuild.planStatusMatchesFolder("running", "active")).toBe(true);
    expect(typeof vbriefBuild.cmdVbriefBuild).toBe("function");
  });
});
