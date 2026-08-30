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
  "write",
  "search_replace",
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
export const SHELL_TOOL_NAMES = [
  "Shell",
  "Bash",
  "BashTool",
  "shell",
  "bash",
  "run_terminal_command",
] as const;

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
 *
 * Bare push/merge names (e.g. `merge_pull_request`) are NOT detected here —
 * they are classified by `classifyMcpTool` and routed from `decideHook` so
 * tools.ts stays free of policy imports (#2711 Greptile conf holdout).
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

/**
 * Bare tool names that hosts may emit without mcp__/server__ prefixes and that
 * `classifyMcpTool` treats as push or merge (#2711).
 * Keep in sync with classifyMcpTool name patterns (narrow list for PreToolUse matchers).
 */
export const MCP_PUSH_MERGE_BARE_NAMES = [
  "merge_pull_request",
  "merge-pull-request",
  "pull_request_merge",
  "pull-request-merge",
  "merge_pr",
  "pr_merge",
  "pr-merge",
  "git_push",
  "git-push",
  "push_branch",
  "push-branch",
] as const;

export const DIRECT_WRITE_HOOK_MATCHER = DIRECT_WRITE_TOOL_NAMES.join("|");
export const SPAWN_HOOK_MATCHER = SPAWN_TOOL_NAMES.join("|");
export const SHELL_HOOK_MATCHER = SHELL_TOOL_NAMES.join("|");

/** Known mutation tool names per host. Deposited matchers must cover each name (#3987). */
export const GROK_MUTATION_TOOL_CATALOG = {
  directWrite: ["write", "search_replace"] as const,
  shell: ["run_terminal_command"] as const,
  spawn: ["spawn_subagent"] as const,
} as const;

/** Tools on this host that are intentionally not mutation-gated. */
export const GROK_NON_MUTATION_TOOLS = {
  read_file: "read",
  grep: "read",
  list_dir: "read",
  todo_write: "session-local non-product scratch",
  get_command_or_subagent_output: "poll, not a mutation; elapsed bound is evaluateInFlight",
  kill_command_or_subagent: "process control",
  search_tool: "read",
  web_search: "read",
} as const;

export function matcherHasLiteralToken(matcher: string, toolName: string): boolean {
  return matcher.split("|").includes(toolName);
}

/**
 * PreToolUse matcher for MCP-class push/merge tools (#2711).
 * Regex-friendly for Claude/nested hosts. Prefer broad install match +
 * fail-open classify in the dispatcher over missing a classifiable push/merge
 * tool name (e.g. `server__push_to_remote` via push+remote).
 */
export const MCP_HOOK_MATCHER = [
  // Prefixed / server-bridge styles (isMcpTool); dispatcher fail-opens non-ops.
  "mcp__.*",
  "mcp_.*",
  ".*__.*",
  // Bare names classifyMcpTool recognizes without prefixes.
  ...MCP_PUSH_MERGE_BARE_NAMES,
  // Name fragments for hosts that strip server prefixes differently.
  ".*merge[_-]?pull[_-]?request.*",
  ".*pull[_-]?request[_-]?merge.*",
  ".*(?:^|[_-])merge_pr(?:$|[_-]).*",
  ".*pr[_-]?merge.*",
  ".*git[_-]?push.*",
  ".*push[_-]?branch.*",
  ".*push.*(?:git|branch|remote|ref).*",
  ".*(?:git|branch|remote|ref).*push.*",
].join("|");
