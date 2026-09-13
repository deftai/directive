/**
 * Pure write-target / shell-command extraction from host payloads (#2950).
 * No process I/O — does not resolve against projectRoot or realpath.
 */

import { firstString, record, toolInputRecord } from "./payload.js";

const PATHISH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_file",
  "targetFile",
  "target_path",
  "targetPath",
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

import { applyPatchMutationPaths } from "./stdin.js";

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
    nested?.file_path,
    nested?.path,
    nested?.target_file,
    input.file_path,
    input.filePath,
    input.path,
  ]);
}

/** Raw ApplyPatch body text from patch / unified_diff / diff fields. */
export function hookApplyPatchBodyText(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  return firstString([
    toolInput?.patch,
    toolInput?.unified_diff,
    toolInput?.diff,
    input.patch,
    input.unified_diff,
    input.diff,
  ]);
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
