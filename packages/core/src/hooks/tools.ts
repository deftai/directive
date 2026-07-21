/** Host spellings that install-time matchers and runtime classification share. */
export const DIRECT_WRITE_TOOL_NAMES = [
  "Edit",
  "Write",
  "WriteFile",
  "CreateFile",
  "MultiEdit",
  "NotebookEdit",
  "StrReplace",
  "SearchReplace",
  "Delete",
  "DeleteFile",
  "ApplyPatch",
  "apply_patch",
] as const;

/** PreToolUse spawn / sub-agent dispatch tools (#1185 / #2437). */
export const SPAWN_TOOL_NAMES = [
  "Task",
  "SubagentStart",
  "spawn_subagent",
  "start_agent",
  "CreateAgent",
] as const;

/** Env override forcing hook-level read-only write denial (#1185). */
export const READ_ONLY_HOOK_ENV = "DEFT_HOOK_READ_ONLY";

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const DIRECT_WRITE_TOOLS = new Set(DIRECT_WRITE_TOOL_NAMES.map(normalizedToolName));
const SPAWN_TOOLS = new Set(SPAWN_TOOL_NAMES.map(normalizedToolName));

export function isDirectWriteTool(toolName: string): boolean {
  return DIRECT_WRITE_TOOLS.has(normalizedToolName(toolName));
}

export function isSpawnTool(toolName: string): boolean {
  return SPAWN_TOOLS.has(normalizedToolName(toolName));
}

export const DIRECT_WRITE_HOOK_MATCHER = DIRECT_WRITE_TOOL_NAMES.join("|");
export const SPAWN_HOOK_MATCHER = SPAWN_TOOL_NAMES.join("|");
