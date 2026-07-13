#!/usr/bin/env node
/**
 * Copy content/skills/* into the OpenPackage skills/ tree before opkg install.
 * Source of truth remains content/skills/ (pack-rendered); this is distribution prep only.
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

const tiers = loadTiers();
const wanted = new Set(Object.values(tiers.tiers).flatMap((t) => t.skills));

const onDisk = readdirSync(skillsSource, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const missing = [...wanted].filter((s) => !onDisk.includes(s));
if (missing.length > 0) {
  console.error(`sync-skills: missing content/skills entries: ${missing.join(", ")}`);
  process.exit(1);
}

const extra = onDisk.filter((s) => !wanted.has(s));
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

console.log(`sync-skills: copied ${wanted.size} skills to ${skillsDest}`);
