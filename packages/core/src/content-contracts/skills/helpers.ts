import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo root — five levels up from packages/core/src/content-contracts/skills */
export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
// skills -> content-contracts -> src -> core -> packages -> repo root (5 levels)

export function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

/**
 * Resolve a repo-root-relative content path across both contexts (#1875 C1).
 * The content/ move relocated shippable content under content/ in the SOURCE
 * repo; the C1 flatten strips that prefix in a CONSUMER deposit. Probe content/
 * first (SOURCE layout), then fall back to the repo root so root-resident
 * harness entries (AGENTS.md) and the flattened consumer layout still resolve.
 */
export function resolveContentPathFromRoot(projectRoot: string, relPath: string): string {
  const underContent = join(projectRoot, "content", relPath);
  if (existsSync(underContent)) {
    return underContent;
  }
  return join(projectRoot, relPath);
}

export function resolveRepoPath(relPath: string): string {
  return resolveContentPathFromRoot(REPO_ROOT, relPath);
}

export function readRepoFile(relPath: string): string {
  return readFileSync(resolveRepoPath(relPath), "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function repoFileExists(relPath: string): boolean {
  return existsSync(resolveRepoPath(relPath));
}

export function readSkill(relPath: string): string {
  return readRepoFile(relPath);
}

/**
 * Progressive-disclosure surface for deft-directive-swarm (#2928).
 * Thin SKILL.md is the dispatch card; operative depth lives under references/.
 * Content contracts assert against this ordered join so host adapters can leave
 * the always-loaded SKILL without dropping coverage.
 */
export const SWARM_SKILL_REL = "skills/deft-directive-swarm/SKILL.md";

/** Stable load order: core phases, then host launch adapters, then ops. */
export const SWARM_REFERENCE_ORDER = [
  "core-phase-0.md",
  "core-phase-1-2.md",
  "core-phase-3.md",
  "host-warp.md",
  "host-generic.md",
  "host-grok-build.md",
  "host-cursor.md",
  "host-claude-code.md",
  "host-openclaw.md",
  "host-grokbot.md",
  "core-phase-4.md",
  "core-phase-5-6.md",
  "core-ops.md",
] as const;

export function readSwarmSkillSurface(): string {
  const parts: string[] = [readRepoFile(SWARM_SKILL_REL)];
  for (const name of SWARM_REFERENCE_ORDER) {
    const rel = `skills/deft-directive-swarm/references/${name}`;
    // Fail-loud: SWARM_REFERENCE_ORDER is the complete shipped surface (#2928).
    // Silently skipping a missing reference lets incomplete packs pass contracts
    // that never assert markers unique to the omitted file (Greptile on #2936).
    if (!repoFileExists(rel)) {
      throw new Error(`readSwarmSkillSurface: missing declared reference ${rel}`);
    }
    parts.push(readRepoFile(rel));
  }
  return parts.join("\n\n");
}

/**
 * Product SoT for managed AGENTS content (`templates/agents-entry.md`).
 * Root AGENTS.md is a deposit/sterile artifact — contracts must not read it
 * for product teaching (#5490 wave4i).
 */
export function readAgentsMd(): string {
  return readRepoFile("templates/agents-entry.md");
}

/** Orchestrator preamble SoT (`templates/agent-prompt-preamble.md`). */
export function readAgentsPreamble(): string {
  return readRepoFile("templates/agent-prompt-preamble.md");
}

/**
 * Session-routing body (successor of retired `## Returning Sessions`).
 * Tip agents-entry collapses returning-session rules into this section.
 */
export function returningSessionsSection(): string {
  const text = readAgentsMd();
  const heading = "## Session routing (#2176)";
  const start = text.indexOf(heading);
  if (start === -1) {
    throw new Error(
      "templates/agents-entry.md: missing '## Session routing (#2176)' (Returning Sessions successor)",
    );
  }
  const rest = text.slice(start + heading.length);
  const nextHeading = rest.indexOf("\n## ");
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function skillsDirFromRoot(projectRoot: string): string | null {
  const resolved = resolveContentPathFromRoot(projectRoot, "skills");
  return existsSync(resolved) ? resolved : null;
}

export function listSkillMdFilesFromRoot(projectRoot: string): string[] {
  const skillsDir = skillsDirFromRoot(projectRoot);
  if (skillsDir === null) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillMd = join(skillsDir, entry.name, "SKILL.md");
      if (existsSync(skillMd)) {
        results.push(join("skills", entry.name, "SKILL.md"));
      }
    }
  }
  return results.sort();
}

export function listSkillMdFiles(): string[] {
  const skillsDir = resolveRepoPath("skills");
  const results: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillMd = join(skillsDir, entry.name, "SKILL.md");
      if (existsSync(skillMd)) {
        results.push(join("skills", entry.name, "SKILL.md"));
      }
    }
  }
  return results.sort();
}

export function listSkillMdEntriesFromRoot(
  projectRoot: string,
): ReadonlyArray<{ path: string; text: string }> {
  const skillsDir = skillsDirFromRoot(projectRoot);
  if (skillsDir === null) {
    return [];
  }
  const entries: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillMd = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) {
      continue;
    }
    entries.push({
      path: join("skills", entry.name, "SKILL.md"),
      text: readFileSync(skillMd, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export const RFC2119_LEGEND = "!=MUST, ~=SHOULD";
export const PLATFORM_DETECTION_HEADING = "## Platform Detection";
export const USER_MD_GATE_HEADING = "## USER.md Gate";

export const REQUIRED_OSES = new Set(["darwin", "linux", "windows"]);
