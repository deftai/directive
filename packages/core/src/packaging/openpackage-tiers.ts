import { readFileSync } from "node:fs";
import { join } from "node:path";

export type OpenPackageTierName = "daily-core" | "standard" | "advanced";

export interface OpenPackageTierManifest {
  readonly defaultInstallTier: OpenPackageTierName;
  readonly tiers: Record<OpenPackageTierName, { skills: string[] }>;
}

const TIER_NAMES: readonly OpenPackageTierName[] = ["daily-core", "standard", "advanced"];

export function isOpenPackageTierName(value: string): value is OpenPackageTierName {
  return (TIER_NAMES as readonly string[]).includes(value);
}

/** Load packaging/openpackage/deft-tiers.json from a repo root. */
export function loadOpenPackageTierManifest(repoRoot: string): OpenPackageTierManifest {
  const path = join(repoRoot, "packaging", "openpackage", "deft-tiers.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    defaultInstallTier?: string;
    tiers?: Record<string, { skills?: string[] }>;
  };

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
    tiers: parsed.tiers as OpenPackageTierManifest["tiers"],
  };
}

/** Resolve skill names to sync/install for a tier selection (`all` = every tier). */
export function resolveTierSkills(
  manifest: OpenPackageTierManifest,
  tier: OpenPackageTierName | "all",
): string[] {
  if (tier === "all") {
    return TIER_NAMES.flatMap((name) => manifest.tiers[name].skills);
  }
  return [...manifest.tiers[tier].skills];
}
