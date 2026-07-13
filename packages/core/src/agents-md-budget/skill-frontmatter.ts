import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

/** Daily-core tier from spike #2370 / OpenPackage manifest (#2462). */
export const DAILY_CORE_SKILL_NAMES = [
  "deft-directive-setup",
  "deft-directive-sync",
  "deft-directive-build",
  "deft-directive-pre-pr",
  "deft-directive-review-cycle",
  "deft-directive-triage",
] as const;

export type SkillFrontmatterTier = "daily-core" | "all" | "none";
export type HarnessProfile = "cursor" | "none";

const DAILY_CORE_SET = new Set<string>(DAILY_CORE_SKILL_NAMES);

/** Extract the YAML `description` field from a SKILL.md frontmatter block. */
export function extractSkillDescription(text: string): string {
  if (!text.startsWith("---")) {
    return "";
  }
  const closing = text.indexOf("\n---", 3);
  if (closing === -1) {
    return "";
  }
  const frontmatter = text.slice(3, closing).replace(/^\r?\n/, "");
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^description:\s*>(-)?\s*$/.test(line)) {
      const descLines: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? "";
        if (!/^[ \t]/.test(next)) {
          break;
        }
        descLines.push(next.replace(/^[ \t]+/, ""));
      }
      return descLines.join("\n").trim();
    }
    const single = line.match(/^description:\s*(.+)$/);
    if (single !== null && single[1] !== undefined) {
      return single[1].trim();
    }
  }
  return "";
}

/**
 * Cursor `<agent_skill>` injection shape (DD-3 minimum).
 * Uses repo-relative POSIX paths for stable cross-platform byte counts.
 */
export function formatCursorAgentSkill(relPath: string, description: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  return `<agent_skill fullPath="${normalized}">${description}</agent_skill>`;
}

export interface SkillFrontmatterEntry {
  readonly skillName: string;
  readonly relPath: string;
  readonly bytes: number;
}

export interface SkillFrontmatterMeasure {
  readonly bytes: number;
  readonly estimatedTokens: number;
  readonly skillCount: number;
  readonly tier: SkillFrontmatterTier;
  readonly harnessProfile: HarnessProfile;
  readonly entries: readonly SkillFrontmatterEntry[];
}

export interface MeasureSkillFrontmatterOptions {
  readonly skillsRoot?: string;
  readonly tier?: SkillFrontmatterTier;
  readonly harnessProfile?: HarnessProfile;
  readonly bytesPerToken?: number;
}

function defaultSkillsRoot(projectRoot: string): string {
  return join(projectRoot, "content", "skills");
}

function listSkillDirs(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) {
    return [];
  }
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function skillMatchesTier(skillName: string, tier: SkillFrontmatterTier): boolean {
  if (tier === "none") {
    return false;
  }
  if (tier === "all") {
    return true;
  }
  return DAILY_CORE_SET.has(skillName);
}

/** Measure harness-injected skill frontmatter bytes for the configured profile/tier. */
export function measureSkillFrontmatter(
  projectRoot: string,
  options: MeasureSkillFrontmatterOptions = {},
): SkillFrontmatterMeasure {
  const harnessProfile = options.harnessProfile ?? "cursor";
  const tier = options.tier ?? "all";
  const bytesPerToken = options.bytesPerToken ?? 4;
  const skillsRoot = options.skillsRoot ?? defaultSkillsRoot(projectRoot);

  if (harnessProfile === "none" || tier === "none") {
    return {
      bytes: 0,
      estimatedTokens: 0,
      skillCount: 0,
      tier,
      harnessProfile,
      entries: [],
    };
  }

  const entries: SkillFrontmatterEntry[] = [];
  for (const skillName of listSkillDirs(skillsRoot)) {
    if (!skillMatchesTier(skillName, tier)) {
      continue;
    }
    const skillPath = join(skillsRoot, skillName, "SKILL.md");
    if (!existsSync(skillPath)) {
      continue;
    }
    const text = readFileSync(skillPath, "utf8");
    const description = extractSkillDescription(text);
    const relPath = posix.join("content", "skills", skillName, "SKILL.md");
    const block = formatCursorAgentSkill(relPath, description);
    const bytes = Buffer.byteLength(block, "utf8");
    entries.push({ skillName, relPath, bytes });
  }

  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    bytes,
    estimatedTokens: Math.ceil(bytes / bytesPerToken),
    skillCount: entries.length,
    tier,
    harnessProfile,
    entries,
  };
}
