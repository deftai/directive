import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isOpenPackageTierName,
  loadOpenPackageTierManifest,
  resolveTierSkills,
} from "./openpackage-tiers.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

describe("openpackage-tiers (#2494)", () => {
  it("loads defaultInstallTier and resolves daily-core skill list", () => {
    const manifest = loadOpenPackageTierManifest(REPO_ROOT);
    expect(manifest.defaultInstallTier).toBe("daily-core");
    const dailyCore = resolveTierSkills(manifest, "daily-core");
    expect(dailyCore).toContain("deft-directive-setup");
    expect(dailyCore).toHaveLength(6);
    expect(dailyCore).not.toContain("deft-directive-release");
  });

  it("resolveTierSkills all returns every mapped skill", () => {
    const manifest = loadOpenPackageTierManifest(REPO_ROOT);
    expect(resolveTierSkills(manifest, "all")).toHaveLength(20);
  });

  it("isOpenPackageTierName rejects unknown tiers", () => {
    expect(isOpenPackageTierName("daily-core")).toBe(true);
    expect(isOpenPackageTierName("bogus")).toBe(false);
  });
});
