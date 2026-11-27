#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DirectivePosture,
  emitBypassWarning,
  emitVerifyJson,
  fillRecoveryCommandSessionId,
  formatCacheFreshDeferSoftPath,
  formatRitualRecoveryInstruction,
  occupancyAwareDenialMessage,
  resolveOccupancySessionClaim,
  resolvePresentedIdentity,
  type VerifyResult,
  verifySessionRitual,
} from "@deftai/directive-core/session";

export interface VerifySessionRitualRunDeps {
  readonly verifySessionRitual?: (
    projectRoot: string,
    options: { tier: "quick" | "gated"; posture?: DirectivePosture },
  ) => VerifyResult;
}

interface ParsedArgs {
  projectRoot: string;
  tier: "quick" | "gated";
  posture: DirectivePosture | null;
  emitJson: boolean;
  /** Presented session from `--session-id` (#7446); null when the flag is absent. */
  sessionId: string | null;
  error?: string;
}

function parsePosture(value: string): DirectivePosture | null {
  if (value === "read-only") return "read-only";
  if (value === "mutation" || value === "mutating") return "mutation";
  return null;
}

/** Parse verify-session-ritual CLI args, mirroring scripts/verify_session_ritual.py. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    tier: "quick",
    posture: null,
    emitJson: false,
    sessionId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--tier") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --tier: expected one argument" };
      }
      if (value !== "quick" && value !== "gated") {
        return { ...parsed, error: `argument --tier: invalid choice: '${value}'` };
      }
      parsed.tier = value;
      i += 1;
    } else if (arg?.startsWith("--tier=")) {
      const value = arg.slice("--tier=".length);
      if (value !== "quick" && value !== "gated") {
        return { ...parsed, error: `argument --tier: invalid choice: '${value}'` };
      }
      parsed.tier = value;
    } else if (arg === "--posture") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --posture: expected one argument" };
      }
      const posture = parsePosture(value);
      if (posture === null) {
        return {
          ...parsed,
          error: `argument --posture: invalid choice: '${value}' (expected read-only|mutation)`,
        };
      }
      parsed.posture = posture;
      i += 1;
    } else if (arg?.startsWith("--posture=")) {
      const value = arg.slice("--posture=".length);
      const posture = parsePosture(value);
      if (posture === null) {
        return {
          ...parsed,
          error: `argument --posture: invalid choice: '${value}' (expected read-only|mutation)`,
        };
      }
      parsed.posture = posture;
    } else if (arg === "--session-id") {
      const value = argv[i + 1]?.trim();
      if (value === undefined || value.length === 0) {
        return { ...parsed, error: "argument --session-id: expected one non-empty argument" };
      }
      parsed.sessionId = value;
      i += 1;
    } else if (arg?.startsWith("--session-id=")) {
      const value = arg.slice("--session-id=".length).trim();
      if (value.length === 0) {
        return { ...parsed, error: "argument --session-id: expected one non-empty argument" };
      }
      parsed.sessionId = value;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** The session the occupancy check judges: the claim's owner, else the presented id. */
function judgedSessionId(explicit: string | null, presented: string): string {
  const claim = resolveOccupancySessionClaim({
    sessionId: explicit ?? undefined,
    env: process.env,
  });
  return claim.status === "ok" && claim.sessionId.length > 0 ? claim.sessionId : presented;
}

/** Notice for a failed ritual run that presented no session identity (#7446). */
export function formatNoSessionIdentityNotice(tier: "quick" | "gated"): string {
  return (
    "No session identity was presented (no --session-id, no DEFT_SESSION_ID, and this host " +
    "published no owner), so this run could not check your session against the worktree lease. " +
    `Re-run \`deft verify:session-ritual -- --tier=${tier} --session-id=<your session id>\` ` +
    "to get recovery guidance for your own session."
  );
}

/** True when the ritual failure is the gated cache_fresh step (#3506 / #3507). */
export function isCacheFreshFailureMessage(message: string): boolean {
  return message.includes("cache_fresh") || message.includes("cache-fresh");
}

/** Run the gate and return the process exit code. */
export function run(argv: string[], deps: VerifySessionRitualRunDeps = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_session_ritual: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const verify = deps.verifySessionRitual ?? verifySessionRitual;
  const result = verify(projectRoot, {
    tier: args.tier,
    posture: args.posture ?? undefined,
  });
  const warning = emitBypassWarning(result);
  const warningNeeded = result.bypassed && result.wouldFailCode !== null;

  if (args.emitJson) {
    process.stdout.write(`${emitVerifyJson(result)}\n`);
  } else if (result.code === 0) {
    if (!warningNeeded) {
      process.stdout.write(`${result.message}\n`);
    }
  } else if (result.code === 1) {
    const recoveryTier = result.recoveryTier ?? "cold";
    const presented = resolvePresentedIdentity({
      sessionId: args.sessionId ?? undefined,
      env: process.env,
    });
    // #7446: with no presented identity the occupancy check would mint a random
    // id and call it a foreign presenter. Say what is missing instead.
    const lines =
      presented.sessionId.length === 0
        ? [
            `${result.message} ${formatRitualRecoveryInstruction(recoveryTier)}`,
            formatNoSessionIdentityNotice(args.tier),
          ]
        : [
            fillRecoveryCommandSessionId(
              occupancyAwareDenialMessage(
                projectRoot,
                result.message,
                { env: process.env, sessionId: args.sessionId ?? undefined },
                recoveryTier,
              ),
              // Name the owner the occupancy check judged, which a host-published
              // owner can override over a stale inherited DEFT_SESSION_ID.
              judgedSessionId(args.sessionId, presented.sessionId),
            ),
          ];
    if (isCacheFreshFailureMessage(result.message)) {
      lines.push(formatCacheFreshDeferSoftPath());
    }
    process.stderr.write(`${lines.join("\n")}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  if (warning.length > 0) {
    process.stderr.write(`${warning}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
