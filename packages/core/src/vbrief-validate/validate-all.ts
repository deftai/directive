import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIFECYCLE_FOLDERS } from "./constants.js";
import { validateNoRootDecompositionDrafts } from "./decomposition.js";
import { validateEpicStoryLinks } from "./epic-links.js";
import { validateFilename } from "./filename.js";
import { validateFolderStatus } from "./folder-status.js";
import { validateOriginProvenance } from "./origin.js";
import { validateDeprecatedPlaceholders } from "./placeholders.js";
import { validateProjectDefinition } from "./project-definition.js";
import type { JsonObject } from "./schema.js";
import { validateVbriefSchema } from "./schema.js";
import { checkRenderStaleness } from "./staleness.js";

export interface ValidateAllResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly scopeCount: number;
}

/**
 * Convert backslashes to forward slashes and strip any trailing slashes
 * using a linear scan (no regex). Avoids the CodeQL ``js/polynomial-redos``
 * alert that ``/\/+$/`` triggers while staying byte-identical to Python's
 * normalization for display-path construction.
 */
function normalizeVbriefDir(vbriefDir: string): string {
  const forward = vbriefDir.split("\\").join("/");
  let end = forward.length;
  while (end > 0 && forward.charCodeAt(end - 1) === 47 /* "/" */) {
    end -= 1;
  }
  return forward.slice(0, end);
}

function toDisplayPath(vbriefDir: string, folder: string, name: string): string {
  return `${normalizeVbriefDir(vbriefDir)}/${folder}/${name}`;
}

/** Find all .vbrief.json files in lifecycle folders. */
export function discoverVbriefs(vbriefDir: string): Array<{ display: string; absolute: string }> {
  const files: Array<{ display: string; absolute: string }> = [];
  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    if (!existsSync(folderPath)) {
      continue;
    }
    const names = readdirSync(folderPath)
      .filter((name) => name.endsWith(".vbrief.json"))
      .sort();
    for (const name of names) {
      files.push({
        display: toDisplayPath(vbriefDir, folder, name),
        absolute: resolve(folderPath, name),
      });
    }
  }
  return files;
}

function loadVbrief(filepath: string): { data: JsonObject | null; error: string | null } {
  try {
    const raw = readFileSync(filepath, "utf8");
    return { data: JSON.parse(raw) as JsonObject, error: null };
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return { data: null, error: `${filepath}: invalid JSON: ${err.message}` };
    }
    return {
      data: null,
      error: `${filepath}: cannot read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Run all validators. Returns errors, warnings, and scope file count. */
export function validateAll(
  vbriefDir: string,
  options: { strictOriginTypes?: boolean } = {},
): ValidateAllResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allVbriefs = new Map<string, JsonObject>();
  const resolvedToOriginal = new Map<string, string>();
  const strictOriginTypes = options.strictOriginTypes ?? false;

  const scopeFiles = discoverVbriefs(vbriefDir);
  errors.push(...validateNoRootDecompositionDrafts(vbriefDir));

  for (const { display, absolute } of scopeFiles) {
    const { data, error } = loadVbrief(absolute);
    if (error !== null) {
      errors.push(error);
      continue;
    }
    if (data === null) {
      continue;
    }

    const resolved = resolve(absolute);
    allVbriefs.set(resolved, data);
    resolvedToOriginal.set(resolved, display);

    errors.push(...validateVbriefSchema(data, display));
    errors.push(...validateFilename(display));
    errors.push(...validateFolderStatus(display, data, vbriefDir));
    warnings.push(...validateOriginProvenance(display, data, vbriefDir, strictOriginTypes));
  }

  const normalizedDir = normalizeVbriefDir(vbriefDir);
  const projectDefDisplay = `${normalizedDir}/PROJECT-DEFINITION.vbrief.json`;
  const projectDefAbsolute = join(vbriefDir, "PROJECT-DEFINITION.vbrief.json");
  if (existsSync(projectDefAbsolute)) {
    const { data, error } = loadVbrief(projectDefAbsolute);
    if (error !== null) {
      errors.push(error);
    } else if (data !== null) {
      const resolvedPd = resolve(projectDefAbsolute);
      allVbriefs.set(resolvedPd, data);
      resolvedToOriginal.set(resolvedPd, projectDefDisplay);
      errors.push(...validateVbriefSchema(data, projectDefDisplay));
      errors.push(...validateProjectDefinition(projectDefDisplay, data, vbriefDir));
    }
  }

  if (allVbriefs.size > 0) {
    errors.push(...validateEpicStoryLinks(allVbriefs, vbriefDir, resolvedToOriginal));
  }

  warnings.push(...validateDeprecatedPlaceholders(vbriefDir));
  warnings.push(...checkRenderStaleness(vbriefDir));

  return { errors, warnings, scopeCount: scopeFiles.length };
}

/** Migration gate helper: returns ``[errors, warnings]`` tuple only. */
export function validateAllMigration(vbriefDir: string): readonly [string[], string[]] {
  const { errors, warnings } = validateAll(vbriefDir);
  return [[...errors], [...warnings]];
}
