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
export function resolveRepoPath(relPath: string): string {
  const underContent = join(REPO_ROOT, "content", relPath);
  if (existsSync(underContent)) {
    return underContent;
  }
  return repoPath(relPath);
}

export function readRepoFile(relPath: string): string {
  return readFileSync(resolveRepoPath(relPath), "utf8");
}

export function repoFileExists(relPath: string): boolean {
  return existsSync(resolveRepoPath(relPath));
}

export function readSkill(relPath: string): string {
  return readRepoFile(relPath);
}

export function readAgentsMd(): string {
  return readRepoFile("AGENTS.md");
}

/** Slice the first `## Returning Sessions` section body out of AGENTS.md. */
export function returningSessionsSection(): string {
  const text = readAgentsMd();
  const start = text.indexOf("## Returning Sessions");
  if (start === -1) {
    throw new Error("AGENTS.md: missing '## Returning Sessions' section (#696)");
  }
  const rest = text.slice(start + "## Returning Sessions".length);
  const nextHeading = rest.indexOf("\n## ");
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
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

export const RFC2119_LEGEND = "!=MUST, ~=SHOULD";
export const PLATFORM_DETECTION_HEADING = "## Platform Detection";
export const USER_MD_GATE_HEADING = "## USER.md Gate";

export const DEPRECATED_SKILL_REDIRECT_STUBS = new Set([
  "deft-build",
  "deft-interview",
  "deft-pre-pr",
  "deft-review-cycle",
  "deft-roadmap-refresh",
  "deft-setup",
  "deft-swarm",
  "deft-sync",
]);

export const REQUIRED_OSES = new Set(["darwin", "linux", "windows"]);
