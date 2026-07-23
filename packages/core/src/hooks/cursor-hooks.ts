import { DIRECT_WRITE_HOOK_MATCHER } from "./tools.js";

/** Cursor's ApplyPatch payload is parsed directly by the shared hook executable. */
export const APPLY_PATCH_TOOL_NAMES = ["ApplyPatch", "apply_patch"] as const;
export const APPLY_PATCH_HOOK_MATCHER = APPLY_PATCH_TOOL_NAMES.join("|");

/**
 * Cursor uses one disjoint direct-write registration: hook-dispatch recognizes
 * JSON and free-form ApplyPatch payloads, avoiding an adapter process (#2790).
 */
export const CURSOR_DIRECT_WRITE_HOOK_MATCHER = DIRECT_WRITE_HOOK_MATCHER;
