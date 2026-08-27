/**
 * Pure write-target / shell-command extraction from host payloads (#2950).
 * No process I/O — does not resolve against projectRoot or realpath.
 */

import { firstString, record, toolInputRecord } from "./payload.js";
import { applyPatchMutationPaths } from "./stdin.js";

/**
 * Best-effort write-target path from host PreToolUse payloads (#2625).
 * Hosts disagree on nesting (`tool_input.file_path` vs top-level `path`).
 */
export function hookWriteTargetPath(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  return firstString([
    toolInput?.file_path,
    toolInput?.filePath,
    toolInput?.path,
    input.file_path,
    input.filePath,
    input.path,
  ]);
}

/** ApplyPatch body paths from patch / unified_diff / diff fields. */
export function hookApplyPatchBodyPaths(payload: unknown): string[] {
  const input = record(payload);
  if (input === null) return [];
  const toolInput = toolInputRecord(input);
  const patch = firstString([
    toolInput?.patch,
    toolInput?.unified_diff,
    toolInput?.diff,
    input.patch,
    input.unified_diff,
    input.diff,
  ]);
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
