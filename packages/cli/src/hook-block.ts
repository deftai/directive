/**
 * Per-host blocking response for the launcher's `deft-hook` (RC-02 / AC3.3,
 * AC9.4). Same table as the host `.mjs` outer's `blockToolCall` (#6201):
 *
 * | Host           | `tool.before`                    | Other events        |
 * |----------------|----------------------------------|---------------------|
 * | claude, codex  | reason on stderr, exit 2         | stderr, exit 1      |
 * | cursor         | deny JSON on stdout, exit 0      | stderr, exit 1      |
 * | grok           | deny JSON on stdout, exit 0      | deny JSON, exit 0   |
 * | unknown / none | reason on stderr, exit 2         | stderr, exit 1      |
 *
 * Only `tool.before` blocks: exit 2 on other events can block compaction or
 * prompt submission (D-018). The outer keeps its own copy (Node built-ins
 * only); `entry-guard-parity.test.ts` checks the two give the same response.
 */

export const HOOK_TOOL_BEFORE_EVENT = "tool.before";

export interface HookBlock {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface HookTarget {
  readonly host: string;
  readonly event: string;
}

function argValue(argv: readonly string[], name: string): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === name) return argv[i + 1] ?? "";
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return "";
}

/** `--host` / `--event` from `deft-hook` argv (either `--x v` or `--x=v`). */
export function parseHookTarget(argv: readonly string[]): HookTarget {
  return {
    host: argValue(argv, "--host").trim().toLowerCase(),
    event: argValue(argv, "--event").trim(),
  };
}

export function isToolBefore(event: string): boolean {
  return event === HOOK_TOOL_BEFORE_EVENT;
}

/** The host's blocking response for `reason` (see the table above). */
export function renderHookBlock(host: string, event: string, reason: string): HookBlock {
  if (host === "grok") {
    return { stdout: `${JSON.stringify({ decision: "deny", reason })}\n`, stderr: "", exitCode: 0 };
  }
  if (isToolBefore(event) && host === "cursor") {
    return {
      stdout: `${JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason })}\n`,
      stderr: "",
      exitCode: 0,
    };
  }
  return { stdout: "", stderr: `${reason}\n`, exitCode: isToolBefore(event) ? 2 : 1 };
}
