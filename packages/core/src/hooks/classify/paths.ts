/**
 * Pure write-target / shell-command extraction from host payloads (#2950).
 * No process I/O — does not resolve against projectRoot or realpath.
 */

import { fileURLToPath } from "node:url";
import { firstString, record, toolInputRecord } from "./payload.js";
import { applyPatchBodyTextFromParsed, applyPatchMutationPaths } from "./stdin.js";

const PATHISH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_file",
  "targetFile",
  "target_path",
  "targetPath",
  // MCP dest spellings (#5366 Prefer-A).
  "uri",
  "file",
] as const;

/** Nested MCP/proxy arguments (#3593). Depth-capped; does not invent free-text paths. */
function collectPathishFields(value: unknown, into: string[], depth: number): void {
  if (depth > 4) return;
  const rec = record(value);
  if (rec === null) return;
  for (const key of PATHISH_KEYS) {
    const candidate = rec[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      into.push(candidate.trim());
    }
  }
  collectPathishFields(rec.arguments, into, depth + 1);
  collectPathishFields(rec.tool_input, into, depth + 1);
  collectPathishFields(rec.toolInput, into, depth + 1);
  collectPathishFields(rec.input, into, depth + 1);
  collectPathishFields(rec.params, into, depth + 1);
}

/**
 * Best-effort write-target path from host PreToolUse payloads (#2625).
 * Hosts disagree on nesting (`tool_input.file_path` vs top-level `path`).
 */
export function hookWriteTargetPath(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  const nested =
    toolInput !== null
      ? (record(toolInput.arguments) ?? record(toolInput.tool_input) ?? record(toolInput.params))
      : null;
  return firstString([
    toolInput?.file_path,
    toolInput?.filePath,
    toolInput?.path,
    toolInput?.target_file,
    toolInput?.uri,
    toolInput?.file,
    nested?.file_path,
    nested?.path,
    nested?.target_file,
    nested?.uri,
    nested?.file,
    input.file_path,
    input.filePath,
    input.path,
    input.uri,
    input.file,
  ]);
}

/**
 * Resolve a harvested dest string for fence/admission (#5366 Prefer-A).
 * Ordinary paths and Windows drive letters pass through. Local `file:` URIs
 * decode via fileURLToPath. Other schemes (https:/mcp:/…) refuse — nonempty
 * harvest is not complete classification.
 */
export function resolveMutationTargetPath(
  raw: string,
): { status: "path"; path: string } | { status: "refuse"; detail: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { status: "refuse", detail: "empty mutation target" };
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  const schemeRaw = schemeMatch?.[1];
  if (schemeRaw === undefined) {
    return { status: "path", path: trimmed };
  }
  const scheme = schemeRaw.toLowerCase();
  // Single-letter schemes are Windows drive paths (C:\… / C:/…), not URIs.
  if (scheme.length === 1) {
    return { status: "path", path: trimmed };
  }
  if (scheme !== "file") {
    return { status: "refuse", detail: `unsupported URI scheme: ${scheme}` };
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "file:") {
      return { status: "refuse", detail: "malformed file URI" };
    }
    return { status: "path", path: fileURLToPath(url) };
  } catch {
    return { status: "refuse", detail: "malformed file URI" };
  }
}

/**
 * Decode/validate harvested dests. One refused target fails the whole set
 * so a valid sibling cannot conceal an unresolved destination (#5366).
 */
export function normalizeMutationTargetPaths(
  rawTargets: readonly string[],
): { ok: true; paths: string[] } | { ok: false; detail: string } {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTargets) {
    const resolved = resolveMutationTargetPath(raw);
    if (resolved.status === "refuse") {
      return { ok: false, detail: resolved.detail };
    }
    if (seen.has(resolved.path)) continue;
    seen.add(resolved.path);
    paths.push(resolved.path);
  }
  return { ok: true, paths };
}

/**
 * Raw ApplyPatch body text. Legacy fields (`patch` / `unified_diff` / `diff`)
 * plus string `command` when the payload declares an ApplyPatch tool
 * (`isApplyPatchTool`, including `apply-patch`). Conflicting fields union;
 * `command` is not on the host-agnostic firstString list (#5094).
 */
export function hookApplyPatchBodyText(payload: unknown): string | null {
  return applyPatchBodyTextFromParsed(payload);
}

/** ApplyPatch body paths from patch / unified_diff / diff fields. */
export function hookApplyPatchBodyPaths(payload: unknown): string[] {
  const patch = hookApplyPatchBodyText(payload);
  return patch === null ? [] : applyPatchMutationPaths(patch);
}

/**
 * Declared write target plus ApplyPatch body members. Used to admit one
 * effectiveRoot; a span across two Git toplevels is refused (#3794).
 */
export function hookMutationTargetPaths(payload: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string | null): void => {
    if (value === null || value.length === 0 || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  const collected: string[] = [];
  collectPathishFields(payload, collected, 0);
  for (const path of collected) push(path);
  push(hookWriteTargetPath(payload));
  for (const path of hookApplyPatchBodyPaths(payload)) push(path);
  return out;
}

/**
 * Best-effort shell command string from host PreToolUse payloads (#2711).
 * Hosts disagree on nesting (`tool_input.command` vs top-level `command`).
 */
export function hookShellCommand(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  return firstString([
    toolInput !== null ? toolInput.command : null,
    toolInput !== null ? toolInput.cmd : null,
    toolInput !== null ? toolInput.shell_command : null,
    input.command,
    input.cmd,
  ]);
}

/** Serialize tool args for MCP classification when nested objects are present (#2711). */
export function hookMcpArgsText(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  if (toolInput === null) return null;
  try {
    return JSON.stringify(toolInput);
  } catch {
    return null;
  }
}

/**
 * Collect distinct path-like strings from a payload for fixture assertions.
 * Write target first when present; does not invent paths from free text.
 */
export function hookPathSet(payload: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string | null): void => {
    if (value === null || value.length === 0 || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  push(hookWriteTargetPath(payload));
  return out;
}
