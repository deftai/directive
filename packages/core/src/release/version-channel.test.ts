import { describe, expect, it } from "vitest";
import { releaseDistTag, validateReleaseChannelVersion, validateVersion } from "./version.js";

describe("channel-aware release version gate (#5852 P3)", () => {
  it("admits stable and publishable prereleases", () => {
    for (const v of ["0.129.0", "0.129.0-beta.1", "0.129.0-rc.2", "0.129.0-alpha.1"]) {
      expect(() => validateReleaseChannelVersion(v)).not.toThrow();
    }
  });

  it("refuses non-publishable, latest-shaped, and malformed versions", () => {
    for (const v of ["0.129.0-test.1", "0.129.0-latest.1", "v0.129.0", "0.129", "0.129.0-beta"]) {
      expect(() => validateReleaseChannelVersion(v)).toThrow(/Invalid version/);
    }
  });

  it("maps stable to maintainer and prereleases to their id; never latest", () => {
    expect(releaseDistTag("0.129.0")).toBe("maintainer");
    expect(releaseDistTag("0.129.0-beta.1")).toBe("beta");
    expect(releaseDistTag("0.129.0-rc.4")).toBe("rc");
    for (const v of ["0.129.0", "0.129.0-beta.1", "0.129.0-rc.4", "0.129.0-alpha.2"]) {
      expect(releaseDistTag(v)).not.toBe("latest");
    }
  });

  it("leaves strict validateVersion unchanged for unrelated callers", () => {
    expect(() => validateVersion("0.129.0")).not.toThrow();
    expect(() => validateVersion("0.129.0-beta.1")).toThrow(/strict semver/);
  });
});
