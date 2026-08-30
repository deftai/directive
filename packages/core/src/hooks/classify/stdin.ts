/**
 * Pure stdin → payload parse for hook-dispatch (#2734 / #2738 / #2950).
 * No process I/O — operates on an already-read string.
 */

import { firstString, record, toolInputRecord } from "./payload.js";
import type { ParsedHookPayload } from "./types.js";

const UTF8_BOM = "\uFEFF";
const APPLY_PATCH_BEGIN_MARKER = "*** Begin Patch";
/** Single-file Add/Update only — other *** … File: ops must fail closed (#2738 Greptile). */
const APPLY_PATCH_MUTATION_LINE_RE =
  /^\*\*\* (Add File|Update File|Delete File|Move File|Rename File): (.+)$/gm;
/**
 * Canonical apply_patch spells a rename as `*** Update File:` followed by
 * `*** Move to:`. The destination is a mutation target in its own right, so it
 * must reach root admission. Synthesis refuses when applyPatchMutationPaths
 * reports more than one unique path, so a Move-to destination is not dropped
 * from the single-target contract (#3614 / #3794).
 */
const APPLY_PATCH_MOVE_DESTINATION_RE = /^\*\*\* Move to: (.+)$/gm;

export function stripUtf8Bom(raw: string): string {
  return raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
}

/**
 * Paths named by ApplyPatch mutation headers, plus `*** Move to:` rename
 * destinations. Order preserved, duplicates dropped.
 */
export function applyPatchMutationPaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    const path = raw?.trim();
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  for (const match of text.matchAll(APPLY_PATCH_MUTATION_LINE_RE)) push(match[2]);
  for (const match of text.matchAll(APPLY_PATCH_MOVE_DESTINATION_RE)) push(match[1]);
  return paths;
}

function trySynthesizeFreeFormApplyPatch(normalized: string): ParsedHookPayload | null {
  if (!normalized.includes(APPLY_PATCH_BEGIN_MARKER)) return null;
  const mutations: { op: string; path: string }[] = [];
  for (const match of normalized.matchAll(APPLY_PATCH_MUTATION_LINE_RE)) {
    const op = match[1];
    const path = match[2]?.trim();
    if (op === undefined || !path) continue;
    mutations.push({ op, path });
  }
  if (mutations.length !== 1) return null;
  // Count headers plus Move-to destinations so a rename cannot collapse to one
  // checked path (#3614 / #3794). Reuses applyPatchMutationPaths; no second parser.
  if (applyPatchMutationPaths(normalized).length !== 1) return null;
  const sole = mutations[0];
  if (sole === undefined || (sole.op !== "Add File" && sole.op !== "Update File")) return null;
  return {
    payload: {
      tool_name: "ApplyPatch",
      tool_input: {
        path: sole.path,
        patch: normalized,
      },
    },
    context: {},
  };
}

function declaredWritePathFromParsed(payload: unknown): string | null {
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

function applyPatchBodyTextFromParsed(payload: unknown): string | null {
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

function withToolInputPath(parsed: unknown, path: string): unknown {
  const input = record(parsed);
  if (input === null) return parsed;
  for (const key of ["tool_input", "toolInput", "input", "arguments"] as const) {
    const nested = record(input[key]);
    if (nested !== null) {
      return { ...input, [key]: { ...nested, path } };
    }
  }
  return { ...input, tool_input: { path } };
}

/**
 * Valid-JSON hosts (Codex) never hit the JSON.parse catch arm, so the free-form
 * extractor was unreached. Call it on the patch body when no path was declared.
 * Does not replace the parsed payload; only fills tool_input.path.
 */
function attachSynthesizedApplyPatchPath(parsed: unknown): unknown {
  if (declaredWritePathFromParsed(parsed) !== null) return parsed;
  const patch = applyPatchBodyTextFromParsed(parsed);
  if (patch === null) return parsed;
  const synthesized = trySynthesizeFreeFormApplyPatch(patch);
  if (synthesized === null) return parsed;
  const synthesizedPath = declaredWritePathFromParsed(synthesized.payload);
  if (synthesizedPath === null) return parsed;
  return withToolInputPath(parsed, synthesizedPath);
}

/**
 * Parse host hook stdin text into a payload + parse context.
 * Empty → stdinEmpty; invalid JSON without free-form ApplyPatch → parseFailed.
 */
export function parseHookStdin(raw: string): ParsedHookPayload {
  if (raw.trim().length === 0) {
    return { payload: {}, context: { stdinEmpty: true } };
  }
  const normalized = stripUtf8Bom(raw);
  if (normalized.trim().length === 0) {
    return { payload: {}, context: { stdinEmpty: true } };
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    return { payload: attachSynthesizedApplyPatchPath(parsed), context: {} };
  } catch {
    const synthesized = trySynthesizeFreeFormApplyPatch(normalized);
    if (synthesized !== null) return synthesized;
    // tool.before is installed only on direct-write matchers, so an unreadable
    // payload becomes a missing-tool denial rather than a fail-open crash.
    return { payload: {}, context: { parseFailed: true } };
  }
}
