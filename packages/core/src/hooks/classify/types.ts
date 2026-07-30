/**
 * Pure hook classification types (#2950 Phase A).
 * No process I/O — payload/shape only.
 */

/** Host ids that PreToolUse / SessionStart dispatch understands. */
export const CLASSIFY_HOOK_HOSTS = ["claude", "grok", "cursor", "codex"] as const;
export type ClassifyHookHost = (typeof CLASSIFY_HOOK_HOSTS)[number];

/**
 * Write / mutation intent derived from tool identity alone (before policy gates).
 * Decision codes (allow/deny) live in the dispatcher; this layer only classifies.
 */
export type HookWriteIntent = "direct-write" | "spawn" | "shell" | "mcp" | "other" | "unknown";

/** Stdin parse metadata from hook-dispatch; absent when callers supply payload directly. */
export interface HookPayloadContext {
  readonly stdinEmpty?: boolean;
  readonly parseFailed?: boolean;
}

export interface ParsedHookPayload {
  readonly payload: unknown;
  readonly context: HookPayloadContext;
}

/**
 * Pure classification of a host PreToolUse (or equivalent) payload.
 * Paths are extracted as raw host strings — project-relative normalization is
 * dispatcher-owned (needs projectRoot + optional realpath).
 */
export interface HookClassification {
  readonly toolName: string | null;
  readonly writeIntent: HookWriteIntent;
  readonly writeTargetPath: string | null;
  readonly shellCommand: string | null;
  readonly topLevelKeys: readonly string[];
  /** Distinct path-like strings found on the payload (write target first when present). */
  readonly paths: readonly string[];
}

export interface ClassifyHookPayloadInput {
  readonly payload: unknown;
  /** Host id; Cursor enables tool-name inference when `tool_name` is omitted. */
  readonly host?: ClassifyHookHost | string;
}
