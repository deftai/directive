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

/**
 * Host spellings for Shell/Bash execution tools (#2711).
 * Used for runtimeAuthority scopes.push / scopes.merge classification.
 */
export const SHELL_TOOL_NAMES = ["Shell", "Bash", "BashTool", "shell", "bash"] as const;

/** Env override forcing hook-level read-only write denial (#1185). */
export const READ_ONLY_HOOK_ENV = "DEFT_HOOK_READ_ONLY";

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const DIRECT_WRITE_TOOLS = new Set(DIRECT_WRITE_TOOL_NAMES.map(normalizedToolName));
const SPAWN_TOOLS = new Set(SPAWN_TOOL_NAMES.map(normalizedToolName));
const SHELL_TOOLS = new Set(SHELL_TOOL_NAMES.map(normalizedToolName));

export function isDirectWriteTool(toolName: string): boolean {
  return DIRECT_WRITE_TOOLS.has(normalizedToolName(toolName));
}

export function isSpawnTool(toolName: string): boolean {
  return SPAWN_TOOLS.has(normalizedToolName(toolName));
}

/** True for host Shell/Bash-class tools that carry a command string (#2711). */
export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(normalizedToolName(toolName));
}

/**
 * Best-effort MCP tool detection for runtimeAuthority push/merge scopes (#2711).
 * Host spellings vary (`mcp__*`, `server__tool`, bare MCP-looking names).
 * Unclassifiable MCP tools fail open at the operation classifier.
 */
export function isMcpTool(toolName: string): boolean {
  const raw = toolName.trim();
  if (raw.length === 0) return false;
  const lower = raw.toLowerCase();
  if (lower.startsWith("mcp__") || lower.startsWith("mcp_")) return true;
  if (lower.includes("__") && !isDirectWriteTool(toolName) && !isShellTool(toolName)) {
    // server__tool style used by some MCP bridges
    return true;
  }
  return false;
}

export const DIRECT_WRITE_HOOK_MATCHER = DIRECT_WRITE_TOOL_NAMES.join("|");
export const SPAWN_HOOK_MATCHER = SPAWN_TOOL_NAMES.join("|");
export const SHELL_HOOK_MATCHER = SHELL_TOOL_NAMES.join("|");
