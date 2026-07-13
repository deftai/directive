#!/usr/bin/env node
/**
 * Spike #2370 acceptance: daily-core tier Cursor <agent_skill> frontmatter ≤ 2080 B.
 * Parses YAML frontmatter `description` fields in Cursor injection shape.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tiers = JSON.parse(readFileSync(join(here, "deft-tiers.json"), "utf8"));
const budget = tiers.dailyCoreFrontmatterBudgetBytes ?? 2080;
const skillsRoot = join(here, "deft-directive-skills/skills");
const dailyCore = tiers.tiers["daily-core"].skills;

function descriptionBytes(skillName) {
  const skillPath = join(skillsRoot, skillName, "SKILL.md");
  const text = readFileSync(skillPath, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`${skillName}: missing frontmatter`);
  const block = match[1];
  const descMatch = block.match(/^description:\s*(?:>\-\s*\n((?:\s+.+\n?)*)|(.+))$/m);
  if (!descMatch) throw new Error(`${skillName}: missing description`);
  const folded = descMatch[1]
    ? descMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .join(" ")
    : descMatch[2].trim();
  const injected = `<agent_skill fullPath="...">${folded}</agent_skill>`;
  return Buffer.byteLength(injected, "utf8");
}

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
