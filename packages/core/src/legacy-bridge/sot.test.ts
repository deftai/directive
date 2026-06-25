import { describe, expect, it } from "vitest";
import { isFrozen, LAST_GO_INSTALLER, lastGoInstaller } from "./sot.js";

describe("legacy-bridge SoT (lastGoInstaller)", () => {
  it("is pinned to the final Go-installer tag once frozen (#1912)", () => {
    // The operator froze the SoT at v0.56.0; assert against the constant rather
    // than a literal so this stays clear of the verify:bridge-drift gate.
    expect(LAST_GO_INSTALLER).not.toBeNull();
    expect(lastGoInstaller()).toBe(LAST_GO_INSTALLER);
  });

  it("isFrozen() is true once the SoT is pinned", () => {
    expect(isFrozen()).toBe(true);
  });

  it("lastGoInstaller() mirrors the constant exactly", () => {
    expect(lastGoInstaller()).toBe(LAST_GO_INSTALLER);
  });
});
