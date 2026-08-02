import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWriteText } from "../cache/io.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { pythonJsonPretty } from "../vbrief-build/json.js";
import type { JsonObject } from "../vbrief-build/types.js";
import { validateFolderStatus } from "../vbrief-validate/folder-status.js";
import { validateVbriefSchema } from "../vbrief-validate/schema.js";

export class BriefIOError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefIOError";
  }
}

/** Canonical brief serialization (single source of truth with vbrief-build). */
export function formatBriefJson(data: unknown): string {
  return pythonJsonPretty(data);
}

export type ReadBriefResult =
  | { readonly ok: true; readonly data: JsonObject }
  | { readonly ok: false; readonly message: string };

/** Read a scope brief for in-memory mutation (parse only; no validation gate on read). */
export function readBriefForMutation(filePath: string): ReadBriefResult {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return { ok: false, message: `File not found: ${resolvedPath}` };
  }
  const basename = resolvedPath.split(/[/\\]/).pop() ?? "";
  if (!hasArtifactSuffix(basename)) {
    return {
      ok: false,
      message: `Not a vBRIEF file (expected .vbrief.json or .xbrief.json): ${basename}`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Could not read ${resolvedPath}: ${msg}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    return { ok: false, message: `Invalid JSON in ${resolvedPath}: ${String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: `Top-level value in ${resolvedPath} is not a JSON object` };
  }
  return { ok: true, data: parsed as JsonObject };
}

/** Fail-closed schema + folder/status validation before persist. */
export function validateBriefForPersist(
  filePath: string,
  data: JsonObject,
  vbriefRoot: string,
): string | null {
  const errors = [
    ...validateVbriefSchema(data, filePath),
    ...validateFolderStatus(filePath, data, vbriefRoot),
  ];
  if (errors.length === 0) {
    return null;
  }
  return errors.join("; ");
}

export type AtomicWriteBriefResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Validate then atomically persist a brief (temp file + rename). */
export function atomicWriteBrief(
  filePath: string,
  data: JsonObject,
  vbriefRoot: string,
  options: { readonly projectRoot?: string } = {},
): AtomicWriteBriefResult {
  const validationError = validateBriefForPersist(filePath, data, vbriefRoot);
  if (validationError !== null) {
    return { ok: false, message: validationError };
  }
  // #3042: contain against projectRoot (parent of xbrief/), not dirname(filePath).
  const projectRoot = options.projectRoot ?? dirname(resolve(vbriefRoot));
  try {
    atomicWriteText(filePath, formatBriefJson(data), { projectRoot });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Failed to write ${filePath}: ${msg}` };
  }
}
