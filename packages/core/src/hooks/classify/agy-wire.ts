/**
 * Antigravity (`agy`) wire adapter (#7346, slice `classify-identity` of #7332).
 *
 * Pure data and functions, no process I/O. Antigravity differs from the other
 * hosts in three ways this module absorbs so the shared readers stay unchanged:
 * tool arguments live at `toolCall.args` with capitalized keys, a lifecycle
 * rewrite is delivered as `overwrite: { CommandLine }`, and SessionStart context
 * is injected through `injectSteps`.
 *
 * Nothing here deposits a hook. `DEFAULT_HOST_HOOKS_POLICY.agy` stays false until
 * the deposit-doctor slice passes the admission verdict in `agy-observation.ts`.
 */

import { record } from "./payload.js";
import type { HookWriteIntent } from "./types.js";

export interface AgyToolDisposition {
  readonly intent: HookWriteIntent;
  /** True when the tool can change product state, so the shared gates apply. */
  readonly mutates: boolean;
  readonly note: string;
}

/**
 * Explicit disposition for every Antigravity tool name Directive has seen or
 * been told about. A name outside this table is not claimed (it classifies as
 * `other`), matching `HOST_TOOL_SURFACE_AUDIT.agy.unobservedReason`.
 */
export const AGY_TOOL_DISPOSITIONS: Readonly<Record<string, AgyToolDisposition>> = {
  run_command: { intent: "shell", mutates: true, note: "shell command (`CommandLine`)" },
  write_file: { intent: "direct-write", mutates: true, note: "file write (`Path`, `Content`)" },
  edit_file: {
    intent: "direct-write",
    mutates: true,
    note: "file edit (`Path`, `Target`, `Replacement`)",
  },
  read_file: { intent: "other", mutates: false, note: "read-only (`Path`)" },
  send_message: {
    intent: "other",
    mutates: false,
    note: "child-to-parent message; mutates no product path",
  },
  invoke_subagent: {
    intent: "spawn",
    mutates: true,
    note: "native spawn; denied fail-closed in v1",
  },
  run_workflow: { intent: "spawn", mutates: true, note: "native spawn; denied fail-closed in v1" },
  swarm: { intent: "spawn", mutates: true, note: "native spawn; denied fail-closed in v1" },
  define_subagent: {
    intent: "other",
    mutates: false,
    note:
      "defines a subagent template; mutates no product path (never emitted in the " +
      "observation run). The spawn it enables is denied.",
  },
};

/** Write intent for an agy tool name, or null when the name is not catalogued. */
export function agyWriteIntent(toolName: string): HookWriteIntent | null {
  return Object.hasOwn(AGY_TOOL_DISPOSITIONS, toolName)
    ? (AGY_TOOL_DISPOSITIONS[toolName]?.intent ?? null)
    : null;
}

/** Native spawn tools Directive denies on agy in v1 (no allow parity). */
export const AGY_UNSUPPORTED_SPAWN_TOOLS = ["invoke_subagent", "run_workflow", "swarm"] as const;

export function isAgyUnsupportedSpawnTool(toolName: string | null): boolean {
  return toolName !== null && (AGY_UNSUPPORTED_SPAWN_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Fail-closed deny for a native agy spawn tool. The tool's `Workspace` mode does
 * not name a child checkout and `Role` / `Prompt` do not prove a process-only
 * worker, so Directive guesses neither. One supported route is named.
 */
export function agyUnsupportedSpawnDenialMessage(toolName: string): string {
  return (
    `Directive denied agy ${toolName}: native Antigravity spawn tools are not gated in v1 ` +
    "(no child checkout and no process-only class can be read from their arguments). " +
    "Start the worker as its own `agy` process in the worktree allocated for it, as the " +
    "swarm skill describes."
  );
}

/** Tool names Claude-shaped readers already understand. */
const AGY_CANONICAL_TOOL_NAMES: Readonly<Record<string, string>> = {
  run_command: "Bash",
  write_file: "Write",
  edit_file: "Edit",
};

/** Capitalized agy argument keys mapped to the keys the shared readers use. */
const AGY_ARG_KEYS: Readonly<Record<string, string>> = {
  CommandLine: "command",
  Path: "file_path",
  Content: "content",
  Target: "old_string",
  Replacement: "new_string",
};

/**
 * Host-keyed view of an agy PreToolUse payload for the shared readers.
 *
 * Only the capitalized keys above are read, and only from `toolCall.args`, so no
 * other host's key set widens. Any other shape comes back unchanged. The payload
 * returned for an agy tool call carries canonical `tool_name` / `tool_input`;
 * classification still reads the real agy tool name from the original payload.
 */
export function normalizeAgyHookPayload(payload: unknown): unknown {
  const input = record(payload);
  if (input === null) return payload;
  const toolCall = record(input.toolCall);
  const args = toolCall === null ? null : record(toolCall.args);
  if (toolCall === null || args === null) return payload;
  const toolInput: Record<string, unknown> = {};
  for (const [agyKey, key] of Object.entries(AGY_ARG_KEYS)) {
    const value = args[agyKey];
    if (typeof value === "string") toolInput[key] = value;
  }
  const name = typeof toolCall.name === "string" ? toolCall.name : null;
  return {
    ...input,
    ...(name !== null ? { tool_name: AGY_CANONICAL_TOOL_NAMES[name] ?? name } : {}),
    tool_input: toolInput,
  };
}

/**
 * The closed set of SessionStart notices. Text is fixed here and locked by a
 * fixture: no issue, comment, or other external body reaches `injectSteps`.
 */
export const AGY_SESSION_START_NOTICES = {
  "directive-disabled":
    "Directive is disabled for this project (kill-switch record or .no-deft-directive). " +
    "Its hooks are not protecting this session. A person re-enables it: " +
    "`deft kill-switch:off --confirm`, then start a new agent session.",
  "hook-runtime-unavailable":
    "Directive hook runtime is unavailable (node missing or the pinned runtime not " +
    "installed), so Directive is not protecting this session. A person runs the project " +
    "install (`npm install` or `pnpm install --frozen-lockfile`).",
  "session-start-ritual":
    "Directive is active. Before changing files, run `deft session:start`, then " +
    "`deft verify:session-ritual -- --tier=gated`.",
} as const;
export type AgySessionStartNoticeId = keyof typeof AGY_SESSION_START_NOTICES;

/**
 * Notice id for a SessionStart decision code, or null when none applies.
 * `hook-runtime-unavailable` has no decision code: no runtime runs when it applies, so
 * the deposited outer emits it through `renderAgySessionStartNotice` (deposit-doctor
 * slice, #7347). Until then it is unreachable from `decideHook` by design.
 */
export function agySessionStartNoticeFor(code: string): AgySessionStartNoticeId | null {
  if (code === "session-start-disabled" || code === "directive-disabled") {
    return "directive-disabled";
  }
  if (code === "session-start" || code === "session-start-degraded") {
    return "session-start-ritual";
  }
  return null;
}

/** SessionStart stdout for one catalogued notice. */
export function renderAgySessionStartNotice(id: AgySessionStartNoticeId): string {
  return JSON.stringify({
    injectSteps: [{ systemMessage: { systemMessage: AGY_SESSION_START_NOTICES[id] } }],
  });
}

/** The slice of a hook decision the agy renderer reads. */
export interface AgyRenderableDecision {
  readonly verdict: "allow" | "deny";
  readonly event: string;
  readonly code: string;
  readonly message: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

/**
 * Antigravity hook stdout.
 *
 * Every Directive refusal is `deny`, never `ask` or `force_ask`. A tool.before
 * allow is explicit because exit 0 with empty stdout is a host fail-open path.
 * `overwrite` carries only `CommandLine`, and only from the exact-lifecycle
 * rewrite that put `updatedInput` on the decision; a rewrite that cannot be
 * expressed that way is denied rather than dropped.
 */
export function renderAgyHostDecision(decision: AgyRenderableDecision): string {
  if (decision.verdict === "deny") {
    return JSON.stringify({ decision: "deny", reason: decision.message });
  }
  if (decision.event === "tool.before") {
    if (decision.updatedInput === undefined) return JSON.stringify({ decision: "allow" });
    const command = decision.updatedInput.command;
    if (typeof command !== "string" || command.length === 0) {
      return JSON.stringify({
        decision: "deny",
        reason:
          "Directive denied this agy tool call: the lifecycle rewrite has no command to " +
          "deliver through overwrite.CommandLine.",
      });
    }
    return JSON.stringify({ decision: "allow", overwrite: { CommandLine: command } });
  }
  if (decision.event === "session.start") {
    const id = agySessionStartNoticeFor(decision.code);
    return id === null ? "" : renderAgySessionStartNotice(id);
  }
  return "";
}
