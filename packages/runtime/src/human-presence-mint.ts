/**
 * Shared #3110 human-presence mint gate (#3384 / #7279).
 *
 * Used by `authz` mutating verbs and `scope:record-approved-scope`. Multi-factor
 * human presence: interactive TTY + controlling terminal + `--confirm` + typed
 * phrase `mint`. Agent/CI env markers refuse fail-closed for unmarked verbs.
 * Kept-mint verbs may complete under markers via a harness-attended freeze +
 * operator-controlled confirm (controlling-TTY phrase or host-authenticated
 * user-event) without forge-by-unset (#7279). `--actor` is never an input here
 * — display only at the caller.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

/**
 * Host-authenticated user-event that may complete a frozen harness-attended
 * mint request (#7279). Must name the request id and matching authority digest;
 * the requesting agent shell cannot forge provenance.
 */
export interface HostAuthenticatedUserEvent {
  readonly requestId: string;
  readonly authorityPayloadDigest: string;
  readonly hostSessionId: string;
  readonly authenticatedAt: string;
  readonly provenance: "host-user-event";
}

/** Testable seams for TTY / agent-shell detection (#3110 / #3384 / #7279). */
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
   * Optional host-authenticated confirm for a frozen request id (#7279).
   * Default: null (no host event). Tests inject a matching event.
   */
  readonly readHostAuthenticatedConfirm?: (requestId: string) => HostAuthenticatedUserEvent | null;
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

function defaultReadHostAuthenticatedConfirm(
  _requestId: string,
): HostAuthenticatedUserEvent | null {
  return null;
}

export function resolveHumanPresenceMintSeams(
  seams: HumanPresenceMintSeams = {},
): Required<HumanPresenceMintSeams> {
  return {
    isTty: seams.isTty ?? defaultIsTty,
    environ: seams.environ ?? process.env,
    hasControllingTerminal: seams.hasControllingTerminal ?? defaultHasControllingTerminal,
    readInteractiveConfirm: seams.readInteractiveConfirm ?? defaultReadInteractiveConfirm,
    readHostAuthenticatedConfirm:
      seams.readHostAuthenticatedConfirm ?? defaultReadHostAuthenticatedConfirm,
    recordOperatorStop: seams.recordOperatorStop ?? defaultRecordOperatorStop,
  };
}

/** Inventoried kept-mint verbs eligible for harness-attended confirm (#7279 / #7031). */
export const HARNESS_ATTENDED_MINT_VERBS = [
  "scope:record-approved-scope",
  "authz:grant",
  "authz:uat-start",
  "authz:uat-suspend",
  "authz:revoke",
] as const;

export type HarnessAttendedMintVerb = (typeof HARNESS_ATTENDED_MINT_VERBS)[number];

export function isHarnessAttendedMintVerb(verb: string): verb is HarnessAttendedMintVerb {
  return (HARNESS_ATTENDED_MINT_VERBS as readonly string[]).includes(verb);
}

/** Relative store under the canonical checkout for frozen requests (#7279). */
export const HARNESS_ATTENDED_MINT_STORE_REL = ".deft/harness-attended-mint";

/** Default single-use request TTL (15 minutes). */
export const HARNESS_ATTENDED_MINT_TTL_MS = 15 * 60 * 1000;

export type HarnessAttendedMintRequestStatus = "open" | "cancelled" | "completed" | "expired";

export interface HarnessAttendedMintRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly verb: string;
  readonly projectRoot: string;
  readonly authorityPayloadDigest: string;
  readonly destinations: readonly string[];
  readonly args: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  status: HarnessAttendedMintRequestStatus;
  completedAt?: string;
  completedVia?: "controlling-tty-phrase" | "host-user-event";
}

/** Options that route a kept-mint verb through harness-attended confirm (#7279). */
export interface HarnessAttendedMintOptions {
  /** Resolved write destinations frozen into the request. */
  readonly destinations: readonly string[];
  /**
   * Chat-yes / request-open: freeze only and refuse the write. Never stamps.
   * Implied when `--confirm` is absent under agent markers.
   */
  readonly requestOpenOnly?: boolean;
  /** Complete a previously opened request; must still match the freeze. */
  readonly requestId?: string;
  readonly ttlMs?: number;
  readonly now?: () => Date;
  readonly newRequestId?: () => string;
  readonly storeRoot?: string;
}

/**
 * Drop confirm-ceremony flags from argv before freezing (#7279).
 * `--confirm` / `--request-id` are how the operator completes the request; they
 * must not change the authority payload digest between request-open and confirm.
 */
export function normalizeHarnessAttendedArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--confirm") continue;
    if (a === "--request-id" || a === "--requestId") {
      i += 1;
      continue;
    }
    if (a.startsWith("--request-id=") || a.startsWith("--requestId=")) continue;
    out.push(a);
  }
  return out;
}

/** Canonical digest over verb + checkout + destinations + argv (#7279). */
export function digestHarnessAttendedAuthorityPayload(input: {
  readonly verb: string;
  readonly projectRoot: string;
  readonly destinations: readonly string[];
  readonly args: readonly string[];
}): string {
  const body = JSON.stringify({
    verb: input.verb,
    projectRoot: input.projectRoot.replace(/\\/g, "/").replace(/\/+$/, ""),
    destinations: [...input.destinations]
      .map((d) => d.replace(/\\/g, "/").replace(/\/+$/, ""))
      .sort(),
    args: normalizeHarnessAttendedArgs(input.args),
  });
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export function harnessAttendedMintStoreRoot(projectRoot: string, storeRoot?: string): string {
  return storeRoot ?? join(projectRoot, HARNESS_ATTENDED_MINT_STORE_REL);
}

export function harnessAttendedMintRequestPath(storeRoot: string, requestId: string): string {
  const safe = requestId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(storeRoot, `${safe}.json`);
}

function defaultNewRequestId(): string {
  return randomBytes(16).toString("hex");
}

function toIsoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Open (freeze) a single-use harness-attended mint request. Never stamps. */
export function openHarnessAttendedMintRequest(input: {
  readonly verb: string;
  readonly projectRoot: string;
  readonly destinations: readonly string[];
  readonly args: readonly string[];
  readonly ttlMs?: number;
  readonly now?: () => Date;
  readonly newRequestId?: () => string;
  readonly storeRoot?: string;
}): { ok: true; request: HarnessAttendedMintRequest } | { ok: false; error: string } {
  if (!isHarnessAttendedMintVerb(input.verb)) {
    return {
      ok: false,
      error: `verb ${input.verb} is not harness-attended eligible (#7279)`,
    };
  }
  if (input.destinations.length === 0) {
    return { ok: false, error: "destinations must be non-empty for a frozen request (#7279)" };
  }
  const now = input.now ?? (() => new Date());
  const created = now();
  const ttl = input.ttlMs ?? HARNESS_ATTENDED_MINT_TTL_MS;
  const requestId = (input.newRequestId ?? defaultNewRequestId)();
  const normalizedArgs = normalizeHarnessAttendedArgs(input.args);
  const digest = digestHarnessAttendedAuthorityPayload({
    ...input,
    args: normalizedArgs,
  });
  const request: HarnessAttendedMintRequest = {
    schemaVersion: 1,
    requestId,
    verb: input.verb,
    projectRoot: input.projectRoot,
    authorityPayloadDigest: digest,
    destinations: [...input.destinations],
    args: normalizedArgs,
    createdAt: toIsoZ(created),
    expiresAt: toIsoZ(new Date(created.getTime() + ttl)),
    status: "open",
  };
  const store = harnessAttendedMintStoreRoot(input.projectRoot, input.storeRoot);
  try {
    mkdirSync(store, { recursive: true });
    writeFileSync(
      harnessAttendedMintRequestPath(store, requestId),
      `${JSON.stringify(request, null, 2)}\n`,
      "utf8",
    );
  } catch (err: unknown) {
    return { ok: false, error: `failed to persist request: ${String(err)}` };
  }
  return { ok: true, request };
}

export function loadHarnessAttendedMintRequest(
  projectRoot: string,
  requestId: string,
  storeRoot?: string,
): HarnessAttendedMintRequest | null {
  const path = harnessAttendedMintRequestPath(
    harnessAttendedMintStoreRoot(projectRoot, storeRoot),
    requestId,
  );
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as HarnessAttendedMintRequest;
    if (raw.schemaVersion !== 1 || typeof raw.requestId !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

function saveHarnessAttendedMintRequest(
  projectRoot: string,
  request: HarnessAttendedMintRequest,
  storeRoot?: string,
): void {
  const store = harnessAttendedMintStoreRoot(projectRoot, storeRoot);
  mkdirSync(store, { recursive: true });
  writeFileSync(
    harnessAttendedMintRequestPath(store, request.requestId),
    `${JSON.stringify(request, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Refresh status for expiry without completing. Returns the loaded request or
 * null when missing.
 */
export function refreshHarnessAttendedMintRequestStatus(
  projectRoot: string,
  requestId: string,
  opts: { readonly now?: () => Date; readonly storeRoot?: string } = {},
): HarnessAttendedMintRequest | null {
  const loaded = loadHarnessAttendedMintRequest(projectRoot, requestId, opts.storeRoot);
  if (loaded === null) return null;
  if (loaded.status === "open") {
    const now = opts.now ?? (() => new Date());
    if (now().getTime() > Date.parse(loaded.expiresAt)) {
      loaded.status = "expired";
      saveHarnessAttendedMintRequest(projectRoot, loaded, opts.storeRoot);
    }
  }
  return loaded;
}

function formatRequestOpenGuidance(verb: string, request: HarnessAttendedMintRequest): string {
  return (
    `${verb}: harness-attended request-open only (bare chat-yes never stamps) (#7279).\n` +
    `  requestId: ${request.requestId}\n` +
    `  authorityPayloadDigest: ${request.authorityPayloadDigest}\n` +
    `  projectRoot: ${request.projectRoot}\n` +
    `  destinations: ${request.destinations.join(" | ")}\n` +
    `  expiresAt: ${request.expiresAt}\n` +
    "  Confirm on a controlling TTY with --confirm --request-id " +
    `${request.requestId} and typed phrase '${AUTHZ_INTERACTIVE_CONFIRM_PHRASE}', ` +
    "or via a host-authenticated user-event bound to this request. " +
    "Agent-shell markers may stay set (no forge-by-unset).\n"
  );
}

/**
 * Under agent-shell markers, admit a kept-mint verb only through a frozen
 * single-use request confirmed by controlling-TTY phrase or host-authenticated
 * user-event (#7279). Markers stay set.
 */
export function admitHarnessAttendedMint(input: {
  readonly verb: string;
  readonly confirm: boolean;
  readonly projectRoot: string;
  readonly args: readonly string[];
  readonly destinations: readonly string[];
  readonly requestOpenOnly?: boolean;
  readonly requestId?: string;
  readonly ttlMs?: number;
  readonly now?: () => Date;
  readonly newRequestId?: () => string;
  readonly storeRoot?: string;
  readonly isTty: () => boolean;
  readonly hasControllingTerminal: () => boolean;
  readonly readInteractiveConfirm: () => string | null;
  readonly readHostAuthenticatedConfirm: (requestId: string) => HostAuthenticatedUserEvent | null;
  readonly environ: NodeJS.ProcessEnv;
  readonly operatorStop?: MintOperatorStopContext;
}): number | null {
  const { verb, confirm, projectRoot } = input;
  const requestOpenOnly = input.requestOpenOnly === true || !confirm;

  const expectedDigest = digestHarnessAttendedAuthorityPayload({
    verb,
    projectRoot,
    destinations: input.destinations,
    args: input.args,
  });

  let request: HarnessAttendedMintRequest;
  if (input.requestId !== undefined && input.requestId.trim().length > 0) {
    const loaded = refreshHarnessAttendedMintRequestStatus(projectRoot, input.requestId.trim(), {
      now: input.now,
      storeRoot: input.storeRoot,
    });
    if (loaded === null) {
      process.stderr.write(
        `${verb}: harness-attended request ${input.requestId.trim()} not found (#7279).\n`,
      );
      return 2;
    }
    request = loaded;
  } else {
    const opened = openHarnessAttendedMintRequest({
      verb,
      projectRoot,
      destinations: input.destinations,
      args: input.args,
      ttlMs: input.ttlMs,
      now: input.now,
      newRequestId: input.newRequestId,
      storeRoot: input.storeRoot,
    });
    if (!opened.ok) {
      process.stderr.write(`${verb}: ${opened.error}\n`);
      return 2;
    }
    request = opened.request;
  }

  if (request.verb !== verb) {
    process.stderr.write(
      `${verb}: harness-attended request ${request.requestId} verb mismatch ` +
        `(frozen=${request.verb}) (#7279).\n`,
    );
    return 2;
  }
  if (request.authorityPayloadDigest !== expectedDigest) {
    process.stderr.write(
      `${verb}: harness-attended request ${request.requestId} changed ` +
        `(authority payload or destinations no longer match freeze) (#7279).\n`,
    );
    return 2;
  }
  if (request.status === "cancelled") {
    process.stderr.write(
      `${verb}: harness-attended request ${request.requestId} was cancelled (#7279).\n`,
    );
    return 2;
  }
  if (request.status === "completed") {
    process.stderr.write(
      `${verb}: harness-attended request ${request.requestId} already completed (#7279).\n`,
    );
    return 2;
  }
  if (request.status === "expired") {
    process.stderr.write(
      `${verb}: harness-attended request ${request.requestId} expired at ${request.expiresAt} (#7279).\n`,
    );
    return 2;
  }

  if (requestOpenOnly) {
    process.stderr.write(formatRequestOpenGuidance(verb, request));
    if (input.operatorStop !== undefined) {
      const confirmArgs = [
        ...input.args.filter((a) => a !== "--confirm" && !a.startsWith("--request-id")),
        "--confirm",
        `--request-id=${request.requestId}`,
      ];
      recordMintOperatorStop(verb, input.environ, {
        ...input.operatorStop,
        args: confirmArgs,
      });
    }
    return 2;
  }

  // Confirm path: host-authenticated user-event OR controlling-TTY phrase.
  // Markers intentionally stay set (no forge-by-unset).
  const hostEvent = input.readHostAuthenticatedConfirm(request.requestId);
  if (hostEvent !== null) {
    const nowMs = (input.now ?? (() => new Date()))().getTime();
    const authMs = Date.parse(hostEvent.authenticatedAt);
    if (
      hostEvent.provenance !== "host-user-event" ||
      hostEvent.requestId !== request.requestId ||
      hostEvent.authorityPayloadDigest !== request.authorityPayloadDigest ||
      hostEvent.hostSessionId.trim().length === 0 ||
      Number.isNaN(authMs) ||
      authMs > nowMs ||
      authMs < Date.parse(request.createdAt) ||
      authMs > Date.parse(request.expiresAt)
    ) {
      process.stderr.write(
        `${verb}: host-authenticated user-event rejected for request ${request.requestId} (#7279).\n`,
      );
      return 2;
    }
    request.status = "completed";
    request.completedAt = toIsoZ(input.now?.() ?? new Date());
    request.completedVia = "host-user-event";
    saveHarnessAttendedMintRequest(projectRoot, request, input.storeRoot);
    process.stderr.write(
      `${verb}: harness-attended confirm via host-authenticated user-event ` +
        `(requestId=${request.requestId}; markers may stay set) (#7279).\n`,
    );
    return null;
  }

  if (!input.isTty()) {
    process.stderr.write(
      `${verb}: harness-attended confirm requires controlling-TTY phrase or ` +
        "host-authenticated user-event; non-TTY agent shell cannot stamp (#7279).\n",
    );
    return 2;
  }
  if (!input.hasControllingTerminal()) {
    process.stderr.write(
      `${verb}: harness-attended confirm needs a controlling terminal (or host ` +
        "user-event); open a real console without unsetting agent markers (#7279).\n",
    );
    return 2;
  }
  process.stderr.write(
    `${verb}: harness-attended request ${request.requestId} — type ` +
      `'${AUTHZ_INTERACTIVE_CONFIRM_PHRASE}' to confirm (markers may stay set) (#7279): `,
  );
  const line = input.readInteractiveConfirm();
  const phrase = (line ?? "").trim().toLowerCase();
  if (phrase !== AUTHZ_INTERACTIVE_CONFIRM_PHRASE) {
    process.stderr.write(
      `\n${verb}: interactive confirm phrase mismatch (got ${JSON.stringify(line ?? "")}). ` +
        `Type exactly '${AUTHZ_INTERACTIVE_CONFIRM_PHRASE}' on the controlling TTY (#7279).\n`,
    );
    return 2;
  }
  request.status = "completed";
  request.completedAt = toIsoZ(input.now?.() ?? new Date());
  request.completedVia = "controlling-tty-phrase";
  saveHarnessAttendedMintRequest(projectRoot, request, input.storeRoot);
  return null;
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
      args: absoluteProjectRootArgs(ctx.args, ctx.projectRoot),
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

/**
 * Replace a `--project-root` value with the resolved root, so a replay that
 * first changes into that root does not resolve a relative root twice.
 */
export function absoluteProjectRootArgs(args: readonly string[], projectRoot: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--project-root" || arg === "--projectRoot") {
      out.push(arg, projectRoot);
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      out.push(`--project-root=${projectRoot}`);
    } else {
      out.push(arg);
    }
  }
  return out;
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
 * Refuse non-interactive / agent-shell mint outside UAT (#3110 / #3384 / #7279).
 *
 * Multi-factor human-presence gate (applies only when UAT lease is inactive):
 * 1. No known agent/CI env markers — unless `harnessAttended` is supplied for an
 *    inventoried kept-mint verb, in which case confirmation is controlling-TTY
 *    phrase or host-authenticated user-event bound to a frozen request (#7279)
 * 2. Interactive TTY (stdin + stdout isTTY) — ordinary human CLI path
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
   * Optional host-authenticated confirm seam (#7279). Defaults to no event
   * when omitted; harness-attended callers pass the resolved seam.
   */
  readonly readHostAuthenticatedConfirm?: (requestId: string) => HostAuthenticatedUserEvent | null;
  /**
   * Caller context for the #6275 operator-stop record: the mint argv (after the
   * verb) and the project root. Used on agent-marker refuse and request-open.
   */
  readonly operatorStop?: MintOperatorStopContext;
  /**
   * When set for an inventoried kept-mint verb, route agent-shell markers into
   * harness-attended freeze+confirm instead of forge-by-unset (#7279).
   */
  readonly harnessAttended?: HarnessAttendedMintOptions;
}): number | null {
  const { verb, confirm } = input;
  const matchedMarkers = detectedAgentShellMarkers(input.environ);
  if (matchedMarkers.length > 0) {
    const harness = input.harnessAttended;
    if (
      harness !== undefined &&
      isHarnessAttendedMintVerb(verb) &&
      input.operatorStop !== undefined
    ) {
      return admitHarnessAttendedMint({
        verb,
        confirm,
        projectRoot: input.operatorStop.projectRoot,
        args: input.operatorStop.args,
        destinations: harness.destinations,
        requestOpenOnly: harness.requestOpenOnly,
        requestId: harness.requestId,
        ttlMs: harness.ttlMs,
        now: harness.now,
        newRequestId: harness.newRequestId,
        storeRoot: harness.storeRoot,
        isTty: input.isTty,
        hasControllingTerminal: input.hasControllingTerminal,
        readInteractiveConfirm: input.readInteractiveConfirm,
        readHostAuthenticatedConfirm:
          input.readHostAuthenticatedConfirm ?? defaultReadHostAuthenticatedConfirm,
        environ: input.environ,
        operatorStop: input.operatorStop,
      });
    }
    const named = matchedMarkers.join(", ");
    if (isHarnessAttendedMintVerb(verb)) {
      process.stderr.write(
        `${verb}: refusing operator-cli stamp from an agent/host/CI shell ` +
          `(matched agent-shell env markers: ${named}). ` +
          "Do not unset markers (forge-by-unset). Open a harness-attended request " +
          "and confirm via controlling-TTY phrase or host-authenticated user-event " +
          "bound to the frozen request (#7279 / #3110).\n",
      );
    } else {
      process.stderr.write(
        `${verb}: refusing operator-cli stamp from an agent/host/CI shell ` +
          `(matched agent-shell env markers: ${named}). Unset ${named} and retry ` +
          "from a human interactive TTY without agent-shell markers, plus --confirm " +
          "and typed phrase (#3110 / #5983).\n",
      );
    }
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
