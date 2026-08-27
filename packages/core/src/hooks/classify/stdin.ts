/**
 * Pure stdin → payload parse for hook-dispatch (#2734 / #2738 / #2950).
 * No process I/O — operates on an already-read string.
 */

import type { ParsedHookPayload } from "./types.js";

const UTF8_BOM = "\uFEFF";
const APPLY_PATCH_BEGIN_MARKER = "*** Begin Patch";
/** Single-file Add/Update only — other *** … File: ops must fail closed (#2738 Greptile). */
const APPLY_PATCH_MUTATION_LINE_RE =
  /^\*\*\* (Add File|Update File|Delete File|Move File|Rename File): (.+)$/gm;
/**
 * Canonical apply_patch spells a rename as `*** Update File:` followed by
 * `*** Move to:`. The destination is a mutation target in its own right, so it
 * must reach root admission; kept separate from the header regex above so the
 * single-mutation #2738 synthesis contract is unchanged (#3794).
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
    return { payload: JSON.parse(normalized) as unknown, context: {} };
  } catch {
    const synthesized = trySynthesizeFreeFormApplyPatch(normalized);
    if (synthesized !== null) return synthesized;
    // tool.before is installed only on direct-write matchers, so an unreadable
    // payload becomes a missing-tool denial rather than a fail-open crash.
    return { payload: {}, context: { parseFailed: true } };
  }
}
