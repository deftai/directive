/**
 * Operator-stop notifier (#6275 Prefer-A Bound limb 3).
 *
 * One owner at a time, under the plan-sequence owner-token directory lock
 * (no takeover while the owner is alive or unknown; release only by the
 * holding token), collects every open escalation that has no
 * `.deft/escalations/.notified/<id>` marker, writes the markers, sends one OS
 * notification listing them, and rescans until none is left. A contender
 * waits on the lock's acquisition loop, then sends whatever is still
 * un-notified. Delivery is best effort and at most once per escalation.
 *
 * The notifier only tells. It never runs a command, resolves an escalation,
 * or changes a gate. The payload is passed as data only: argv on macOS and
 * Linux, stdin on Windows, never a `-Command` string.
 */

import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedWrite,
} from "../fs/contained-write.js";
import {
  type PlanSequenceLockDeps,
  withPlanSequenceSidecarLock,
} from "../plan-sequence/mutation-lock.js";
import { escalationPath, escalationsDir } from "./paths.js";
import { listOpenEscalations } from "./store.js";
import type { EscalationEvent } from "./types.js";

/** Lock directory name under `.deft/escalations/`. */
export const OPERATOR_NOTIFY_LOCK_NAME = ".notify.lock";
/** Claim-marker directory name under `.deft/escalations/`. */
export const OPERATOR_NOTIFIED_DIR = ".notified";
/** argv flag that runs this module as the detached notifier child. */
export const OPERATOR_NOTIFY_CHILD_FLAG = "--deft-operator-notify-child";
/** Per-send timeout for the OS adapter. */
export const OPERATOR_NOTIFY_SEND_TIMEOUT_MS = 15_000;

/** Header line that starts the command block in an operator-stop body. */
export const OPERATOR_STOP_COMMANDS_HEADER = "Commands (agent-proposed; read before running):";

export interface OperatorNotification {
  readonly title: string;
  readonly body: string;
  readonly ids: readonly string[];
}

export type OperatorNotificationSender = (notification: OperatorNotification) => boolean;

/** Remove control characters (C0, DEL, C1) from one display field. */
export function stripControlChars(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
}

/** Commands recorded in an operator-stop body (lines after the header, up to a blank line). */
export function operatorStopCommands(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === OPERATOR_STOP_COMMANDS_HEADER);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0) break;
    out.push(line.trim());
  }
  return out;
}

/** Worktree recorded in an operator-stop body (`Worktree: <path>` line), or null. */
export function operatorStopWorktree(body: string): string | null {
  const prefix = "Worktree:";
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const value = trimmed.slice(prefix.length).trim();
    if (value.length > 0) return value;
  }
  return null;
}

function isMint(event: EscalationEvent): boolean {
  return event.type === "approval" && event.dangerous;
}

/**
 * Build one notification for a batch: mint commands one per line, every other
 * command joined into one script per worktree (named in its header, since a
 * filed command such as `gh pr merge 12` carries no directory of its own).
 * Every command is labelled agent-proposed.
 */
export function formatOperatorNotification(
  events: readonly EscalationEvent[],
): OperatorNotification {
  const count = events.length;
  const title = `Directive: ${count} operator step${count === 1 ? "" : "s"} waiting`;
  const mintLines: string[] = [];
  const scripts = new Map<string, string[]>();
  const otherLines: string[] = [];
  for (const event of events) {
    const commands = operatorStopCommands(event.body).map(stripControlChars);
    const label = stripControlChars(event.title);
    if (commands.length === 0) {
      otherLines.push(`- ${label} (deft escalation:list --open)`);
      continue;
    }
    if (isMint(event)) {
      for (const command of commands) mintLines.push(`Mint (run alone): ${command}`);
      continue;
    }
    const worktree = stripControlChars(operatorStopWorktree(event.body) ?? "");
    const script = scripts.get(worktree) ?? [];
    script.push(...commands);
    scripts.set(worktree, script);
  }
  const body: string[] = ["Agent-proposed commands. Read each one before running it."];
  body.push(...mintLines);
  for (const [worktree, lines] of scripts) {
    body.push(worktree.length > 0 ? `Script (run in ${worktree}):` : "Script:");
    body.push(...lines);
  }
  body.push(...otherLines);
  return { title, body: body.join("\n"), ids: events.map((e) => e.id) };
}

function notifiedRoot(projectRoot: string): string {
  return join(escalationsDir(projectRoot), OPERATOR_NOTIFIED_DIR);
}

function markerName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNotified(projectRoot: string, id: string): boolean {
  return existsSync(join(notifiedRoot(projectRoot), markerName(id)));
}

type ClaimOutcome =
  | { readonly kind: "claimed" }
  | { readonly kind: "taken" }
  | { readonly kind: "failed"; readonly error: string };

/** Exclusive-create the claim marker for one escalation (returned failure, never a throw). */
function claimNotified(projectRoot: string, id: string): ClaimOutcome {
  try {
    containedWrite({
      root: resolve(projectRoot),
      target: join(notifiedRoot(projectRoot), markerName(id)),
      data: `${new Date().toISOString()}\n`,
      mode: "create",
    });
    return { kind: "claimed" };
  } catch (err) {
    if (err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS) {
      return { kind: "taken" };
    }
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Order by `createdAt`, then by file mtime: `createdAt` has one-second
 * resolution, and a script must keep the order the steps were filed in.
 */
function inFilingOrder(projectRoot: string, events: readonly EscalationEvent[]): EscalationEvent[] {
  const mtime = new Map<string, number>();
  for (const event of events) {
    let ms = 0;
    try {
      ms = statSync(escalationPath(projectRoot, event.id)).mtimeMs;
    } catch {
      /* keep 0 */
    }
    mtime.set(event.id, ms);
  }
  return [...events].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || (mtime.get(a.id) ?? 0) - (mtime.get(b.id) ?? 0),
  );
}

export interface DrainOperatorStopsDeps {
  readonly send?: OperatorNotificationSender;
  /** Test seam: runs after each send, before the next rescan. */
  readonly afterSend?: () => void;
}

export interface DrainOperatorStopsResult {
  readonly notifications: readonly OperatorNotification[];
  /** Set when a claim marker could not be written; the drain stops there. */
  readonly error: string | null;
}

/**
 * Collect, claim and send every open un-notified escalation, rescanning until
 * none is left. Callers hold the notify lock; exported for fixtures. Each round
 * claims at least one new escalation, so the loop ends once filing stops.
 */
export function drainOperatorStops(
  projectRoot: string,
  deps: DrainOperatorStopsDeps = {},
): DrainOperatorStopsResult {
  const send = deps.send ?? sendOsNotification;
  const sent: OperatorNotification[] = [];
  while (true) {
    const pending = inFilingOrder(
      projectRoot,
      listOpenEscalations(projectRoot).filter((e) => !isNotified(projectRoot, e.id)),
    );
    const claimed: EscalationEvent[] = [];
    for (const event of pending) {
      const outcome = claimNotified(projectRoot, event.id);
      if (outcome.kind === "failed") {
        if (claimed.length > 0) sendQuietly(send, formatOperatorNotification(claimed), sent);
        return { notifications: sent, error: outcome.error };
      }
      if (outcome.kind === "claimed") claimed.push(event);
    }
    if (claimed.length === 0) return { notifications: sent, error: null };
    sendQuietly(send, formatOperatorNotification(claimed), sent);
    deps.afterSend?.();
  }
}

function sendQuietly(
  send: OperatorNotificationSender,
  notification: OperatorNotification,
  sent: OperatorNotification[],
): void {
  try {
    send(notification);
  } catch {
    // Delivery failure never fails the caller; the claim stays (at most once).
  }
  sent.push(notification);
}

export interface RunOperatorNotifierDeps extends DrainOperatorStopsDeps {
  readonly lock?: PlanSequenceLockDeps;
}

export interface RunOperatorNotifierResult {
  readonly ok: boolean;
  readonly notifications: readonly OperatorNotification[];
  readonly error: string | null;
}

/** Path of the notify lock directory for a project root. */
export function operatorNotifyLockPath(projectRoot: string): string {
  return join(escalationsDir(projectRoot), OPERATOR_NOTIFY_LOCK_NAME);
}

/**
 * Take the notify lock (waiting on its acquisition loop while a live owner
 * holds it), drain, and release. Acquisition-budget exhaustion returns
 * `ok: false` and leaves the stop un-notified until a later attempt.
 */
export function runOperatorNotifier(
  projectRoot: string,
  deps: RunOperatorNotifierDeps = {},
): RunOperatorNotifierResult {
  try {
    const result = withPlanSequenceSidecarLock(
      operatorNotifyLockPath(projectRoot),
      () => drainOperatorStops(projectRoot, deps),
      deps.lock ?? {},
    );
    if (!result.ok) return { ok: false, notifications: [], error: result.message };
    return {
      ok: result.value.error === null,
      notifications: result.value.notifications,
      error: result.value.error,
    };
  } catch (err) {
    return {
      ok: false,
      notifications: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Constant PowerShell script: reads the payload JSON from stdin and shows a toast. */
const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$p = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$t = $x.GetElementsByTagName('text')",
  "$t.Item(0).AppendChild($x.CreateTextNode([string]$p.title)) > $null",
  "$t.Item(1).AppendChild($x.CreateTextNode([string]$p.body)) > $null",
  "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join("\n");

export interface OsNotificationCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Payload passed on stdin (Windows only). */
  readonly input: string | null;
}

/**
 * Data-only OS adapter argv for one notification. The payload is never part
 * of a script string: argv items on macOS / Linux, stdin JSON on Windows.
 */
export function osNotificationCommand(
  notification: OperatorNotification,
  platform: NodeJS.Platform = process.platform,
): OsNotificationCommand | null {
  if (platform === "win32") {
    const encoded = Buffer.from(WINDOWS_TOAST_SCRIPT, "utf16le").toString("base64");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      input: JSON.stringify({ title: notification.title, body: notification.body }),
    };
  }
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        notification.title,
        notification.body,
      ],
      input: null,
    };
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    return {
      command: "notify-send",
      args: ["--app-name=Directive", "--", notification.title, notification.body],
      input: null,
    };
  }
  return null;
}

export type OsNotificationRunner = (
  command: string,
  args: readonly string[],
  options: { readonly input: string | null; readonly timeoutMs: number },
) => number | null;

function defaultRunner(
  command: string,
  args: readonly string[],
  options: { readonly input: string | null; readonly timeoutMs: number },
): number | null {
  const result = spawnSync(command, [...args], {
    input: options.input ?? undefined,
    stdio: [options.input === null ? "ignore" : "pipe", "ignore", "ignore"],
    timeout: options.timeoutMs,
    windowsHide: true,
    shell: false,
  });
  return result.status;
}

/** Send one OS notification. Returns true on exit 0; never throws. */
export function sendOsNotification(
  notification: OperatorNotification,
  deps: { readonly platform?: NodeJS.Platform; readonly run?: OsNotificationRunner } = {},
): boolean {
  const cmd = osNotificationCommand(notification, deps.platform ?? process.platform);
  if (cmd === null) return false;
  try {
    const status = (deps.run ?? defaultRunner)(cmd.command, cmd.args, {
      input: cmd.input,
      timeoutMs: OPERATOR_NOTIFY_SEND_TIMEOUT_MS,
    });
    return status === 0;
  } catch {
    return false;
  }
}

/** Path of this module, used as the detached child's entry. */
export function operatorNotifyEntryPath(): string {
  return fileURLToPath(import.meta.url);
}

export interface SpawnOperatorNotifierDeps {
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => {
    unref(): void;
    on?(event: "error", listener: (err: Error) => void): unknown;
  };
  readonly execPath?: string;
  readonly entry?: string;
}

/**
 * Start the notifier as a detached child (no inherited stdin, hidden window,
 * unref'd) so the caller gains no latency. Returns false when spawn fails.
 */
export function spawnOperatorNotifier(
  projectRoot: string,
  deps: SpawnOperatorNotifierDeps = {},
): boolean {
  try {
    const spawner = deps.spawn ?? spawn;
    const child = spawner(
      deps.execPath ?? process.execPath,
      [deps.entry ?? operatorNotifyEntryPath(), OPERATOR_NOTIFY_CHILD_FLAG, resolve(projectRoot)],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    // Spawn failures (ENOENT, EAGAIN) arrive as an `error` event, not a throw;
    // without a listener they would crash the hook or mint command.
    child.on?.("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** True when argv asks this module to run as the notifier child. */
export function isOperatorNotifyChildArgv(argv: readonly string[], entry: string): boolean {
  const script = argv[1];
  return (
    script !== undefined &&
    argv[2] === OPERATOR_NOTIFY_CHILD_FLAG &&
    typeof argv[3] === "string" &&
    argv[3].length > 0 &&
    resolve(script) === resolve(entry)
  );
}

/* v8 ignore start -- detached child entry; covered by isOperatorNotifyChildArgv + runOperatorNotifier */
if (isOperatorNotifyChildArgv(process.argv, operatorNotifyEntryPath())) {
  runOperatorNotifier(process.argv[3] as string);
}
/* v8 ignore stop */
