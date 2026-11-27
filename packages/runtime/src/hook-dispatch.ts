#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { endDelegation } from "@deftai/directive-core/authz";
import { isShellTool } from "@deftai/directive-core/dist/hooks/tools.js";
import { checkCheapInSync } from "@deftai/directive-core/dist/install-health/cheap.js";
import {
  ENTRY_GUARD_MESSAGES,
  FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE,
  formatEntryGuardMessage,
  HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE,
  projectInstallCommand,
} from "@deftai/directive-core/dist/install-health/constants.js";
import { renderPinMismatchRecoveryGuidance } from "@deftai/directive-core/dist/install-health/pin-mismatch-guidance.js";
import {
  readInstalledRuntimeVersion,
  readRuntimePin,
} from "@deftai/directive-core/dist/install-health/readers.js";
import {
  admitHardRefuseNonGatedMcp,
  admitPinMismatchRecovery,
  admitRootMismatchRecovery,
} from "@deftai/directive-core/dist/install-health/recovery-admit.js";
import {
  classifyRootMismatch,
  FOREIGN_RUNTIME_LINK,
  resolveLaunchingCheckoutRootFromPath,
} from "@deftai/directive-core/dist/install-health/runtime-link.js";
import type { CheapInSyncResult } from "@deftai/directive-core/dist/install-health/types.js";
import { detectDeftDirectiveDisable } from "@deftai/directive-core/dist/policy/deft-directive-disable.js";
import {
  KILL_SWITCH_READER_FLAG,
  KILL_SWITCH_READER_VERSION,
} from "@deftai/directive-core/dist/policy/kill-switch-record.js";
import {
  decideHook,
  firstString,
  type HookDecision,
  type HookEvent,
  type HookHost,
  type HookPayloadContext,
  hookMcpArgsText,
  hookPayloadTopLevelKeys,
  hookShellCommand,
  hookToolName,
  isHookEvent,
  isHookHost,
  mergeHookDispatchEnviron,
  normalizeHookProjectRoot,
  parseHookStdin,
  projectRootFromHookPayload,
  record,
  renderHostDecision,
  runSessionEndHook,
  type SessionEndHookSeams,
  toolInputRecord,
} from "@deftai/directive-core/hooks";
import { sameRepoGitCommonDir } from "@deftai/directive-core/session";
import { readProjectDataStatus } from "./data-status.js";
import { extractClaudeSessionEnd, runClaudeDelegateAdapter } from "./delegate-adapter-claude.js";
import { maybeSelfCompleteSetup } from "./self-complete.js";

/**
 * Session-start schema-behind notice (AC8.9 / AC14.11). Doctor uses the same
 * remedy name; other hooks must stay silent about data currency.
 */
export const SESSION_START_SCHEMA_BEHIND_NOTICE = ENTRY_GUARD_MESSAGES["data-behind"];

interface ParsedArgs {
  host?: HookHost;
  event?: HookEvent;
  projectRoot?: string;
  /**
   * Kill-record reader version the outer hook passed (#6740). Compatibility
   * information only, never authority: it tells this runtime the outer reads
   * the record too. Absent for an older outer or a direct `deft hook:dispatch`.
   */
  killSwitchReader?: string;
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
   * #7351 test seam for same-repo common-dir admit. Defaults to
   * {@link sameRepoGitCommonDir}. Both roots must resolve; null never admits.
   */
  readonly sameRepoGitCommonDir?: (launchRoot: string, payloadRoot: string) => boolean;
  /**
   * #7351: when roots differ but common dirs match, true only if the launching
   * checkout's installed runtime equals the payload pin. `null` means unknown
   * (skip the cross-check). Defaults to {@link launchInstalledMatchesPayloadPin}.
   */
  readonly launchInstalledMatchesPayloadPin?: (
    launchRoot: string,
    payloadRoot: string,
  ) => boolean | null;
  /**
   * The launcher's own (link-side) script path, `process.argv[1]` by default
   * (#6185). Used only to choose the wording of a root-mismatch refusal; never
   * an admission input. Tests inject a path to simulate a junctioned runtime.
   */
  readonly launcherPath?: () => string | undefined;
  /**
   * Cheap pin/installed identity check (AC9.4 / AC14.8). Defaults to
   * `checkCheapInSync`. Injected in unit tests to force failClosed without a
   * dual fixture.
   */
  readonly cheapInSync?: (root: string) => CheapInSyncResult;
  /**
   * Kill-record check (#6620 / #6740): true only when the kill record is valid
   * for this checkout. Defaults to the core detector; injected in unit tests.
   * When injected, no kill-switch warning is printed.
   */
  readonly disableActive?: (root: string) => boolean;
  /**
   * Kill-switch state for one hook event (#6740): `active` and the one warning
   * (bare flag or invalid record) or null. Defaults to the core detector.
   */
  readonly killSwitchState?: (root: string) => {
    readonly active: boolean;
    readonly warning: string | null;
  };
  /** Strict session-end release (#6274). Injected in tests to force a throw. */
  readonly sessionEndRelease?: SessionEndHookSeams["release"];
  /** Claude prompt adapter for prompt.submit (#7420). Injected in tests to force a throw. */
  readonly delegateAdapter?: typeof runClaudeDelegateAdapter;
  /** Delegation end on session.end (#7420). Injected in tests. */
  readonly endDelegation?: typeof endDelegation;
}

/**
 * How long to re-poll stdin after an empty first read before concluding the host
 * sent nothing (#2864). Keeps well under Cursor's deposited `timeout: 5` while
 * covering short non-blocking delivery races (reporter matrix rows K/L).
 */
export const DEFAULT_STDIN_EMPTY_RETRY_MS = 250;

/** Interval between empty-stdin re-polls while the retry budget remains. */
export const STDIN_EMPTY_RETRY_INTERVAL_MS = 25;

// Moved to core install-health so doctor and session start share the cut (#6185).
export { resolveLaunchingCheckoutRootFromPath };

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

/**
 * Launch installed runtime vs payload pin (#7351). Explicit mismatch is false;
 * either side unresolved is null (caller may still admit on common-dir alone).
 */
export function launchInstalledMatchesPayloadPin(
  launchRoot: string,
  payloadRoot: string,
): boolean | null {
  const pinVersion = readRuntimePin(payloadRoot).pinVersion;
  const installedVersion = readInstalledRuntimeVersion(launchRoot);
  if (pinVersion === null || installedVersion === null) return null;
  return pinVersion === installedVersion;
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

/** Tool-input fields that name a shell call's run directory (#6313). */
export const HARD_REFUSE_NON_GATED_MCP_ALLOW_MESSAGE =
  "Warning: Directive hard-refuse admitted non-gated host MCP " +
  "(not push/merge, not write-shaped, not authz-class, not proxy). " +
  "Bash/Edit/Write and gated MCP stay refused (#7352).";

/**
 * Claude tool.before only: admit non-gated host UI MCP under hard-refuse (#7352).
 * Returns null to keep the refusal. Foreign-runtime-link never calls this.
 */
function hardRefuseNonGatedMcpAdmit(
  host: HookHost,
  event: HookEvent,
  projectRoot: string,
  payload: unknown,
): HookDecision | null {
  if (host !== "claude" || event !== "tool.before") return null;
  const toolName = hookToolName(payload, host);
  if (toolName === null) return null;
  if (
    !admitHardRefuseNonGatedMcp({
      toolName,
      mcpArgsText: hookMcpArgsText(payload),
    })
  ) {
    return null;
  }
  return {
    verdict: "allow",
    code: "shell-op-unclassifiable",
    event,
    host,
    toolName,
    projectRoot: normalizeHookProjectRoot(projectRoot),
    message: HARD_REFUSE_NON_GATED_MCP_ALLOW_MESSAGE,
    scopePath: null,
  };
}

const SHELL_RUN_DIRECTORY_FIELDS = ["workdir", "cwd", "working_directory", "workingDirectory"];

/**
 * Directories that prove where a shell tool call runs (#6313). Empty when
 * nothing proves it, so the recovery admit stays off.
 *
 * Tool-input fields come first; when any is present, every present one must be
 * a non-empty string (no fallback to the outer `cwd`). Otherwise the payload
 * `cwd` counts, except on Codex: its outer `cwd` is the session directory and
 * live captures drop `exec_command` `workdir` (#4998), so it proves nothing.
 */
function shellRunDirectories(host: HookHost, payload: unknown): string[] {
  const input = record(payload);
  if (input === null) return [];
  const toolInput = toolInputRecord(input);
  if (toolInput !== null && toolInput !== input) {
    const present = SHELL_RUN_DIRECTORY_FIELDS.filter((field) => field in toolInput);
    if (present.length > 0) {
      const values = present.map((field) => firstString([toolInput[field]]));
      return values.every((value) => value !== null) ? (values as string[]) : [];
    }
  }
  if (host === "codex") return [];
  const outer = firstString([input.cwd]);
  return outer === null ? [] : [outer];
}

/**
 * Admit the pin-mismatch refusal's own named recovery (#6313): a simple
 * recovery command through a shell tool at the project root, when pin ≠
 * installed is the only fault. Returns null to keep the refusal.
 */
function pinMismatchRecoveryAdmit(
  host: HookHost,
  event: HookEvent,
  projectRoot: string,
  payload: unknown,
  cheap: CheapInSyncResult,
): HookDecision | null {
  if (event !== "tool.before") return null;
  const toolName = hookToolName(payload, host);
  const runDirectories = shellRunDirectories(host, payload);
  const admitted = admitPinMismatchRecovery({
    cheap,
    shellTool: toolName !== null && isShellTool(toolName),
    command: hookShellCommand(payload),
    atProjectRoot:
      runDirectories.length > 0 &&
      runDirectories.every((dir) => rootsMatch(normalizeHookProjectRoot(dir), projectRoot)),
  });
  if (admitted === null) return null;
  return {
    verdict: "allow",
    code: "shell-op-ready",
    event,
    host,
    toolName,
    projectRoot: normalizeHookProjectRoot(projectRoot),
    message:
      `Directive hook admitted the pin-mismatch recovery \`${admitted}\` ` +
      `(pin=${cheap.pinVersion ?? "?"} installed=${cheap.installedVersion ?? "?"}). ` +
      "Other commands stay refused until the install matches the pin.",
    scopePath: null,
  };
}

/**
 * Admit the root-mismatch refusal's own named recovery (#6599): an exact simple
 * diagnostic or host-hook disable command through a shell tool. No setup, no
 * policy dispatch. Returns null to keep the refusal.
 */
function rootMismatchRecoveryAdmit(
  host: HookHost,
  event: HookEvent,
  projectRoot: string,
  payload: unknown,
): HookDecision | null {
  if (event !== "tool.before") return null;
  const toolName = hookToolName(payload, host);
  const admitted = admitRootMismatchRecovery({
    shellTool: toolName !== null && isShellTool(toolName),
    command: hookShellCommand(payload),
    host,
  });
  if (admitted === null) return null;
  return {
    verdict: "allow",
    code: "shell-op-ready",
    event,
    host,
    toolName,
    projectRoot: normalizeHookProjectRoot(projectRoot),
    message:
      `Directive hook admitted the root-mismatch recovery \`${admitted}\`. ` +
      "Other commands stay refused until the session root matches the launching checkout.",
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
    if (token === KILL_SWITCH_READER_FLAG || token?.startsWith(`${KILL_SWITCH_READER_FLAG}=`)) {
      const taken = takeValue(argv, i, KILL_SWITCH_READER_FLAG);
      if (taken.error) return { error: taken.error };
      if (taken.value !== KILL_SWITCH_READER_VERSION) {
        return {
          error: `unsupported kill-switch reader: ${JSON.stringify(taken.value)} (this runtime reads ${KILL_SWITCH_READER_VERSION})`,
        };
      }
      parsed.killSwitchReader = taken.value;
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
/**
 * Kill-switch state for one hook event (#6740). Prints the one warning (bare
 * flag or invalid record) to stderr and returns whether the record is valid.
 */
function killSwitchForEvent(
  projectRoot: string,
  seams: HookDispatchCliSeams,
  writeErr: (text: string) => void,
): boolean {
  if (seams.killSwitchState === undefined && seams.disableActive !== undefined) {
    return seams.disableActive(projectRoot);
  }
  const state = (seams.killSwitchState ?? detectDeftDirectiveDisable)(projectRoot);
  if (state.warning !== null)
    writeErr(`${state.warning}
`);
  return state.active;
}

/** session.end CLI path (#6274): every failure is one stderr line; exit 0 always. */
function runSessionEnd(
  host: HookHost,
  projectRootArg: string | undefined,
  seams: HookDispatchCliSeams,
  writeErr: (text: string) => void,
): number {
  try {
    const readOnce = seams.readStdin ?? (() => readFileSync(0, "utf8"));
    const rawStdin = readStdinHardened(readOnce, {
      emptyRetryMs: seams.stdinEmptyRetryMs,
      sleepMs: seams.sleepMs,
      nowMs: seams.nowMs,
    });
    const cwd = (seams.cwd ?? process.cwd)();
    const { payload } = parsePayload(rawStdin);
    const projectRoot = normalizeHookProjectRoot(
      projectRootArg ? resolve(projectRootArg) : projectRootFromHookPayload(payload, cwd),
    );
    killSwitchForEvent(projectRoot, seams, writeErr);
    const launchRoot = (seams.launchingCheckoutRoot ?? resolveLaunchingCheckoutRoot)();
    // #7351: same-repo linked worktree sessions must release; map launch→payload
    // when common dirs match so runSessionEndHook's path equality admits, while
    // cross-repo mismatch and owner-only release stay unchanged.
    let effectiveLaunchRoot = launchRoot;
    if (launchRoot !== null && !rootsMatch(launchRoot, projectRoot)) {
      const sameRepo = (seams.sameRepoGitCommonDir ?? sameRepoGitCommonDir)(
        launchRoot,
        projectRoot,
      );
      if (sameRepo) effectiveLaunchRoot = projectRoot;
    }
    const ended = runSessionEndHook(
      { host, projectRoot, payload, environ: process.env, launchRoot: effectiveLaunchRoot },
      {
        ...(seams.cheapInSync !== undefined ? { cheapInSync: seams.cheapInSync } : {}),
        ...(seams.sessionEndRelease !== undefined ? { release: seams.sessionEndRelease } : {}),
      },
    );
    writeErr(`${ended.diagnostic}\n`);
    // #7420: best effort; shutdown never fails on the delegation end.
    if (host === "claude") {
      try {
        const sid = extractClaudeSessionEnd(rawStdin);
        if (sid !== null) {
          (seams.endDelegation ?? endDelegation)(projectRoot, "session-end", {
            hostSessionId: sid,
          });
        }
      } catch {
        /* never fail shutdown */
      }
    }
  } catch (cause) {
    try {
      const detail = String(cause).replace(/\s+/g, " ").slice(0, 300);
      writeErr(`Directive session end: failed on its non-blocking path: ${detail}\n`);
    } catch {
      /* never fail shutdown */
    }
  }
  return 0;
}

/**
 * prompt.submit CLI path (#7420): no policy dispatch, no setup completion. Only
 * the Claude host reads the arm prompt; every failure is one stderr line; exit
 * 0 always so a prompt is never blocked.
 */
function runPromptSubmit(
  host: HookHost,
  projectRootArg: string | undefined,
  seams: HookDispatchCliSeams,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): number {
  try {
    const readOnce = seams.readStdin ?? (() => readFileSync(0, "utf8"));
    const rawStdin = readStdinHardened(readOnce, {
      emptyRetryMs: seams.stdinEmptyRetryMs,
      sleepMs: seams.sleepMs,
      nowMs: seams.nowMs,
    });
    const cwd = (seams.cwd ?? process.cwd)();
    const { payload } = parsePayload(rawStdin);
    const projectRoot = normalizeHookProjectRoot(
      projectRootArg ? resolve(projectRootArg) : projectRootFromHookPayload(payload, cwd),
    );
    if (killSwitchForEvent(projectRoot, seams, writeErr)) return 0;
    if (host !== "claude") return 0;
    const result = (seams.delegateAdapter ?? runClaudeDelegateAdapter)({
      stdinText: rawStdin,
      projectRoot,
    });
    if (result.stdout.length > 0) writeOut(result.stdout);
  } catch (cause) {
    try {
      const detail = String(cause).replace(/\s+/g, " ").slice(0, 300);
      writeErr(`Directive prompt submit: failed on its non-blocking path: ${detail}\n`);
    } catch {
      /* never fail a prompt */
    }
  }
  return 0;
}

export function run(argv: string[], seams: HookDispatchCliSeams = {}): number {
  const args = parseArgs(argv);
  const writeOut = seams.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = seams.writeErr ?? ((text: string) => process.stderr.write(text));
  if (args.error !== undefined || args.host === undefined || args.event === undefined) {
    writeErr(`${args.error ?? "invalid hook-dispatch arguments"}\n`);
    return 2;
  }

  // #6274: session.end has its own path, before any stdin/root work can throw.
  // Launch-root and pin checks stay inside runSessionEndHook (a mismatch
  // releases nothing); setup completion and policy dispatch are skipped; one
  // bounded stderr line; exit 0 always. Stdout stays empty: Claude Code
  // SessionEnd hooks have no decision control.
  if (args.event === "session.end") {
    return runSessionEnd(args.host, args.projectRoot, seams, writeErr);
  }

  // #7420: the delegation arm prompt has its own path and never blocks.
  if (args.event === "prompt.submit" && args.host === "claude") {
    return runPromptSubmit(args.host, args.projectRoot, seams, writeOut, writeErr);
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

  // #6620 / AC9.12 step 1: the kill record comes before every install check
  // (#6740: a bare flag file turns nothing off and prints one warning). Skip
  // the root, pin and setup steps; decideHook returns the disabled allow (the
  // decision itself stays in the dispatcher).
  const disabled = killSwitchForEvent(projectRoot, seams, writeErr);

  // Wave 2k / AC9.4+AC9.5: payload project root must match the checkout that
  // owns the running hook-bin. Mismatch → fail closed (no setup, no policy).
  const launchRoot = disabled
    ? null
    : (seams.launchingCheckoutRoot ?? resolveLaunchingCheckoutRoot)();
  if (launchRoot !== null && !rootsMatch(launchRoot, projectRoot)) {
    const payloadRootText = normalizeHookProjectRoot(projectRoot);
    const launchRootText = normalizeHookProjectRoot(launchRoot);
    // #6185: wording only. The link-side path never admits anything — including
    // when launch and payload share a git common dir (#7351 keep foreign deny).
    const foreign =
      classifyRootMismatch(
        launchRoot,
        seams.launcherPath ? seams.launcherPath() : process.argv[1],
        projectRoot,
      ) === FOREIGN_RUNTIME_LINK;
    if (foreign) {
      const message =
        `Directive hook refuse (${FOREIGN_RUNTIME_LINK}): this checkout's Directive runtime is linked in from another checkout ` +
        `(payloadRoot=${payloadRootText} launchRoot=${launchRootText}). ` +
        `Recovery: ${FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE.replaceAll("<payloadRoot>", payloadRootText)}`;
      const decision = installationIdentityDeny(args.host, args.event, projectRoot, message);
      const rendered = renderHostDecision(args.host, decision);
      if (rendered.length > 0) writeOut(`${rendered}\n`);
      return 0;
    }
    // #7351: same-repo linked worktree admit — matching gitCommonDir before path refuse
    const sameRepo = (seams.sameRepoGitCommonDir ?? sameRepoGitCommonDir)(launchRoot, projectRoot);
    if (!sameRepo) {
      // #6599: admit the refusal's own named recovery; the foreign branch never does.
      const admit = rootMismatchRecoveryAdmit(args.host, args.event, projectRoot, payload);
      if (admit !== null) {
        const renderedAdmit = renderHostDecision(args.host, admit);
        if (renderedAdmit.length > 0) writeOut(`${renderedAdmit}\n`);
        return 0;
      }
      // #7352: Claude host UI MCP under local root-mismatch hard-refuse.
      const mcpAdmit = hardRefuseNonGatedMcpAdmit(args.host, args.event, projectRoot, payload);
      if (mcpAdmit !== null) {
        const renderedAdmit = renderHostDecision(args.host, mcpAdmit);
        if (renderedAdmit.length > 0) writeOut(`${renderedAdmit}\n`);
        return 0;
      }
      const message =
        `Directive hook refuse: payload project root does not match the launching checkout ` +
        `(payloadRoot=${payloadRootText} ` +
        `launchRoot=${launchRootText}). Recovery: ${HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE}`;
      const decision = installationIdentityDeny(args.host, args.event, projectRoot, message);
      const rendered = renderHostDecision(args.host, decision);
      if (rendered.length > 0) writeOut(`${rendered}\n`);
      return 0;
    }
    // #7351: launch overlay must refuse before same-repo admit (versions may still match).
    const launchCheap = (seams.cheapInSync ?? checkCheapInSync)(launchRoot);
    if (launchCheap.failClosed === true && launchCheap.pinMismatchOnly !== true) {
      const mcpAdmit = hardRefuseNonGatedMcpAdmit(args.host, args.event, projectRoot, payload);
      if (mcpAdmit !== null) {
        const renderedAdmit = renderHostDecision(args.host, mcpAdmit);
        if (renderedAdmit.length > 0) writeOut(`${renderedAdmit}\n`);
        return 0;
      }
      const cheapRecovery = launchCheap.recoveryGuidance ?? ENTRY_GUARD_MESSAGES.overlay;
      const message =
        `Directive hook refuse: launching checkout has a materialize-runtime overlay; ` +
        `same-repo linked worktrees cannot use that runtime ` +
        `(payloadRoot=${payloadRootText} launchRoot=${launchRootText} ` +
        `pin=${launchCheap.pinVersion ?? "?"} installed=${launchCheap.installedVersion ?? "?"}). ` +
        `Recovery: ${cheapRecovery}`;
      const decision = installationIdentityDeny(args.host, args.event, projectRoot, message);
      const rendered = renderHostDecision(args.host, decision);
      if (rendered.length > 0) writeOut(`${rendered}\n`);
      return 0;
    }
    // #7351: when roots differ, the running launch install must match the payload pin
    // so version A cannot serve a worktree pinned/installed at B.
    const pinMatch = (seams.launchInstalledMatchesPayloadPin ?? launchInstalledMatchesPayloadPin)(
      launchRoot,
      projectRoot,
    );
    if (pinMatch === false) {
      // Honor payload overlay / non-pin fail-closed before any launch-install admit (#7351).
      const payloadCheap = (seams.cheapInSync ?? checkCheapInSync)(projectRoot);
      const overlayBlocks =
        payloadCheap.failClosed === true && payloadCheap.pinMismatchOnly !== true;
      if (!overlayBlocks) {
        const payloadPin = readRuntimePin(projectRoot).pinVersion ?? "?";
        const launchInstalled = readInstalledRuntimeVersion(launchRoot) ?? "?";
        // Recovery must clear the launching runtime (or rebind launch→payload). Payload-only
        // install leaves launch at A and cannot clear this refuse; admit install at launchRoot.
        const launchInstall = projectInstallCommand(launchRoot);
        const cheapLaunch: CheapInSyncResult = {
          ok: false,
          pinVersion: payloadPin === "?" ? null : payloadPin,
          installedVersion: launchInstalled === "?" ? null : launchInstalled,
          identityMatch: false,
          readinessValid: false,
          failClosed: true,
          pinMismatchOnly: true,
          allowSetup: false,
          recoveryGuidance: launchInstall,
        };
        if (args.event === "tool.before") {
          const toolName = hookToolName(payload, args.host);
          const runDirectories = shellRunDirectories(args.host, payload);
          const atLaunchRoot =
            runDirectories.length > 0 &&
            runDirectories.every((dir) => rootsMatch(normalizeHookProjectRoot(dir), launchRoot));
          const admitted = admitPinMismatchRecovery({
            cheap: cheapLaunch,
            shellTool: toolName !== null && isShellTool(toolName),
            command: hookShellCommand(payload),
            atProjectRoot: atLaunchRoot,
          });
          if (admitted !== null) {
            const decision: HookDecision = {
              verdict: "allow",
              code: "shell-op-ready",
              event: args.event,
              host: args.host,
              toolName,
              projectRoot: payloadRootText,
              message:
                `Directive hook admitted the launch-runtime recovery \`${admitted}\` ` +
                `(payloadPin=${payloadPin} launchInstalled=${launchInstalled}). ` +
                "Other commands stay refused until the launching checkout matches the payload pin " +
                "or the host session is relaunched from the payload worktree.",
              scopePath: null,
            };
            const renderedAdmit = renderHostDecision(args.host, decision);
            if (renderedAdmit.length > 0) writeOut(`${renderedAdmit}\n`);
            return 0;
          }
        }
        const message =
          `Directive hook refuse: launching checkout runtime does not match payload pin ` +
          `(payloadRoot=${payloadRootText} launchRoot=${launchRootText} ` +
          `payloadPin=${payloadPin} launchInstalled=${launchInstalled}). ` +
          `Recovery: in the launching checkout run \`${launchInstall}\`, or relaunch the host ` +
          `session from the payload worktree so launchRoot matches payloadRoot.`;
        const decision = installationIdentityDeny(args.host, args.event, projectRoot, message);
        const rendered = renderHostDecision(args.host, decision);
        if (rendered.length > 0) writeOut(`${rendered}\n`);
        return 0;
      }
      // overlayBlocks: fall through to the normal cheap fail-closed path below.
    }
  }

  // Wave 2k / AC9.4+AC14.8: pin≠installed → fail closed before policy.
  // #6013/#5893: pin≠installed recovery names project PM install (not AC9.7).
  // #5910: overlay-present also fail-closes (even when versions match); recovery
  // names frozen-lockfile restore then overlay retirement.
  const cheap = disabled ? null : (seams.cheapInSync ?? checkCheapInSync)(projectRoot);
  if (cheap?.failClosed === true) {
    // #6313: admit the refusal's own named recovery when pin ≠ installed is the
    // only fault; no setup and no policy dispatch on this path either.
    const admit = pinMismatchRecoveryAdmit(args.host, args.event, projectRoot, payload, cheap);
    if (admit !== null) {
      const rendered = renderHostDecision(args.host, admit);
      if (rendered.length > 0) writeOut(`${rendered}\n`);
      return 0;
    }
    // #7352: Claude host UI MCP under pin/overlay hard-refuse.
    const mcpAdmit = hardRefuseNonGatedMcpAdmit(args.host, args.event, projectRoot, payload);
    if (mcpAdmit !== null) {
      const rendered = renderHostDecision(args.host, mcpAdmit);
      if (rendered.length > 0) writeOut(`${rendered}\n`);
      return 0;
    }
    // #6620: a version mismatch gets the `pin-mismatch` row (install named by
    // lockfile, one the admit above lets through). As the only fault it adds
    // #6375's root-specific lines; otherwise the cheap check's own recovery
    // (the overlay row). Matching versions mean the overlay alone.
    const pinRow = formatEntryGuardMessage("pin-mismatch", {
      install: projectInstallCommand(projectRoot),
      pin: cheap.pinVersion ?? "?",
      installed: cheap.installedVersion ?? "?",
    });
    const cheapRecovery = cheap.recoveryGuidance ?? ENTRY_GUARD_MESSAGES.overlay;
    const message =
      cheap.pinMismatchOnly === true
        ? `${pinRow}\n${renderPinMismatchRecoveryGuidance(projectRoot)}`
        : cheap.identityMatch
          ? `Directive hook refuse: materialize-runtime overlay is present; identity cannot pass until the overlay is retired after exact restore ` +
            `(pin=${cheap.pinVersion ?? "?"} installed=${cheap.installedVersion ?? "?"}). ` +
            `Recovery: ${cheapRecovery}`
          : `${pinRow}\nRecovery: ${cheapRecovery}`;
    const decision = installationIdentityDeny(args.host, args.event, projectRoot, message);
    const rendered = renderHostDecision(args.host, decision);
    if (rendered.length > 0) writeOut(`${rendered}\n`);
    return 0;
  }

  // Wave 2d / AC8.6: registered hooks self-complete when readiness is missing/stale.
  // Suppressed when DEFT_DOCTOR_HOOK_DIAGNOSTIC is set (AC9.10).
  // #5885: thread seams.writeErr so preserved tracked hooks disclose on stderr.
  if (!disabled) maybeSelfCompleteSetup(projectRoot, { fromHook: true, writeErr });
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
  if (args.event === "session.start" && !disabled) {
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
