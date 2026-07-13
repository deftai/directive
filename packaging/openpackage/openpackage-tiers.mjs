/**
 * OpenPackage tier manifest helpers for packaging scripts (#2494).
 * Mirrors packages/core/src/packaging/openpackage-tiers.ts for node-runnable sync without a prior tsc build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TIER_NAMES = ["daily-core", "standard", "advanced"];

export function isOpenPackageTierName(value) {
  return TIER_NAMES.includes(value);
}

/** Load packaging/openpackage/deft-tiers.json from a repo root. */
export function loadOpenPackageTierManifest(repoRoot) {
  const path = join(repoRoot, "packaging", "openpackage", "deft-tiers.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`deft-tiers.json unreadable at ${path}: ${err}`);
  }

  if (parsed === null || typeof parsed !== "object" || !parsed.tiers) {
    throw new Error("deft-tiers.json must be an object with a tiers field");
  }

  for (const tier of TIER_NAMES) {
    const block = parsed.tiers[tier];
    if (!block || !Array.isArray(block.skills)) {
      throw new Error(`deft-tiers.json missing tiers.${tier}.skills`);
    }
  }

  const defaultInstallTier = parsed.defaultInstallTier ?? "daily-core";
  if (!isOpenPackageTierName(defaultInstallTier)) {
    throw new Error(
      `deft-tiers.json defaultInstallTier must be one of ${TIER_NAMES.join(", ")}; got ${defaultInstallTier}`,
    );
  }

  return {
    defaultInstallTier,
    tiers: parsed.tiers,
  };
}

/** Resolve skill names to sync/install for a tier selection (`all` = every tier). */
export function resolveTierSkills(manifest, tier) {
  if (tier === "all") {
    return [...new Set(TIER_NAMES.flatMap((name) => manifest.tiers[name].skills))];
  }
  if (!isOpenPackageTierName(tier)) {
    throw new Error(`unknown tier ${tier}; expected one of ${[...TIER_NAMES, "all"].join(", ")}`);
  }
  return [...manifest.tiers[tier].skills];
}
