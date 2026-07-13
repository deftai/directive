#!/usr/bin/env node
/**
 * Copy content/skills/* into the OpenPackage skills/ tree before opkg install.
 * Source of truth remains content/skills/ (pack-rendered); this is distribution prep only.
 *
 * Default (--tier omitted): sync defaultInstallTier from deft-tiers.json (daily-core).
 * Use --tier all for maintainer release prep with every tier on disk.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isOpenPackageTierName,
  loadOpenPackageTierManifest,
  resolveTierSkills,
} from "./openpackage-tiers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const packageRoot = join(here, "deft-directive-skills");
const skillsDest = join(packageRoot, "skills");
const skillsSource = join(repoRoot, "content/skills");
const gitkeepPath = join(skillsDest, ".gitkeep");

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

function resolveSyncTier(manifest, cliTier) {
  const selected = cliTier ?? manifest.defaultInstallTier;
  if (selected === "all") {
    return "all";
  }
  if (!isOpenPackageTierName(selected)) {
    console.error(
      `sync-skills: --tier must be one of daily-core, standard, advanced, all; got ${selected}`,
    );
    process.exit(1);
  }
  return selected;
}

const { tier: cliTier } = parseArgs(process.argv.slice(2));

let manifest;
try {
  manifest = loadOpenPackageTierManifest(repoRoot);
} catch (err) {
  console.error(`sync-skills: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const syncTier = resolveSyncTier(manifest, cliTier);
const wanted = new Set(resolveTierSkills(manifest, syncTier));
const allMapped = new Set(resolveTierSkills(manifest, "all"));

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
