#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCheapInSync } from "@deftai/directive-core/dist/install-health/cheap.js";
import { INSTALLATION_RECOVERY_GUIDANCE } from "@deftai/directive-core/dist/install-health/constants.js";
import type { CheapInSyncResult } from "@deftai/directive-core/dist/install-health/types.js";
import {
  decideHook,
  type HookDecision,
  type HookEvent,
  type HookHost,
  type HookPayloadContext,
  hookPayloadTopLevelKeys,
  isHookEvent,
  isHookHost,
  mergeHookDispatchEnviron,
  normalizeHookProjectRoot,
  parseHookStdin,
  projectRootFromHookPayload,
  renderHostDecision,
} from "@deftai/directive-core/hooks";
import { readProjectDataStatus } from "./data-status.js";
import { maybeSelfCompleteSetup } from "./self-complete.js";

/**
 * Session-start schema-behind notice (AC8.9 / AC14.11). Doctor uses the same
 * remedy name; other hooks must stay silent about data currency.
 */
export const SESSION_START_SCHEMA_BEHIND_NOTICE =
  "Project data schema is behind the runtime; run `directive upgrade`.";

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
  /**
   * Checkout that owns the running hook-bin / runtime package (AC9.4 / AC9.5).
   * Defaults to walking up from this module to the consumer root above
   * `node_modules/@deftai/directive-runtime`. Returns null for monorepo source
   * runs (no installed package path) — mismatch guard is skipped when null.
   */
  readonly launchingCheckoutRoot?: () => string | null;
  /**
   * Cheap pin/installed identity check (AC9.4 / AC14.8). Defaults to
   * `checkCheapInSync`. Injected in unit tests to force failClosed without a
   * dual fixture.
   */
  readonly cheapInSync?: (root: string) => CheapInSyncResult;
}

/**
 * How long to re-poll stdin after an empty first read before concluding the host
 * sent nothing (#2864). Keeps well under Cursor's deposited `timeout: 5` while
 * covering short non-blocking delivery races (reporter matrix rows K/L).
 */
export const DEFAULT_STDIN_EMPTY_RETRY_MS = 250;

/** Interval between empty-stdin re-polls while the retry budget remains. */
export const STDIN_EMPTY_RETRY_INTERVAL_MS = 25;

/**
 * Resolve the consumer project root that owns an installed runtime module path
 * (AC9.4 / AC9.5). Returns null when the path is not under
 * `node_modules/@deftai/directive-runtime` (monorepo source / vitest).
 */
export function resolveLaunchingCheckoutRootFromPath(modulePath: string): string | null {
  const normalized = modulePath.replace(/\\/g, "/");
  const needle = "/node_modules/@deftai/directive-runtime/";
  let before: string | null = null;
  const idx = normalized.lastIndexOf(needle);
  if (idx !== -1) {
    before = normalized.slice(0, idx);
  } else {
    const endNeedle = "/node_modules/@deftai/directive-runtime";
    if (normalized === endNeedle || normalized.endsWith(endNeedle)) {
      before = normalized.slice(0, normalized.length - endNeedle.length);
    }
  }
  if (before === null) return null;
  const pnpmMarker = "/node_modules/.pnpm/";
  const pnpmIdx = before.lastIndexOf(pnpmMarker);
  if (pnpmIdx !== -1) before = before.slice(0, pnpmIdx);
  return before.length > 0 ? before : null;
}

/** Resolve launching checkout from a module URL (defaults to this file). */
export function resolveLaunchingCheckoutRoot(moduleUrl: string = import.meta.url): string | null {
  try {
    return resolveLaunchingCheckoutRootFromPath(fileURLToPath(moduleUrl));
  } catch {
    return null;
  }
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function rootsMatch(a: string, b: string): boolean {
  return realpathOrResolve(a) === realpathOrResolve(b);
}

function installationIdentityDeny(
  host: HookHost,
  event: HookEvent,
  projectRoot: string,
  message: string,
): HookDecision {
  return {
    verdict: "deny",
    code: "installation-identity-deny",
    event,
    host,
    toolName: null,
    projectRoot: normalizeHookProjectRoot(projectRoot),
    message,
    scopePath: null,
  };
}

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

  // Wave 2k / AC9.4+AC9.5: payload project root must match the checkout that
  // owns the running hook-bin. Mismatch → fail closed (no setup, no policy).
  const launchRoot = (seams.launchingCheckoutRoot ?? resolveLaunchingCheckoutRoot)();
  if (launchRoot !== null && !rootsMatch(launchRoot, projectRoot)) {
    const guidance = INSTALLATION_RECOVERY_GUIDANCE;
    const decision = installationIdentityDeny(
      args.host,
      args.event,
      projectRoot,
      `Directive hook refuse: payload project root does not match the launching checkout ` +
        `(payloadRoot=${normalizeHookProjectRoot(projectRoot)} ` +
        `launchRoot=${normalizeHookProjectRoot(launchRoot)}). Recovery: ${guidance}`,
    );
    const rendered = renderHostDecision(args.host, decision);
    if (rendered.length > 0) writeOut(`${rendered}\n`);
    return 0;
  }

  // Wave 2k / AC9.4+AC14.8: pin≠installed → fail closed before policy.
  const cheap = (seams.cheapInSync ?? checkCheapInSync)(projectRoot);
  if (cheap.failClosed) {
    const guidance = cheap.recoveryGuidance ?? INSTALLATION_RECOVERY_GUIDANCE;
    const decision = installationIdentityDeny(
      args.host,
      args.event,
      projectRoot,
      `Directive hook refuse: pinned runtime does not match the installed runtime ` +
        `(pin=${cheap.pinVersion ?? "?"} installed=${cheap.installedVersion ?? "?"}). ` +
        `Recovery: ${guidance}`,
    );
    const rendered = renderHostDecision(args.host, decision);
    if (rendered.length > 0) writeOut(`${rendered}\n`);
    return 0;
  }

  // Wave 2d / AC8.6: registered hooks self-complete when readiness is missing/stale.
  // Suppressed when DEFT_DOCTOR_HOOK_DIAGNOSTIC is set (AC9.10).
  maybeSelfCompleteSetup(projectRoot, { fromHook: true });
  const environ = mergeHookDispatchEnviron(payload);
  let decision = decideHook({
    host: args.host,
    event: args.event,
    projectRoot,
    payload,
    payloadContext,
    ...(environ !== undefined ? { environ } : {}),
  });

  // AC8.9: session-start (only) reports data behind and names `directive upgrade`.
  if (args.event === "session.start") {
    const dataStatus = readProjectDataStatus(projectRoot).dataStatus;
    if (dataStatus === "migration_needed" || dataStatus === "diagnosis_failed") {
      const base = decision.message.trim();
      decision = {
        ...decision,
        message:
          base.length > 0
            ? `${base}\n\n${SESSION_START_SCHEMA_BEHIND_NOTICE}`
            : SESSION_START_SCHEMA_BEHIND_NOTICE,
      };
    }
  }

  const rendered = renderHostDecision(args.host, decision);
  if (rendered.length > 0) writeOut(`${rendered}\n`);
  // Force-kill allow must print the non-empty reason even when host allow wire is empty (#5281).
  if (decision.code === "kill-force-ready" && decision.message.trim().length > 0) {
    writeErr(`${decision.message}\n`);
  }
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
