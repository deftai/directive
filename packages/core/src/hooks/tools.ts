import type { ClassifyHookHost } from "./classify/types.js";

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
 *
 * `monitor` is Grok Build's second shell surface (#3987 audit): it executes an
 * arbitrary shell command in the background, so leaving it out reproduces the
 * `run_terminal_command` gap one tool over.
 */
export const SHELL_TOOL_NAMES = [
  "Shell",
  "Bash",
  "BashTool",
  "shell",
  "bash",
  "run_terminal_command",
  "monitor",
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

/** Mutation tool names a host emits, grouped by the matcher that must carry them. */
export interface HostMutationToolCatalog {
  readonly directWrite: readonly string[];
  readonly shell: readonly string[];
  readonly spawn: readonly string[];
}

/**
 * One host's audited tool surface (#3987 acceptance item 2).
 *
 * The audit answers one question per tool name the host emits: is it in
 * `mutation` (and therefore required to be a literal token of the deposited
 * matcher AND recognized by the runtime classifier), or is it in `nonMutation`
 * with the written reason it stays outside the gate? A name in neither is the
 * silent gap this record exists to make loud.
 *
 * `unobservedReason` is the honest third state. The deposit asserting a
 * spelling is not evidence that the host emits it, so a host whose PreToolUse
 * payloads have not been observed says so rather than publishing a guess as
 * coverage.
 */
export interface HostToolSurfaceAudit {
  readonly mutation: HostMutationToolCatalog;
  readonly nonMutation: Readonly<Record<string, string>>;
  /** Null when the audit covers every name the host emits. */
  readonly unobservedReason: string | null;
  /** Where the observation came from, so a reader can re-run it. */
  readonly source: string;
}

/**
 * Per-host tool-surface audit (#3987). Read by the deterministic deposit
 * coverage check, which fails closed when a host is absent from this table —
 * so a newly supported host cannot silently ship with no coverage claim.
 */
export const HOST_TOOL_SURFACE_AUDIT: Readonly<Record<ClassifyHookHost, HostToolSurfaceAudit>> = {
  grok: {
    mutation: {
      directWrite: ["write", "search_replace"],
      shell: ["run_terminal_command", "monitor"],
      spawn: ["spawn_subagent"],
    },
    nonMutation: {
      read_file: "read",
      grep: "read",
      list_dir: "read",
      search_tool: "read",
      web_search: "read",
      web_fetch: "read",
      todo_write: "session-local non-product scratch",
      get_command_or_subagent_output: "poll, not a mutation; elapsed bound is evaluateInFlight",
      wait_commands_or_subagents: "poll over already-dispatched work",
      kill_command_or_subagent: "process control",
      scheduler_delete: "removes a scheduled task; mutates no product path",
      scheduler_list: "read",
      enter_plan_mode: "session posture",
      exit_plan_mode: "session posture",
      image_gen: "writes generated media to session scratch, never a tracked product path",
      image_edit: "writes generated media to session scratch, never a tracked product path",
      image_to_video: "writes generated media to session scratch, never a tracked product path",
      reference_to_video: "writes generated media to session scratch, never a tracked product path",
      scheduler_create:
        "spawn-class and NOT covered: gating it routes a scheduling primitive through the " +
        "full spawn stack (ritual + active xBRIEF), a new deny class that needs a deliberate " +
        "policy decision rather than a coverage edit (#3987 residual)",
      use_tool:
        "mcp-class and NOT covered: the dispatcher classifies on the outer tool name, and the " +
        "MCP tool actually invoked is nested in tool_input.tool_name, so a matcher entry alone " +
        "buys a hook invocation and no enforcement; reading the inner name is a classifier " +
        "change, not a matcher change (#3987 residual)",
    },
    unobservedReason: null,
    source:
      "Observed directly on Grok Build: this host's published tool list, plus the 5,354-call " +
      "session census recorded on issue #3987.",
  },
  claude: {
    mutation: { directWrite: [], shell: ["Bash"], spawn: [] },
    nonMutation: {},
    unobservedReason:
      "Only the shell spelling is established (`Bash`, re-derived from the deposits by the " +
      "#3987 panel's completing seat 5471374558 F8). No PreToolUse payload for this host has " +
      "been observed in this tree, so the direct-write and spawn spellings stay unclaimed " +
      "rather than asserted from the deposit that is supposed to be under test.",
    source: "Issue #3987 comment 5471374558 finding F8.",
  },
  codex: {
    mutation: { directWrite: ["apply_patch"], shell: ["shell"], spawn: [] },
    nonMutation: {},
    unobservedReason:
      "Shell (`shell`) and the apply_patch write form are established — F8 for the shell " +
      "spelling, #3614 for the Codex apply_patch payload path. The rest of this host's surface " +
      "has not been observed in this tree.",
    source: "Issue #3987 comment 5471374558 finding F8; #3614 Codex apply_patch handling.",
  },
  cursor: {
    mutation: { directWrite: [], shell: [], spawn: [] },
    nonMutation: {},
    unobservedReason:
      "Unverified. Nothing in this tree establishes which tool names Cursor emits on " +
      "preToolUse: the deposit asserts a matcher string and the fixture corpus asserts the " +
      "framework's own assumption, neither of which observes the host. Cursor could be a " +
      "second zero-coverage host by the exact mechanism that produced #3987 (5471374558 F8), " +
      "and claiming coverage here would hide that.",
    source: "Issue #3987 comment 5471374558 finding F8.",
  },
};

/**
 * Known Grok mutation tool names. Deposited matchers must cover each name (#3987).
 * Projection of the per-host audit; kept as a named export for the #3990 tests.
 */
export const GROK_MUTATION_TOOL_CATALOG: HostMutationToolCatalog =
  HOST_TOOL_SURFACE_AUDIT.grok.mutation;

/** Grok tools that are intentionally not mutation-gated, each with its reason. */
export const GROK_NON_MUTATION_TOOLS: Readonly<Record<string, string>> =
  HOST_TOOL_SURFACE_AUDIT.grok.nonMutation;

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
