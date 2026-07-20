import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDirectiveDistance, probeDirectiveStaleness } from "./probe-directive.js";

const root = join("consumer");
const manifestPath = join(root, ".deft", "core", "VERSION");
const manifest = `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n`;

describe("probeDirectiveStaleness", () => {
  it("detects available directive releases", () => {
    const result = probeDirectiveStaleness(root, {
      isFile: (path) => path === manifestPath,
      readText: (path) => (path === manifestPath ? manifest : null),
      runNpmView: () => ({ ok: true, version: "1.1.0" }),
    });
    expect(result?.stale).toBe(true);
    expect(result?.availability.status).toBe("available");
  });

  it("ignores prerelease latest for stable installs", () => {
    const result = probeDirectiveStaleness(root, {
      isFile: (path) => path === manifestPath,
      readText: (path) => (path === manifestPath ? manifest : null),
      runNpmView: () => ({ ok: true, version: "2.0.0-rc.1" }),
    });
    expect(result?.stale).toBe(false);
    expect(result?.availability.status).toBe("prerelease-ignored");
  });

  it("returns null offline without npm", () => {
    const result = probeDirectiveStaleness(root, {
      env: { DEFT_NO_NETWORK: "1" },
      isFile: (path) => path === manifestPath,
      readText: (path) => (path === manifestPath ? manifest : null),
    });
    expect(result).toBeNull();
  });

  it("computes major/minor distance", () => {
    expect(computeDirectiveDistance("1.0.0", "2.1.3").majorBehind).toBe(true);
    expect(computeDirectiveDistance("1.0.0", "2.1.3").minorDistance).toBe(0);
    expect(computeDirectiveDistance("1.0.0", "1.2.0").minorDistance).toBe(2);
  });
});
