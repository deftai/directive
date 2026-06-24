import { describe, expect, it } from "vitest";
import { isFrozen, LAST_GO_INSTALLER, lastGoInstaller } from "./sot.js";

describe("legacy-bridge SoT (lastGoInstaller)", () => {
  it("is null-until-frozen by default", () => {
    expect(LAST_GO_INSTALLER).toBeNull();
    expect(lastGoInstaller()).toBeNull();
  });

  it("isFrozen() is false while the SoT is null", () => {
    expect(isFrozen()).toBe(false);
  });

  it("lastGoInstaller() mirrors the constant exactly", () => {
    expect(lastGoInstaller()).toBe(LAST_GO_INSTALLER);
  });
});
