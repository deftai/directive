import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROTECTED_GLOBS,
  DEFAULT_TEST_MARKERS,
  defaultClassChecksPolicy,
  loadClassChecksPolicy,
} from "./policy.js";

describe("class-checks policy (#4980)", () => {
  it("defaults include hooks, authz, verifier, publish, approved-scope", () => {
    const p = defaultClassChecksPolicy();
    expect(p.protectedGlobs).toEqual(DEFAULT_PROTECTED_GLOBS);
    expect(p.testMarkers).toEqual(DEFAULT_TEST_MARKERS);
    expect(p.protectedGlobs.some((g) => g.includes("authz"))).toBe(true);
    expect(p.protectedGlobs.some((g) => g.includes("class-checks"))).toBe(true);
    expect(p.protectedGlobs.some((g) => g.includes("npm-publish"))).toBe(true);
    expect(p.protectedGlobs.some((g) => g.includes("approved-scope"))).toBe(true);
  });

  it("parses injected file text", () => {
    const p = loadClassChecksPolicy("/tmp", {
      fileText: JSON.stringify({
        protectedGlobs: ["hooks/**"],
        testMarkers: ["smoke"],
      }),
    });
    expect(p.protectedGlobs).toEqual(["hooks/**"]);
    expect(p.testMarkers).toEqual(["smoke"]);
    expect(p.source).toBe("file");
  });
});
