/**
 * Scope queue scan for directive:finish-loop (#871).
 * Lists xbrief/active + xbrief/pending (and legacy vbrief/) story files.
 * Implementation work is agent-owned; this is the gate's empty-queue detector.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LIFECYCLE_DIRS = [
  ["xbrief", "active"],
  ["xbrief", "pending"],
  ["vbrief", "active"],
  ["vbrief", "pending"],
] as const;

export interface QueueEntry {
  readonly path: string;
  readonly lifecycle: "active" | "pending";
  readonly name: string;
}

function isStoryFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".xbrief.json") ||
    lower.endsWith(".vbrief.json") ||
    (lower.endsWith(".json") && (lower.includes("xbrief") || lower.includes("vbrief")))
  );
}

/**
 * Scan project root for in-flight / pending story xBRIEFs.
 * Does not invent work — empty means the outer loop may halt cleanly.
 */
export function scanFinishLoopQueue(projectRoot: string): QueueEntry[] {
  const out: QueueEntry[] = [];
  const seen = new Set<string>();

  for (const [rootName, lifecycle] of LIFECYCLE_DIRS) {
    const dir = join(projectRoot, rootName, lifecycle);
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!isStoryFile(name)) continue;
      // Skip PROJECT-DEFINITION and similar non-story files in wrong folders
      if (name.toUpperCase().includes("PROJECT-DEFINITION")) continue;
      const full = join(dir, name);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      const key = full.replace(/\\/g, "/").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: full,
        lifecycle: lifecycle as "active" | "pending",
        name,
      });
    }
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}
