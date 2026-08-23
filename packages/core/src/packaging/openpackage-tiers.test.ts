import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getOpenPackageDefaultInstallTier,
  resolveOpenPackageTierSkills,
} from "./openpackage-tiers.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

describe("openpackage-tiers (#2494)", () => {
  it("loads defaultInstallTier and resolves daily-core skill list", () => {
    expect(getOpenPackageDefaultInstallTier(REPO_ROOT)).toBe("daily-core");
    const dailyCore = resolveOpenPackageTierSkills(REPO_ROOT, "daily-core");
    expect(dailyCore).toContain("deft-directive-setup");
    expect(dailyCore).toHaveLength(6);
    expect(dailyCore).not.toContain("deft-directive-release");
  });

  it("resolveOpenPackageTierSkills all returns every mapped skill without duplicates", () => {
    const all = resolveOpenPackageTierSkills(REPO_ROOT, "all");
    expect(all).toHaveLength(25);
    expect(new Set(all).size).toBe(25);
  });
});
