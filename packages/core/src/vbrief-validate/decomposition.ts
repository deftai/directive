import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonObject } from "./schema.js";

function looksLikeDecompositionDraft(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const obj = data as JsonObject;
  const stories = obj.stories ?? obj.children;
  return Array.isArray(stories) || (typeof stories === "object" && stories !== null);
}

/** Reject decomposition draft proposals left at the workspace root. */
export function validateNoRootDecompositionDrafts(vbriefDir: string): string[] {
  const projectRoot = resolve(vbriefDir, "..");
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(projectRoot).filter((name) => name.endsWith(".json"));
  } catch {
    return errors;
  }
  for (const name of [...entries].sort()) {
    const path = join(projectRoot, name);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (looksLikeDecompositionDraft(data)) {
      errors.push(
        `${path}: decomposition draft JSON must not live at workspace root; ` +
          "write temporary proposals under vbrief/.eval/decompositions/",
      );
    }
  }
  return errors;
}
