import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpenPackageTierManifest, resolveTierSkills } from "./openpackage-tiers.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PACKAGING = join(REPO_ROOT, "packaging", "openpackage");
const TIERS_PATH = join(PACKAGING, "deft-tiers.json");
const SKILLS_SOURCE = join(REPO_ROOT, "content", "skills");

function listContentSkills(): string[] {
  return readdirSync(SKILLS_SOURCE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

describe("OpenPackage tier manifest (#2462)", () => {
  it("partitions every content/skills directory across exactly one tier", () => {
    const manifest = loadOpenPackageTierManifest(REPO_ROOT);
    const onDisk = listContentSkills();
    const seen = new Map<string, string>();

    for (const [tier, { skills }] of Object.entries(manifest.tiers)) {
      for (const skill of skills) {
        expect(seen.has(skill), `${skill} duplicated`).toBe(false);
        seen.set(skill, tier);
      }
    }

    const tiered = [...seen.keys()].sort();
    expect(tiered).toEqual(onDisk);
  });

  it("declares daily-core, standard, and advanced tiers with expected counts", () => {
    const manifest = loadOpenPackageTierManifest(REPO_ROOT);
    expect(manifest.tiers["daily-core"].skills).toHaveLength(6);
    expect(manifest.tiers.standard.skills).toHaveLength(10);
    expect(manifest.tiers.advanced.skills).toHaveLength(4);
  });

  it("defaults consumer install to daily-core (#2494)", () => {
    const manifest = loadOpenPackageTierManifest(REPO_ROOT);
    expect(manifest.defaultInstallTier).toBe("daily-core");
    expect(resolveTierSkills(manifest, manifest.defaultInstallTier)).toHaveLength(6);
    expect(resolveTierSkills(manifest, "all")).toHaveLength(20);
  });

  it("openpackage.yml points at deft-tiers.json and declares defaultInstallTier", () => {
    const yml = join(PACKAGING, "deft-directive-skills", "openpackage.yml");
    const text = readFileSync(yml, "utf8");
    expect(text).toContain('name: "@deftai/deft-directive-skills"');
    expect(text).toContain("tierManifest: ../deft-tiers.json");
    expect(text).toContain("defaultInstallTier: daily-core");
    expect(text).not.toContain("deft-directive-setup");
  });

  it("deft-tiers.json declares defaultInstallTier daily-core", () => {
    const raw = JSON.parse(readFileSync(TIERS_PATH, "utf8")) as { defaultInstallTier?: string };
    expect(raw.defaultInstallTier).toBe("daily-core");
  });
});
