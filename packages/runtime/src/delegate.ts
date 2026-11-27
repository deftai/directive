#!/usr/bin/env node
/**
 * CLI for TOTP-armed operator delegation (#7420).
 *
 *   deft delegate enroll --confirm [--account <name>] [--replace]
 *       A person runs it at a terminal (the kept terminal mint gate: no agent
 *       or CI markers, interactive TTY, controlling terminal, --confirm and the
 *       typed phrase). Writes the TOTP secret under the user config dir,
 *       outside every repository, and prints the otpauth:// URI for a phone app.
 *   deft delegate off [--project-root <dir>]
 *       End the live delegation (anyone may end it; ending only tightens).
 *   deft delegate status [--json] [--project-root <dir>]
 *   deft delegate claude-hook [--project-root <dir>]
 *       Claude Code `UserPromptSubmit` adapter: reads the hook payload on stdin
 *       and passes only the prompt text and session id to the core arming verb.
 *       Arming is typed in chat as `deft delegate on [<ttl>] <code>`.
 *   deft delegate session-end [--project-root <dir>]
 *       Claude Code `SessionEnd` adapter: ends a delegation armed in that session.
 *
 * Strength: parity of forging effort with the terminal gate, wider blast radius
 * (one arm buys hours). The passkey (#6945 / #7046) is the upgrade that makes
 * the code unproducible by an agent. See content/docs/operator-delegation.md.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DELEGATION_DEFAULT_TTL_HOURS,
  DELEGATION_MAX_TTL_HOURS,
  endDelegation,
  generateTotpSecret,
  loadDelegationState,
  readDelegationLiveness,
  resolveDelegationSecretPath,
  resolveDelegationStoreRoot,
  totpEnrollmentUri,
  writeEnrolledSecret,
} from "@deftai/directive-core/authz";
import { extractClaudeSessionEnd, runClaudeDelegateAdapter } from "./delegate-adapter-claude.js";
import { isDirectEntrypoint } from "./entrypoint.js";
import {
  type HumanPresenceMintSeams,
  mintArgsAfterVerb,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";

/** Verb name used in messages and the kept-mint gate. */
export const DELEGATE_VERB = "delegate";

/** Enrollment verb as the kept terminal mint names it. */
export const DELEGATE_ENROLL_VERB = "delegate:enroll";

export interface DelegateSeams extends HumanPresenceMintSeams {
  readonly readStdin?: () => string;
  readonly now?: () => Date;
  readonly secretPath?: string;
  readonly storeRoot?: string;
  readonly newSecret?: () => string;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
}

type Action = "enroll" | "off" | "status" | "claude-hook" | "session-end";

interface ParsedArgs {
  readonly action: Action | null;
  readonly projectRoot: string;
  readonly confirm: boolean;
  readonly replace: boolean;
  readonly json: boolean;
  readonly account: string;
  readonly help: boolean;
  readonly error?: string;
}

const ACTIONS: readonly Action[] = ["enroll", "off", "status", "claude-hook", "session-end"];

export function delegateUsage(): string {
  return [
    "usage: deft delegate enroll --confirm [--account <name>] [--replace]",
    "       deft delegate off [--project-root <dir>]",
    "       deft delegate status [--json] [--project-root <dir>]",
    "       deft delegate claude-hook [--project-root <dir>]   (Claude UserPromptSubmit adapter; stdin)",
    "       deft delegate session-end [--project-root <dir>]   (Claude SessionEnd adapter; stdin)",
    `  Arm in chat: deft delegate on [<ttl>] <code>  (ttl default ${DELEGATION_DEFAULT_TTL_HOURS}h, max ${DELEGATION_MAX_TTL_HOURS}h)`,
    "  A live delegation completes harness-attended scope:record-approved-scope and",
    "  authz:grant --template release-cut|release-publish|release-rollback|release-promote-latest only.",
    "  Strength: parity of forging effort with the terminal gate, wider blast radius (#7420).",
  ].join("\n");
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let action: Action | null = null;
  let projectRoot = ".";
  let confirm = false;
  let replace = false;
  let json = false;
  let account = "operator";
  const base = (): ParsedArgs => ({
    action,
    projectRoot,
    confirm,
    replace,
    json,
    account,
    help: false,
  });
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...base(), help: true };
    if (arg === "--confirm") confirm = true;
    else if (arg === "--replace") replace = true;
    else if (arg === "--json") json = true;
    else if (arg === "--project-root" || arg === "--account") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...base(), error: `argument ${arg}: expected one argument` };
      if (arg === "--project-root") projectRoot = value;
      else account = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) projectRoot = arg.slice("--project-root=".length);
    else if (arg.startsWith("--account=")) account = arg.slice("--account=".length);
    else if ((ACTIONS as readonly string[]).includes(arg) && action === null)
      action = arg as Action;
    else return { ...base(), error: `unrecognized argument: ${arg}` };
  }
  if (action === null) return { ...base(), error: `missing action: ${ACTIONS.join(" | ")}` };
  return base();
}

function defaultReadStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function runEnroll(
  argv: readonly string[],
  args: ParsedArgs,
  seams: DelegateSeams,
  out: (t: string) => void,
  err: (t: string) => void,
): number {
  const projectRoot = resolve(args.projectRoot);
  const resolved = resolveHumanPresenceMintSeams(seams);
  // Kept terminal mint only: no harness-attended route, so agent markers refuse.
  const blocked = refuseNonInteractiveMint({
    verb: DELEGATE_ENROLL_VERB,
    confirm: args.confirm,
    isTty: resolved.isTty,
    environ: resolved.environ,
    hasControllingTerminal: resolved.hasControllingTerminal,
    readInteractiveConfirm: resolved.readInteractiveConfirm,
    operatorStop: {
      projectRoot,
      args: mintArgsAfterVerb(argv, "enroll"),
      record: resolved.recordOperatorStop,
    },
  });
  if (blocked !== null) return blocked;
  const secretPath = seams.secretPath ?? resolveDelegationSecretPath();
  const secretBase32 = (seams.newSecret ?? generateTotpSecret)();
  const now = (seams.now ?? (() => new Date()))();
  const wrote = writeEnrolledSecret(
    secretPath,
    {
      secretBase32,
      enrolledAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      account: args.account,
    },
    args.replace,
  );
  if (!wrote.ok) {
    err(`delegate enroll: ${wrote.reason}. Pass --replace to enroll a new secret.\n`);
    return 1;
  }
  out(
    `Enrolled a TOTP secret at ${secretPath} (outside the repository).\n` +
      "Add it to your phone authenticator app with this URI (or the secret below):\n" +
      `  ${totpEnrollmentUri(secretBase32, args.account)}\n` +
      `  secret: ${secretBase32}\n` +
      "Arm from chat with: deft delegate on [<ttl>] <code>\n" +
      "The secret is readable by any process of your OS user: arming has the same forging\n" +
      "effort as the terminal gate, with a wider blast radius (#7420).\n",
  );
  return 0;
}

function runOff(
  args: ParsedArgs,
  seams: DelegateSeams,
  out: (t: string) => void,
  err: (t: string) => void,
): number {
  const ended = endDelegation(resolve(args.projectRoot), "operator-off", {
    now: (seams.now ?? (() => new Date()))(),
    ...(seams.storeRoot !== undefined ? { storeRoot: seams.storeRoot } : {}),
  });
  if (!ended.ok) {
    err(`delegate off: ${ended.reason}\n`);
    return 1;
  }
  out(
    ended.ended
      ? `[delegated-totp] delegation ${ended.record?.delegationId ?? ""} ended (delegate off).\n`
      : "No live delegation; nothing to end.\n",
  );
  return 0;
}

function runStatus(args: ParsedArgs, seams: DelegateSeams, out: (t: string) => void): number {
  const projectRoot = resolve(args.projectRoot);
  const storeRoot = seams.storeRoot ?? resolveDelegationStoreRoot(projectRoot);
  const now = (seams.now ?? (() => new Date()))();
  const live = readDelegationLiveness(projectRoot, { now, storeRoot });
  const load = loadDelegationState(storeRoot);
  const rec = load.ok ? load.state.record : null;
  if (args.json) {
    out(
      `${JSON.stringify({ live: live.live, reason: live.live ? null : live.reason, record: rec }, null, 2)}\n`,
    );
    return 0;
  }
  if (live.live) {
    out(
      `Delegation LIVE id=${live.record.delegationId} until ${live.record.expiresAt} ` +
        `(armed ${live.record.armedAt} via ${live.record.host}, session ${live.record.hostSessionId}).\n` +
        `  allows: ${live.record.allowlist.verbs.join(", ")}; templates ${live.record.allowlist.templates.join(", ")}\n`,
    );
  } else {
    out(`Delegation not live (${live.reason}).\n`);
  }
  return 0;
}

function runClaudeHook(args: ParsedArgs, seams: DelegateSeams, out: (t: string) => void): number {
  const result = runClaudeDelegateAdapter({
    stdinText: (seams.readStdin ?? defaultReadStdin)(),
    projectRoot: resolve(args.projectRoot),
    armSeams: {
      ...(seams.now !== undefined ? { now: seams.now() } : {}),
      ...(seams.secretPath !== undefined ? { secretPath: seams.secretPath } : {}),
      ...(seams.storeRoot !== undefined ? { storeRoot: seams.storeRoot } : {}),
    },
  });
  if (result.stdout.length > 0) out(result.stdout);
  return result.exitCode;
}

function runSessionEnd(args: ParsedArgs, seams: DelegateSeams, out: (t: string) => void): number {
  const sessionId = extractClaudeSessionEnd((seams.readStdin ?? defaultReadStdin)());
  if (sessionId === null) return 0;
  const ended = endDelegation(resolve(args.projectRoot), "session-end", {
    hostSessionId: sessionId,
    now: (seams.now ?? (() => new Date()))(),
    ...(seams.storeRoot !== undefined ? { storeRoot: seams.storeRoot } : {}),
  });
  if (ended.ok && ended.ended) {
    out(`[delegated-totp] delegation ${ended.record?.delegationId ?? ""} ended (session end).\n`);
  }
  // A session-end hook never fails the host.
  return 0;
}

export function run(argv: string[], seams: DelegateSeams = {}): number {
  const out = seams.writeOut ?? ((t: string) => process.stdout.write(t));
  const err = seams.writeErr ?? ((t: string) => process.stderr.write(t));
  const args = parseArgs(argv);
  if (args.help) {
    out(`${delegateUsage()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    err(`delegate: ${args.error}\n${delegateUsage()}\n`);
    return 2;
  }
  switch (args.action) {
    case "enroll":
      return runEnroll(argv, args, seams, out, err);
    case "off":
      return runOff(args, seams, out, err);
    case "status":
      return runStatus(args, seams, out);
    case "claude-hook":
      return runClaudeHook(args, seams, out);
    case "session-end":
      return runSessionEnd(args, seams, out);
    default:
      err(`${delegateUsage()}\n`);
      return 2;
  }
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
