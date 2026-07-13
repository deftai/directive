#!/usr/bin/env node
/**
 * Spike #2370 acceptance: daily-core tier Cursor <agent_skill> frontmatter ≤ 2080 B.
 * Parses YAML frontmatter `description` fields in Cursor injection shape.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tiersPath = join(here, "deft-tiers.json");
const skillsRoot = join(here, "deft-directive-skills/skills");

function loadTiers() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(tiersPath, "utf8"));
  } catch (err) {
    console.error(`measure-daily-core-frontmatter: invalid JSON in ${tiersPath}: ${err}`);
    process.exit(2);
  }
  if (parsed === null || typeof parsed !== "object" || !parsed.tiers?.["daily-core"]?.skills) {
    console.error(`measure-daily-core-frontmatter: ${tiersPath} missing tiers.daily-core.skills`);
    process.exit(2);
  }
  return parsed;
}

function extractDescription(frontmatter) {
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("description:")) continue;
    const inline = line.slice("description:".length).trim();
    if (inline === ">-" || inline.startsWith(">- ")) {
      const folded = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (/^\s+\S/.test(next)) {
          folded.push(next.trim());
          continue;
        }
        if (/^\s*$/.test(next)) {
          folded.push("");
          continue;
        }
        break;
      }
      return folded.join(" ").replace(/\s+/g, " ").trim();
    }
    if (inline.length > 0) {
      return inline;
    }
  }
  return null;
}

function descriptionBytes(skillName) {
  const skillPath = join(skillsRoot, skillName, "SKILL.md");
  const text = readFileSync(skillPath, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`${skillName}: missing frontmatter`);
  const description = extractDescription(match[1]);
  if (!description) throw new Error(`${skillName}: missing description`);
  const injected = `<agent_skill fullPath="...">${description}</agent_skill>`;
  return Buffer.byteLength(injected, "utf8");
}

const tiers = loadTiers();
const budget = tiers.dailyCoreFrontmatterBudgetBytes ?? 2080;
const dailyCore = tiers.tiers["daily-core"].skills;

const onDisk = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
if (onDisk.length === 0) {
  console.error("measure-daily-core-frontmatter: run sync-skills.mjs first");
  process.exit(2);
}

let total = 0;
for (const skill of dailyCore) {
  const bytes = descriptionBytes(skill);
  total += bytes;
  console.log(`${skill}: ${bytes} B`);
}
console.log(`daily-core total: ${total} B (budget ${budget} B)`);
process.exit(total <= budget ? 0 : 1);
