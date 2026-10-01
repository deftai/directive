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

const LIFECYCLE_FOLDERS = new Set([
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
  "draft",
]);

/** True for bare `xbrief/completed/` dir markers from `git status --short` (#4714). */
function isLifecycleDirectoryMarker(rel: string): boolean {
  const normalized = normalizeRel(rel).replace(/\/+$/, "");
  const parts = normalized.split("/");
  if (parts.length !== 2) {
    return false;
  }
  return (parts[0] === "xbrief" || parts[0] === "vbrief") && LIFECYCLE_FOLDERS.has(parts[1] ?? "");
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
        if (
          (rel.startsWith("xbrief/") || rel.startsWith("vbrief/")) &&
          !isLifecycleDirectoryMarker(rel)
        ) {
          out.push(rel);
        }
      }
      continue;
    }
    const rel = normalizeRel(body.replace(/^"|"$/g, ""));
    if (
      (rel.startsWith("xbrief/") || rel.startsWith("vbrief/")) &&
      !isLifecycleDirectoryMarker(rel)
    ) {
      out.push(rel);
    }
  }
  return [...new Set(out)].sort();
}

/** Registry companions completeCohort may rewrite beside selected stories (#4714 R7). */
export const LIFECYCLE_REGISTRY_RELS: readonly string[] = [
  "xbrief/PROJECT-DEFINITION.xbrief.json",
  "xbrief/specification.xbrief.json",
  "xbrief/plan.xbrief.json",
  "vbrief/PROJECT-DEFINITION.xbrief.json",
  "vbrief/specification.xbrief.json",
  "vbrief/plan.xbrief.json",
];

export function expectedLifecycleRels(
  storyRels: readonly string[],
  derivedRels: readonly string[] = [],
): Set<string> {
  const allowed = new Set<string>();
  for (const rel of [...storyRels, ...derivedRels, ...LIFECYCLE_REGISTRY_RELS]) {
    const normalized = normalizeRel(rel);
    allowed.add(normalized);
    if (normalized.includes("/active/")) {
      allowed.add(normalized.replace("/active/", "/completed/"));
      allowed.add(normalized.replace("/active/", "/cancelled/"));
    }
    if (normalized.includes("/pending/")) {
      allowed.add(normalized.replace("/pending/", "/active/"));
      allowed.add(normalized.replace("/pending/", "/completed/"));
      allowed.add(normalized.replace("/pending/", "/cancelled/"));
    }
    // Registry / specification companions sometimes rewrite beside the story.
    const base = basename(normalized);
    if (
      base === "plan.xbrief.json" ||
      base === "specification.xbrief.json" ||
      base === "PROJECT-DEFINITION.xbrief.json"
    ) {
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
