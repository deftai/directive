import { readFileSync } from "node:fs";
import { join } from "node:path";

export type OpenPackageTierName = "daily-core" | "standard" | "advanced";

export interface OpenPackageTierManifest {
  readonly defaultInstallTier: OpenPackageTierName;
  readonly tiers: Record<OpenPackageTierName, { skills: string[] }>;
}

const TIER_NAMES: readonly OpenPackageTierName[] = ["daily-core", "standard", "advanced"];

function isOpenPackageTierName(value: string): value is OpenPackageTierName {
  return (TIER_NAMES as readonly string[]).includes(value);
}

function loadOpenPackageTierManifest(repoRoot: string): OpenPackageTierManifest {
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

function resolveTierSkills(
  manifest: OpenPackageTierManifest,
  tier: OpenPackageTierName | "all",
): string[] {
  if (tier === "all") {
    return [...new Set(TIER_NAMES.flatMap((name) => manifest.tiers[name].skills))];
  }
  return [...manifest.tiers[tier].skills];
}

/** Default OpenPackage install tier from deft-tiers.json (#2494). */
export function getOpenPackageDefaultInstallTier(repoRoot: string): OpenPackageTierName {
  return loadOpenPackageTierManifest(repoRoot).defaultInstallTier;
}

/** Skill names for an OpenPackage tier selection (`all` = every mapped skill). */
export function resolveOpenPackageTierSkills(
  repoRoot: string,
  tier: OpenPackageTierName | "all",
): string[] {
  return resolveTierSkills(loadOpenPackageTierManifest(repoRoot), tier);
}
