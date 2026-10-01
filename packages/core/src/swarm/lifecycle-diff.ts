/**
 * Causal lifecycle staged-diff gate (#4714 R7).
 * completeCohort may change selected child records plus derived parents/registry.
 */
import { basename } from "node:path";

export interface LifecycleDiffResult {
  readonly ok: boolean;
  readonly allowed: readonly string[];
  readonly unexpected: readonly string[];
  readonly error: string | null;
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Parse `git status --short` paths under xbrief/ (supports rename "R  a -> b"). */
export function parseStagedXbriefPaths(statusStdout: string): string[] {
  const out: string[] = [];
  for (const raw of statusStdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.length < 4) {
      continue;
    }
    const body = line.slice(3).trim();
    if (body.length === 0) {
      continue;
    }
    if (body.includes(" -> ")) {
      const parts = body.split(" -> ");
      for (const part of parts) {
        const rel = normalizeRel(part.trim().replace(/^"|"$/g, ""));
        if (rel.startsWith("xbrief/") || rel.startsWith("vbrief/")) {
          out.push(rel);
        }
      }
      continue;
    }
    const rel = normalizeRel(body.replace(/^"|"$/g, ""));
    if (rel.startsWith("xbrief/") || rel.startsWith("vbrief/")) {
      out.push(rel);
    }
  }
  return [...new Set(out)].sort();
}

export function expectedLifecycleRels(
  storyRels: readonly string[],
  derivedRels: readonly string[] = [],
): Set<string> {
  const allowed = new Set<string>();
  for (const rel of [...storyRels, ...derivedRels]) {
    const normalized = normalizeRel(rel);
    allowed.add(normalized);
    if (normalized.includes("/active/")) {
      allowed.add(normalized.replace("/active/", "/completed/"));
      allowed.add(normalized.replace("/active/", "/cancelled/"));
    }
    // Registry / specification companions sometimes rewrite beside the story.
    const base = basename(normalized);
    if (base === "plan.xbrief.json" || base === "specification.xbrief.json") {
      allowed.add(normalized);
    }
  }
  return allowed;
}

/**
 * Compare staged xbrief paths to the allowed transition set.
 * Unexpected paths fail closed before commit.
 */
export function evaluateLifecycleDiff(
  stagedPaths: readonly string[],
  allowed: ReadonlySet<string>,
): LifecycleDiffResult {
  const unexpected = stagedPaths
    .map(normalizeRel)
    .filter((rel) => !allowed.has(rel))
    .sort();
  if (unexpected.length > 0) {
    return {
      ok: false,
      allowed: [...allowed].sort(),
      unexpected,
      error:
        `causal lifecycle diff refused unrelated xBRIEF path(s): ${unexpected.join(", ")} ` +
        `(#4714 R7)`,
    };
  }
  return {
    ok: true,
    allowed: [...allowed].sort(),
    unexpected: [],
    error: null,
  };
}
