import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_NARRATIVE_KEYS } from "./constants.js";

type JsonObject = Record<string, unknown>;

const LIFECYCLE_SCAN = ["proposed", "pending", "active", "completed", "cancelled"] as const;

function loadJson(path: string): JsonObject | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  } catch {
    return null;
  }
}

function planNarrativeKeys(doc: JsonObject): Set<string> {
  const keys = new Set<string>();
  const plan = doc.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return keys;
  const narratives = (plan as JsonObject).narratives;
  if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives))
    return keys;
  for (const [key, val] of Object.entries(narratives as JsonObject)) {
    if (typeof val === "string" && val.trim()) keys.add(key.toLowerCase());
  }
  return keys;
}

function collectCanonicalNarrativeKeys(vbriefDir: string): Set<string> {
  const keys = new Set<string>();
  const pdPath = join(vbriefDir, "PROJECT-DEFINITION.vbrief.json");
  const pd = loadJson(pdPath);
  if (pd) {
    for (const k of planNarrativeKeys(pd)) keys.add(k);
  }
  for (const folder of LIFECYCLE_SCAN) {
    const dir = join(vbriefDir, folder);
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".vbrief.json"));
    } catch {
      continue;
    }
    for (const name of names) {
      const doc = loadJson(join(dir, name));
      if (doc) {
        for (const k of planNarrativeKeys(doc)) keys.add(k);
      }
    }
  }
  return keys;
}

function premigrateNarrativeKeys(vbriefDir: string): Set<string> {
  const keys = new Set<string>();
  const premigrate = join(vbriefDir, "specification.premigrate.vbrief.json");
  const doc = loadJson(premigrate);
  if (!doc) return keys;
  for (const k of planNarrativeKeys(doc)) keys.add(k);
  return keys;
}

function isProductKey(keyLower: string): boolean {
  if (keyLower === "overview") return false;
  return PRODUCT_NARRATIVE_KEYS.some((p) => p.toLowerCase() === keyLower);
}

/**
 * #2005 migration-fidelity: when specification.vbrief.json is absent but a
 * premigrate snapshot exists, require product narratives to land in PD or scopes.
 */
export function checkSpecMigrationFidelity(projectRoot: string): string[] {
  const vbriefDir = join(projectRoot, "vbrief");
  const specPath = join(vbriefDir, "specification.vbrief.json");
  if (existsSync(specPath)) return [];

  const premigratePath = join(vbriefDir, "specification.premigrate.vbrief.json");
  if (!existsSync(premigratePath)) return [];

  const premigrateKeys = premigrateNarrativeKeys(vbriefDir);
  const productPremigrate = [...premigrateKeys].filter(isProductKey);
  if (productPremigrate.length === 0) return [];

  const canonicalKeys = collectCanonicalNarrativeKeys(vbriefDir);
  const missing = productPremigrate.filter((k) => !canonicalKeys.has(k));
  if (missing.length === 0) return [];

  return [
    `vbrief/specification.vbrief.json is absent but vbrief/specification.premigrate.vbrief.json retains product narratives not found in PROJECT-DEFINITION or lifecycle scope vBRIEFs: ${missing.join(", ")}. ` +
      "Do not delete the legacy spec without migrating content. Run `task migrate:vbrief` or manually merge narratives into PROJECT-DEFINITION / scope vBRIEFs before removing the premigrate snapshot. See #2005.",
  ];
}
