#!/usr/bin/env node
/**
 * Copy content/skills/* into the OpenPackage skills/ tree before opkg install.
 * Source of truth remains content/skills/ (pack-rendered); this is distribution prep only.
 *
 * Default (--tier omitted): sync defaultInstallTier from deft-tiers.json (daily-core).
 * Use --tier all for maintainer release prep with every tier on disk.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const tiersPath = join(here, "deft-tiers.json");
const packageRoot = join(here, "deft-directive-skills");
const skillsDest = join(packageRoot, "skills");
const skillsSource = join(repoRoot, "content/skills");
const gitkeepPath = join(skillsDest, ".gitkeep");

const TIER_NAMES = ["daily-core", "standard", "advanced"];

function parseArgs(argv) {
  let tier = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tier" && argv[i + 1]) {
      tier = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--tier=")) {
      tier = arg.slice("--tier=".length);
    }
  }
  return { tier };
}

function loadTiers() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(tiersPath, "utf8"));
  } catch (err) {
    console.error(`sync-skills: invalid JSON in ${tiersPath}: ${err}`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== "object" || !parsed.tiers) {
    console.error(`sync-skills: ${tiersPath} must be an object with a tiers field`);
    process.exit(1);
  }
  return parsed;
}

function resolveSyncTier(tiersDoc, cliTier) {
  const selected = cliTier ?? tiersDoc.defaultInstallTier ?? "daily-core";
  if (selected === "all") {
    return "all";
  }
  if (!TIER_NAMES.includes(selected)) {
    console.error(
      `sync-skills: --tier must be one of ${[...TIER_NAMES, "all"].join(", ")}; got ${selected}`,
    );
    process.exit(1);
  }
  return selected;
}

function skillsForTier(tiersDoc, tier) {
  if (tier === "all") {
    return new Set(TIER_NAMES.flatMap((name) => tiersDoc.tiers[name].skills));
  }
  return new Set(tiersDoc.tiers[tier].skills);
}

const { tier: cliTier } = parseArgs(process.argv.slice(2));
const tiers = loadTiers();
const syncTier = resolveSyncTier(tiers, cliTier);
const wanted = skillsForTier(tiers, syncTier);

const allMapped = new Set(Object.values(tiers.tiers).flatMap((t) => t.skills));

const onDisk = readdirSync(skillsSource, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const missing = [...allMapped].filter((s) => !onDisk.includes(s));
if (missing.length > 0) {
  console.error(`sync-skills: missing content/skills entries: ${missing.join(", ")}`);
  process.exit(1);
}

const extra = onDisk.filter((s) => !allMapped.has(s));
if (extra.length > 0) {
  console.error(`sync-skills: content/skills not mapped in deft-tiers.json: ${extra.join(", ")}`);
  process.exit(1);
}

const missingForTier = [...wanted].filter((s) => !onDisk.includes(s));
if (missingForTier.length > 0) {
  console.error(`sync-skills: tier ${syncTier} references missing skills: ${missingForTier.join(", ")}`);
  process.exit(1);
}

if (existsSync(skillsDest)) {
  for (const entry of readdirSync(skillsDest, { withFileTypes: true })) {
    if (entry.name === ".gitkeep") continue;
    const target = join(skillsDest, entry.name);
    rmSync(target, { recursive: true, force: true });
  }
} else {
  mkdirSync(skillsDest, { recursive: true });
}

for (const skill of wanted) {
  cpSync(join(skillsSource, skill), join(skillsDest, skill), { recursive: true });
}

if (!existsSync(gitkeepPath)) {
  writeFileSync(gitkeepPath, "\n");
}

console.log(`sync-skills: tier=${syncTier}; copied ${wanted.size} skills to ${skillsDest}`);
