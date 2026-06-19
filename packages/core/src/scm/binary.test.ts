import { describe, expect, it } from "vitest";
import { defaultWhich, resolveBinary } from "./binary.js";
import { BINARY_PREFERENCE } from "./constants.js";
import { ScmStubError } from "./errors.js";

describe("resolveBinary", () => {
  it("prefers ghx when both are on PATH", () => {
    const whichFn = (name: string) => `/usr/bin/${name}`;
    expect(resolveBinary(whichFn)).toBe("ghx");
  });

  it("falls back to gh when ghx is absent", () => {
    const whichFn = (name: string) => (name === "gh" ? "/usr/local/bin/gh" : null);
    expect(resolveBinary(whichFn)).toBe("gh");
  });

  it("raises ScmStubError when neither binary is present", () => {
    expect(() => resolveBinary(() => null)).toThrow(ScmStubError);
    expect(() => resolveBinary(() => null)).toThrow(/neither 'ghx' nor 'gh'/);
  });

  it("pins the preference order", () => {
    expect(BINARY_PREFERENCE[0]).toBe("ghx");
    expect(BINARY_PREFERENCE[1]).toBe("gh");
  });

  it("defaultWhich returns null for missing commands", () => {
    expect(defaultWhich("definitely-not-a-real-binary-xyz")).toBeNull();
  });
});
