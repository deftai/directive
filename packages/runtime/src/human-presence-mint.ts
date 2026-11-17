/**
 * Shared #3110 human-presence mint gate (#3384).
 *
 * Used by `authz` mutating verbs and `scope:record-approved-scope`. Multi-factor
 * human presence: interactive TTY + controlling terminal + `--confirm` + typed
 * phrase `mint`. Agent/CI env markers refuse fail-closed. `--actor` is never
 * an input here — display only at the caller.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { loadAuthzState } from "@deftai/directive-core/authz";
import {
  formatOperatorCommand,
  type OperatorStopInput,
  recordOperatorStop,
} from "@deftai/directive-core/escalation";

/**
 * Env markers that indicate an agent/host/CI shell even when stdin reports a TTY
 * (pseudo-terminal residual; #3110 Greptile). Presence refuses mint.
 * Expanded for dogfood conf 5/5 — markers are fail-closed (any non-empty value).
 */
export const AUTHZ_AGENT_SHELL_ENV_MARKERS = [
  // Coding agents / IDEs
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_SESSION_ID",
  "AIDER",
  "CONTINUE_CLI",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "OPENAI_CODEX",
  // Grok Build shell markers (#5983 Prefer-A Recut-2): exact names only, both unconditional.
  "GROK_AGENT",
  "GROK_SESSION_ID",
  "OPENCLAW",
  "OPENCLAW_STATE_DIR",
  "DEFT_PROBE_OPENCLAW",
  "DEFT_HOOK_HOST",
  "DEFT_AGENT_SHELL",
  "DEFT_AGENT_RUNTIME",
  "WARP_SESSION_ID",
  "WARP_HARNESS",
  "WARP_RUN_ID",
  "GEMINI_CLI",
  "AMP_CLI",
  "SWARM_AGENT",
  "AI_AGENT",
  // CI / automation (never a human interactive operator mint)
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "BUILDKITE",
  "TRAVIS",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "APPVEYOR",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
] as const;

/** Phrase an operator must type on the controlling TTY after --confirm (#3110). */
export const AUTHZ_INTERACTIVE_CONFIRM_PHRASE = "mint";

/** Testable seams for TTY / agent-shell detection (#3110 / #3384). */
export interface HumanPresenceMintSeams {
  /**
   * When true, interactive human TTY is present.
   * Default: both stdin and stdout report isTTY (pseudo-TTY residual; #3110).
   */
  readonly isTty?: () => boolean;
  /** Environ for agent-shell marker detection (default: process.env). */
  readonly environ?: NodeJS.ProcessEnv;
  /**
   * True when a controlling terminal device is available (`/dev/tty` or `\\.\CONIN$`).
   * Default: open/close the platform controlling terminal (fail-closed on error).
   */
  readonly hasControllingTerminal?: () => boolean;
  /**
   * Read one interactive confirmation line from the operator (trimmed).
   * Default: one line from the controlling terminal. Tests inject a fixed phrase.
   */
  readonly readInteractiveConfirm?: () => string | null;
  /**
   * Recorder for an agent-refused mint (#6275). Default: core
   * `recordOperatorStop`, which writes nothing while the notifier is off.
   */
  readonly recordOperatorStop?: (input: OperatorStopInput) => void;
}

function defaultRecordOperatorStop(input: OperatorStopInput): void {
  recordOperatorStop(input);
}

/**
 * Matching agent/CI shell marker keys in AUTHZ_AGENT_SHELL_ENV_MARKERS order.
 * Blank or whitespace-only values do not match (return []).
 */
export function detectedAgentShellMarkers(environ: NodeJS.ProcessEnv): string[] {
  const matched: string[] = [];
  for (const key of AUTHZ_AGENT_SHELL_ENV_MARKERS) {
    const v = environ[key];
    if (v !== undefined && String(v).trim().length > 0) matched.push(key);
  }
  return matched;
}

export function looksLikeAgentShell(environ: NodeJS.ProcessEnv): boolean {
  return detectedAgentShellMarkers(environ).length > 0;
}

function defaultIsTty(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Platform controlling-terminal path (`\\.\CONIN$` on win32, `/dev/tty` elsewhere). */
export function controllingTerminalPath(platform: NodeJS.Platform = process.platform): string {
  // Real-console diagnostic on #3596: bare CONIN$ and CON ENOENT; device-namespace path opens.
  return platform === "win32" ? "\\\\.\\CONIN$" : "/dev/tty";
}

/**
 * Open flag for the platform controlling-terminal device (#3596 leftover).
 *
 * Win32 stays `r+` so the probe and phrase-read share one flag. The leftover
 * path is the Windows device-namespace CONIN$ string, not bare CONIN$.
 */
export function controllingTerminalOpenFlag(
  platform: NodeJS.Platform = process.platform,
): "r" | "r+" {
  return platform === "win32" ? "r+" : "r";
}

function defaultHasControllingTerminal(): boolean {
  try {
    const fd = openSync(controllingTerminalPath(), controllingTerminalOpenFlag());
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function defaultReadInteractiveConfirm(): string | null {
  // Read from the controlling terminal device — not redirected/piped stdin —
  // so agent-controlled stdin alone cannot supply the confirm phrase (#3110).
  let fd: number | null = null;
  try {
    fd = openSync(controllingTerminalPath(), controllingTerminalOpenFlag());
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n <= 0) return null;
    return buf.subarray(0, n).toString("utf8").trim();
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function resolveHumanPresenceMintSeams(
  seams: HumanPresenceMintSeams = {},
): Required<HumanPresenceMintSeams> {
  return {
    isTty: seams.isTty ?? defaultIsTty,
    environ: seams.environ ?? process.env,
    hasControllingTerminal: seams.hasControllingTerminal ?? defaultHasControllingTerminal,
    readInteractiveConfirm: seams.readInteractiveConfirm ?? defaultReadInteractiveConfirm,
    recordOperatorStop: seams.recordOperatorStop ?? defaultRecordOperatorStop,
  };
}

/** Active UAT campaign id, or null when no lease is active. */
export function activeUatCampaignId(projectRoot: string): string | null {
  const state = loadAuthzState(projectRoot);
  if (state.uat === null || !state.uat.active) return null;
  return state.uat.campaignId;
}

/**
 * While any UAT lease is active, refuse mint (#3110 / #3384).
 *
 * No multi-factor escape: TTY, `--confirm`, and typed phrase never authorize.
 * Returns an exit code when blocked, or null when mint may continue.
 */
export function refuseMintWhileUatActive(verb: string, projectRoot: string): number | null {
  const campaignId = activeUatCampaignId(projectRoot);
  if (campaignId === null) return null;
  process.stderr.write(
    `${verb}: refusing mint while UAT lease is ACTIVE (campaign=${campaignId}). ` +
      "Under active UAT, mint is hard-refused — no TTY, --confirm, or phrase path " +
      "authorizes remint (#3110 / #3384). Mint before uat-start; clear the lease " +
      "out-of-band to end UAT.\n",
  );
  return 2;
}

/** Caller context for recording an agent-refused mint as an operator stop (#6275). */
export interface MintOperatorStopContext {
  readonly projectRoot: string;
  /** Mint argv after the verb (flags and values). */
  readonly args: readonly string[];
  /** Test seam: recorder (default: core `recordOperatorStop`). */
  readonly record?: (input: OperatorStopInput) => void;
}

/**
 * Record an agent-marker mint refusal as an operator-only stop with the exact
 * command (#6275). Writes nothing while the notifier is off; never throws.
 */
export function recordMintOperatorStop(
  verb: string,
  environ: NodeJS.ProcessEnv,
  ctx: MintOperatorStopContext,
): void {
  try {
    const command = formatOperatorCommand({
      projectRoot: ctx.projectRoot,
      verb,
      args: ctx.args,
      confirm: true,
    });
    const record = ctx.record ?? defaultRecordOperatorStop;
    record({
      projectRoot: ctx.projectRoot,
      kind: "mint",
      code: "mint-refused-agent-shell",
      target: command,
      sessionId: environ.DEFT_SESSION_ID ?? null,
      title: `Operator mint needed: ${verb}`,
      commands: [command],
      contextRefs: [verb],
    });
  } catch {
    // Recording never changes the refusal.
  }
}

/** Strip a leading `--` separator and the subcommand token from mint argv. */
export function mintArgsAfterVerb(argv: readonly string[], subcommand: string | null): string[] {
  const args = [...argv];
  while (args[0] === "--") args.shift();
  if (subcommand !== null && args[0] === subcommand) args.shift();
  while (args[0] === "--") args.shift();
  return args;
}

/**
 * Refuse non-interactive / agent-shell mint outside UAT (#3110 / #3384).
 *
 * Multi-factor human-presence gate (applies only when UAT lease is inactive):
 * 1. No known agent/CI env markers
 * 2. Interactive TTY (stdin + stdout isTTY)
 * 3. Controlling terminal device present (`/dev/tty` / `\\.\CONIN$`)
 * 4. Explicit argv `--confirm` (flag alone never enough)
 * 5. Interactive typed phrase `mint` (argv --confirm alone never enough even on PTY)
 *
 * Fail-closed: if a real human interactive path cannot be proven, refuse mint.
 * Returns an exit code when blocked, or null when the mutation may proceed.
 */
export function refuseNonInteractiveMint(input: {
  readonly verb: string;
  readonly confirm: boolean;
  readonly isTty: () => boolean;
  readonly environ: NodeJS.ProcessEnv;
  readonly hasControllingTerminal: () => boolean;
  readonly readInteractiveConfirm: () => string | null;
  /**
   * Caller context for the #6275 operator-stop record: the mint argv (after the
   * verb) and the project root. Used only on the agent-marker branch.
   */
  readonly operatorStop?: MintOperatorStopContext;
}): number | null {
  const { verb, confirm } = input;
  const matchedMarkers = detectedAgentShellMarkers(input.environ);
  if (matchedMarkers.length > 0) {
    const named = matchedMarkers.join(", ");
    process.stderr.write(
      `${verb}: refusing operator-cli stamp from an agent/host/CI shell ` +
        `(matched agent-shell env markers: ${named}). Unset ${named} and retry ` +
        "from a human interactive TTY without agent-shell markers, plus --confirm " +
        "and typed phrase (#3110 / #5983).\n",
    );
    if (input.operatorStop !== undefined) {
      recordMintOperatorStop(verb, input.environ, input.operatorStop);
    }
    return 2;
  }
  const tty = input.isTty();
  if (!tty && !confirm) {
    process.stderr.write(
      `${verb}: refusing non-interactive operator-cli stamp. ` +
        "Mint requires interactive TTY, --confirm, and typed phrase " +
        `'${AUTHZ_INTERACTIVE_CONFIRM_PHRASE}' (#3110).\n`,
    );
    return 2;
  }
  if (!tty) {
    process.stderr.write(
      `${verb}: refusing non-TTY operator-cli stamp. ` +
        "--confirm alone never authorizes mint — interactive TTY is required (#3110).\n",
    );
    return 2;
  }
  if (!confirm) {
    process.stderr.write(
      `${verb}: refusing operator-cli stamp without --confirm. ` +
        "Interactive TTY alone never authorizes mint — pass --confirm explicitly (#3110).\n",
    );
    return 2;
  }
  if (!input.hasControllingTerminal()) {
    process.stderr.write(
      `${verb}: refusing operator-cli stamp without a controlling terminal. ` +
        "Open a real interactive console (not a headless/agent pipe) to mint (#3110).\n",
    );
    return 2;
  }
  process.stderr.write(
    `${verb}: type '${AUTHZ_INTERACTIVE_CONFIRM_PHRASE}' and press Enter to confirm operator mint: `,
  );
  const line = input.readInteractiveConfirm();
  const phrase = (line ?? "").trim().toLowerCase();
  if (phrase !== AUTHZ_INTERACTIVE_CONFIRM_PHRASE) {
    process.stderr.write(
      `\n${verb}: interactive confirm phrase mismatch (got ${JSON.stringify(line ?? "")}). ` +
        `Type exactly '${AUTHZ_INTERACTIVE_CONFIRM_PHRASE}' on the controlling TTY (#3110).\n`,
    );
    return 2;
  }
  return null;
}
