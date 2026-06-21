import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, REQUIRED_OSES } from "./helpers.js";

export { REQUIRED_OSES };

const OS_LINE = /^os\s*:\s*\[(?<body>[^\]]*)\]\s*$/m;
const OS_TOKEN = /['"]([^'"]+)['"]/g;

const EXCLUDED_PARTS = new Set([".git", ".venv", "venv", "node_modules", "__pycache__"]);

function frontmatter(text: string): string | null {
  if (!text.startsWith("---")) {
    return null;
  }
  const closing = /^---\s*$/m.exec(text.slice(3));
  if (closing === null) {
    return null;
  }
  return text.slice(3, 3 + (closing.index ?? 0));
}

function parseOsArray(fm: string): string[] | null {
  const match = OS_LINE.exec(fm);
  if (match === null) {
    return null;
  }
  const body = match.groups?.body ?? "";
  return [...body.matchAll(OS_TOKEN)].map((m) => m[1] ?? "");
}

function pathHasExcludedPart(filePath: string): boolean {
  const parts = filePath.split(/[/\\]/);
  return parts.some((part) => EXCLUDED_PARTS.has(part));
}

function discoverSkillMdFiles(dir: string, results: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_PARTS.has(entry.name)) {
        continue;
      }
      discoverSkillMdFiles(fullPath, results);
    } else if (entry.name === "SKILL.md") {
      if (!pathHasExcludedPart(fullPath)) {
        results.push(relative(REPO_ROOT, fullPath).replace(/\\/g, "/"));
      }
    }
  }
}

/** Discover every `SKILL.md` in the repo (repo-relative paths). */
export function skillMdRelPaths(): string[] {
  const results: string[] = [];
  discoverSkillMdFiles(REPO_ROOT, results);
  return results.sort();
}

/** Extract declared OS tokens from a skill's YAML frontmatter, or `null` if absent. */
export function declaredOses(relPath: string): string[] | null {
  const fullPath = join(REPO_ROOT, relPath);
  if (!existsSync(fullPath)) {
    return null;
  }
  const text = readFileSync(fullPath, "utf8");
  const fm = frontmatter(text);
  if (fm === null) {
    return null;
  }
  return parseOsArray(fm);
}
