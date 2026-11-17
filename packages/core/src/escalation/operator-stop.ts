/**
 * Record an operator-only stop as a typed escalation (#6275 Prefer-A Bound limb 1).
 *
 * Only when the operator-notify channel is not `off`: with the notifier off
 * this writes nothing. Mints file as `approval` + `dangerous: true`; other
 * steps as `cmd_approval`. The body carries the worktree path and the exact
 * command(s). Dedupe on (code, target, session) by exclusive-create of a key
 * file. Errors are swallowed; the caller's verdict never changes.
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedWrite,
} from "../fs/contained-write.js";
import {
  type OperatorNotifyChannel,
  resolveOperatorNotifyChannel,
} from "../policy/operator-notify.js";
import { fileEscalation } from "./actions.js";
import { OPERATOR_STOP_COMMANDS_HEADER, spawnOperatorNotifier } from "./operator-notify.js";
import { escalationsDir } from "./paths.js";
import type { EscalationEvent } from "./types.js";

/** Dedupe key directory under `.deft/escalations/`. */
export const OPERATOR_STOP_KEYS_DIR = ".keys";

export type OperatorStopKind = "mint" | "step";

export interface OperatorStopInput {
  readonly projectRoot: string;
  readonly kind: OperatorStopKind;
  /** Stop class, e.g. `authz-grant-missing` or `mint-refused`. */
  readonly code: string;
  /** What was stopped, e.g. the denied op and path, or the mint verb. */
  readonly target: string;
  readonly sessionId?: string | null;
  readonly title: string;
  readonly commands: readonly string[];
  readonly agentId?: string;
  readonly contextRefs?: readonly string[];
  readonly now?: Date;
}

export interface OperatorStopDeps {
  readonly resolveChannel?: (projectRoot: string) => OperatorNotifyChannel;
  readonly spawnNotifier?: (projectRoot: string) => void;
}

export type OperatorStopOutcome =
  | { readonly recorded: true; readonly event: EscalationEvent }
  | {
      readonly recorded: false;
      readonly reason: "notifier-off" | "duplicate" | "error";
      readonly error?: string;
    };

function defaultResolveChannel(projectRoot: string): OperatorNotifyChannel {
  return resolveOperatorNotifyChannel({ projectRoot }).channel;
}

function defaultSpawnNotifier(projectRoot: string): void {
  spawnOperatorNotifier(projectRoot);
}

/** Body for an operator-stop escalation: worktree line plus the command block. */
export function formatOperatorStopBody(
  projectRoot: string,
  commands: readonly string[],
  note?: string | null,
): string {
  const lines: string[] = [];
  if (note !== undefined && note !== null && note.trim().length > 0) {
    lines.push(note.trim(), "");
  }
  lines.push(`Worktree: ${resolve(projectRoot)}`, "");
  lines.push(OPERATOR_STOP_COMMANDS_HEADER);
  for (const command of commands) {
    const single = command.replace(/\r?\n/g, " ").trim();
    if (single.length > 0) lines.push(single);
  }
  return `${lines.join("\n")}\n`;
}

/** Characters a PowerShell argument may hold unquoted (`,` and `@` are operators there). */
const BARE_ARG_WIN32 = /^[A-Za-z0-9_+=:./\\-]+$/;
/** Characters a POSIX shell argument may hold unquoted. */
const BARE_ARG_POSIX = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one argument for PowerShell (win32) or a POSIX shell. */
export function quoteShellArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    if (arg.length > 0 && BARE_ARG_WIN32.test(arg)) return arg;
    return `'${arg.replace(/'/g, "''")}'`;
  }
  if (arg.length > 0 && BARE_ARG_POSIX.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Exact operator command: `cd <worktree>; deft <verb> -- <args>`.
 * `--confirm` is appended when missing (a mint needs it at the human TTY).
 */
export function formatOperatorCommand(input: {
  readonly projectRoot: string;
  readonly verb: string;
  readonly args: readonly string[];
  readonly confirm?: boolean;
  readonly platform?: NodeJS.Platform;
}): string {
  const platform = input.platform ?? process.platform;
  const args = [...input.args];
  while (args[0] === "--") args.shift();
  if (input.confirm === true && !args.includes("--confirm")) args.push("--confirm");
  const quoted = args.map((a) => quoteShellArg(a, platform)).join(" ");
  const cd = `cd ${quoteShellArg(resolve(input.projectRoot), platform)}`;
  return `${cd}; deft ${input.verb}${quoted.length > 0 ? ` -- ${quoted}` : ""}`;
}

/** Notify the operator when the channel is on. Never throws. */
export function notifyOperatorIfEnabled(projectRoot: string, deps: OperatorStopDeps = {}): boolean {
  try {
    const channel = (deps.resolveChannel ?? defaultResolveChannel)(projectRoot);
    if (channel === "off") return false;
    (deps.spawnNotifier ?? defaultSpawnNotifier)(projectRoot);
    return true;
  } catch {
    return false;
  }
}

function dedupeKey(input: OperatorStopInput): string {
  return createHash("sha256")
    .update(`${input.code}\n${input.target}\n${input.sessionId ?? "none"}`)
    .digest("hex");
}

/**
 * Record one operator-only stop and start the notifier. Writes nothing while
 * the channel is `off`. Swallows its own errors.
 */
export function recordOperatorStop(
  input: OperatorStopInput,
  deps: OperatorStopDeps = {},
): OperatorStopOutcome {
  try {
    const channel = (deps.resolveChannel ?? defaultResolveChannel)(input.projectRoot);
    if (channel === "off") return { recorded: false, reason: "notifier-off" };
    const root = resolve(input.projectRoot);
    try {
      containedWrite({
        root,
        target: join(escalationsDir(root), OPERATOR_STOP_KEYS_DIR, dedupeKey(input)),
        data: `${input.code}\n`,
        mode: "create",
      });
    } catch (err) {
      if (err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS) {
        return { recorded: false, reason: "duplicate" };
      }
      return {
        recorded: false,
        reason: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const event = fileEscalation({
      projectRoot: root,
      type: input.kind === "mint" ? "approval" : "cmd_approval",
      title: input.title,
      body: formatOperatorStopBody(root, input.commands),
      agentId: input.agentId ?? input.sessionId ?? "agent",
      contextRefs: input.contextRefs,
      dangerous: input.kind === "mint",
      now: input.now,
    });
    (deps.spawnNotifier ?? defaultSpawnNotifier)(root);
    return { recorded: true, event };
  } catch (err) {
    return {
      recorded: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
