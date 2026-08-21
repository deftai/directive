#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideHook,
  type HookEvent,
  type HookHost,
  type HookPayloadContext,
  hookPayloadTopLevelKeys,
  isHookEvent,
  isHookHost,
  normalizeHookProjectRoot,
  parseHookStdin,
  projectRootFromHookPayload,
  renderHostDecision,
} from "@deftai/directive-core/hooks";

interface ParsedArgs {
  host?: HookHost;
  event?: HookEvent;
  projectRoot?: string;
  error?: string;
}

export interface HookDispatchCliSeams {
  readonly readStdin?: () => string;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  readonly cwd?: () => string;
  /**
   * Sleep between empty-stdin retry polls (#2864). Injected in tests so delayed
   * payloads can be simulated without real wall-clock waits.
   */
  readonly sleepMs?: (ms: number) => void;
  /**
   * Empty-stdin retry budget in ms (default {@link DEFAULT_STDIN_EMPTY_RETRY_MS}).
   * Set `0` to disable retries (single read). Tests for true-empty paths often
   * set this to 0 for speed; delayed-payload tests set a positive budget.
   */
  readonly stdinEmptyRetryMs?: number;
  /** Clock for empty-stdin deadline; defaults to `Date.now` (tests inject synthetic clocks). */
  readonly nowMs?: () => number;
}

/**
 * How long to re-poll stdin after an empty first read before concluding the host
 * sent nothing (#2864). Keeps well under Cursor's deposited `timeout: 5` while
 * covering short non-blocking delivery races (reporter matrix rows K/L).
 */
export const DEFAULT_STDIN_EMPTY_RETRY_MS = 250;

/** Interval between empty-stdin re-polls while the retry budget remains. */
export const STDIN_EMPTY_RETRY_INTERVAL_MS = 25;

function defaultSleepMs(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin — last-resort fallback when Atomics.wait is unavailable */
    }
  }
}

/**
 * Read hook stdin with a short empty-read retry budget (#2864).
 *
 * A single `readFileSync(0)` on a non-blocking descriptor can return zero bytes
 * before the host has attached a writer. That is indistinguishable from a true
 * empty payload if we never re-poll. We re-read for up to `emptyRetryMs`; true
 * empty (every poll empty through the budget) still yields empty for the deny
 * path. Delayed payloads that arrive within the budget are accepted.
 */
export function readStdinHardened(
  readOnce: () => string,
  options: {
    emptyRetryMs?: number;
    sleepMs?: (ms: number) => void;
    nowMs?: () => number;
  } = {},
): string {
  const emptyRetryMs = options.emptyRetryMs ?? DEFAULT_STDIN_EMPTY_RETRY_MS;
  const sleepMs = options.sleepMs ?? defaultSleepMs;
  const nowMs = options.nowMs ?? (() => Date.now());
  let raw = readOnce();
  if (raw.trim().length > 0 || emptyRetryMs <= 0) return raw;

  const deadline = nowMs() + emptyRetryMs;
  while (nowMs() < deadline) {
    sleepMs(STDIN_EMPTY_RETRY_INTERVAL_MS);
    raw = readOnce();
    if (raw.trim().length > 0) return raw;
  }
  return raw;
}

function takeValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value?: string; next: number; error?: string } {
  const token = argv[index];
  const prefix = `${flag}=`;
  if (token?.startsWith(prefix)) return { value: token.slice(prefix.length), next: index };
  const value = argv[index + 1];
  if (value === undefined) return { next: index, error: `argument ${flag}: expected one argument` };
  return { value, next: index + 1 };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--host" || token?.startsWith("--host=")) {
      const taken = takeValue(argv, i, "--host");
      if (taken.error) return { error: taken.error };
      const value = taken.value ?? "";
      if (!isHookHost(value)) {
        return { error: `unsupported host: ${JSON.stringify(taken.value)}` };
      }
      parsed.host = value;
      i = taken.next;
      continue;
    }
    if (token === "--event" || token?.startsWith("--event=")) {
      const taken = takeValue(argv, i, "--event");
      if (taken.error) return { error: taken.error };
      const value = taken.value ?? "";
      if (!isHookEvent(value)) {
        return { error: `unsupported event: ${JSON.stringify(taken.value)}` };
      }
      parsed.event = value;
      i = taken.next;
      continue;
    }
    if (token === "--project-root" || token?.startsWith("--project-root=")) {
      const taken = takeValue(argv, i, "--project-root");
      if (taken.error) return { error: taken.error };
      parsed.projectRoot = taken.value;
      i = taken.next;
      continue;
    }
    return { error: `unrecognized argument: ${token}` };
  }
  if (parsed.host === undefined) return { error: "--host is required" };
  if (parsed.event === undefined) return { error: "--event is required" };
  return parsed;
}

/** @deprecated Prefer ParsedHookPayload from @deftai/directive-core/hooks (#2950). */
export interface ParsedPayload {
  readonly payload: unknown;
  readonly context: HookPayloadContext;
}

/**
 * Parse host hook stdin into payload + context.
 * Pure implementation lives in core classify (`parseHookStdin`); CLI re-exports
 * for backward-compatible imports in tests (#2734 / #2738 / #2950).
 */
export function parsePayload(raw: string): ParsedPayload {
  return parseHookStdin(raw);
}

/**
 * Provider-neutral hook dispatch CLI entry (`deft hook:dispatch` / `deft-hook`).
 *
 * ## Exit-code contract (#2864)
 *
 * | Exit | Meaning |
 * |------|---------|
 * | `0`  | A host decision was rendered to stdout (allow **or** deny). Hosts must parse stdout; exit status does **not** encode the verdict. |
 * | `2`  | Argv / configuration error (unsupported host/event, missing flags, unrecognized args). |
 *
 * This process never returns `1` for a rendered verdict. Cursor `failClosed`
 * deposits that report "exit code 1" are therefore process-level failures
 * (crash, signal kill under host timeout, spawn environment), not `run()` deny
 * paths. Empty-stdin denies still exit `0` with a Cursor JSON body carrying
 * `code: "stdin-empty"`.
 */
export function run(argv: string[], seams: HookDispatchCliSeams = {}): number {
  const args = parseArgs(argv);
  const writeOut = seams.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = seams.writeErr ?? ((text: string) => process.stderr.write(text));
  if (args.error !== undefined || args.host === undefined || args.event === undefined) {
    writeErr(`${args.error ?? "invalid hook-dispatch arguments"}\n`);
    return 2;
  }

  const readOnce = seams.readStdin ?? (() => readFileSync(0, "utf8"));
  const rawStdin = readStdinHardened(readOnce, {
    emptyRetryMs: seams.stdinEmptyRetryMs,
    sleepMs: seams.sleepMs,
    nowMs: seams.nowMs,
  });
  const cwd = (seams.cwd ?? process.cwd)();
  const { payload, context: payloadContext } = parsePayload(rawStdin);
  const projectRoot = normalizeHookProjectRoot(
    args.projectRoot ? resolve(args.projectRoot) : projectRootFromHookPayload(payload, cwd),
  );
  const decision = decideHook(
    {
      host: args.host,
      event: args.event,
      projectRoot,
      payload,
      payloadContext,
    },
    // Shell observation is opt-in in core so library callers and tests do not
    // write into their own project roots; the real hook turns it on (#3438).
    { shellObserve: true },
  );
  const rendered = renderHostDecision(args.host, decision);
  if (rendered.length > 0) writeOut(`${rendered}\n`);
  if (
    (decision.code === "invalid-input" || decision.code === "stdin-empty") &&
    args.host === "cursor"
  ) {
    // Keys are already embedded in decision.message; stderr helps operators tailing logs.
    const keys = hookPayloadTopLevelKeys(payload);
    if (keys.length > 0) {
      writeErr(`Directive hook diagnostic: payload top-level keys: ${keys.join(", ")}\n`);
    } else if (decision.code === "stdin-empty") {
      writeErr("Directive hook diagnostic: stdin was empty after empty-read retry budget\n");
    }
  }
  if (decision.code === "session-start-degraded") writeErr(`${decision.message}\n`);
  if (
    decision.code === "session-compact-rearm" ||
    decision.code === "session-compact-rearm-degraded" ||
    decision.code === "session-compact-noop"
  ) {
    writeErr(`${decision.message}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
