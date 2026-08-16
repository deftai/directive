/**
 * Apply product-oracle integrity to verify:ac (#3322).
 *
 * Missing run-summary is a no-op (no evidence). A flagged
 * fail → method-change → pass without independent_rederivation fails closed.
 * Stdout dest (`DEFT_RUN_SUMMARY_PATH=-`) evaluates the same-process
 * attempts just emitted by this verify:ac — it does not treat non-file
 * dest as no evidence.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LiteralAcceptanceRunResult } from "../literal-acceptance/types.js";
import {
  parseRunSummaryJsonl,
  RunSummaryEmitter,
  resolveRunSummaryDestination,
} from "../run-summary/index.js";
import {
  type FlaggedMethodChangePass,
  flagPassAfterFailWithMethodChange,
  readVerificationAttempts,
  unresolvedMethodChangePasses,
} from "./flag.js";

export interface EvaluateProductOracleIntegrityOptions {
  readonly projectRoot: string;
  /** Injected JSONL (tests). Undefined → read dest; null → empty. */
  readonly runSummaryText?: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProductOracleIntegrityVerdict {
  readonly ok: boolean;
  readonly code: 0 | 1;
  readonly flagged: readonly FlaggedMethodChangePass[];
  readonly unresolved: readonly FlaggedMethodChangePass[];
  readonly message: string;
}

export interface OracleIntegrityResultFields {
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
}

function formatUnresolved(flag: FlaggedMethodChangePass): string {
  const delta =
    typeof flag.resolved_command_count_delta === "number"
      ? ` command_count_delta=${flag.resolved_command_count_delta}`
      : "";
  return (
    `check_id=${flag.check_id} fail method=${flag.failed_method} ` +
    `then pass method=${flag.passed_method} without independent re-derivation${delta}`
  );
}

/**
 * Walk-level method fingerprint: command list + cwd hash (#3397 / #3322).
 * Same shape for fail and pass so an honest product fix does not flag.
 */
export function methodFingerprintForWalk(commands: readonly string[], cwd: string): string {
  const cwdHash = createHash("sha256").update(cwd, "utf8").digest("hex");
  return `${commands.join("\0")}\0${cwdHash}`;
}

/** Stable prefix for product-oracle check ids emitted by verify:ac (#3322 / #3337). */
export const VERIFY_AC_CHECK_ID_PREFIX = "verify:ac";

/**
 * Namespace product-oracle check_id per active scope (#3337).
 *
 * Same-session multi-active verify:ac must not pair fail/pass across briefs.
 * Prefer plan.id or xBRIEF path as scopeKey; empty → global fallback `verify:ac`
 * (unknown-scope single-brief / tests without a plan).
 */
export function verifyAcCheckId(scopeKey?: string | null): string {
  const key = typeof scopeKey === "string" ? scopeKey.trim() : "";
  if (key.length === 0) {
    return VERIFY_AC_CHECK_ID_PREFIX;
  }
  // Keep pairing keys readable; strip control chars that would corrupt JSONL.
  const safe = key.replace(/[\0\n\r]/g, "_");
  return `${VERIFY_AC_CHECK_ID_PREFIX}/${safe}`;
}

/** Same-process verification JSONL when dest is stdout (`-`). */
const inProcessVerificationLines: string[] = [];
let inProcessStdoutSessionId: string | undefined;

/** Test seam: isolate stdout-dest buffer across cases. */
export function resetInProcessVerificationBuffer(): void {
  inProcessVerificationLines.length = 0;
  inProcessStdoutSessionId = undefined;
}

function inProcessVerificationText(): string | null {
  if (inProcessVerificationLines.length === 0) {
    return null;
  }
  return inProcessVerificationLines.join("\n");
}

/**
 * Record one walk-level verification event for the executed command set (#3322 / #3397).
 * Fail and pass use the same method_fingerprint shape (command list + cwd hash).
 * Fail-open: missing dest / write errors never change the AC result.
 * Stdout dest also appends to the same-process buffer so evaluate can
 * inspect this invocation without re-reading a file.
 * check_id is namespaced per active scope when scopeKey is provided (#3337).
 */
export function emitVerifyAcAttempts(options: {
  readonly projectRoot: string;
  readonly runs: readonly LiteralAcceptanceRunResult[];
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId?: string;
  /**
   * Active scope identity (plan.id or xBRIEF path stem). When set, check_id
   * becomes `verify:ac/<scopeKey>` so multi-active sessions do not false-deny (#3337).
   */
  readonly scopeKey?: string | null;
  /** Full check_id override (tests). Wins over scopeKey when non-empty. */
  readonly checkId?: string | null;
  /** stdout seam (tests). */
  readonly writeStdout?: (line: string) => void;
}): void {
  if (options.runs.length === 0) {
    return;
  }
  try {
    const env = options.env ?? process.env;
    const projectRoot = resolve(options.projectRoot);
    const dest = resolveRunSummaryDestination(projectRoot, { env });
    const explicitSession =
      options.sessionId?.trim() ||
      (typeof env.DEFT_SESSION_ID === "string" ? env.DEFT_SESSION_ID.trim() : "");
    let sessionId = explicitSession;
    if (!sessionId) {
      if (dest.kind === "stdout") {
        inProcessStdoutSessionId ??= randomUUID();
        sessionId = inProcessStdoutSessionId;
      } else {
        sessionId = randomUUID();
      }
    }
    const explicitCheck =
      typeof options.checkId === "string" && options.checkId.trim().length > 0
        ? options.checkId.trim()
        : null;
    const checkId = explicitCheck ?? verifyAcCheckId(options.scopeKey);
    const emitter = new RunSummaryEmitter({
      projectRoot,
      sessionId,
      env,
      writeStdout: options.writeStdout,
    });
    // One walk-level event: the method is the command set, not each command.
    // Per-command emit was blind to a shrinking list that kept the first command (#3397).
    const commands = options.runs.map((run) => run.command);
    const firstCwd = options.runs[0]?.cwd ?? "";
    // Hash the cwd key (joined only when cwds differ) so cwd paths never enter
    // the fingerprint; commandCountFromFingerprint can still count commands.
    const cwdKey = options.runs.every((run) => run.cwd === firstCwd)
      ? firstCwd
      : options.runs.map((run) => run.cwd).join("\0");
    const outcome = options.runs.every((run) => run.ok) ? "pass" : "fail";
    const emitted = emitter.emitVerification({
      check_id: checkId,
      method_fingerprint: methodFingerprintForWalk(commands, cwdKey),
      outcome,
    });
    if (dest.kind === "stdout" && emitted.line !== null) {
      inProcessVerificationLines.push(JSON.stringify(emitted.line));
    }
  } catch {
    // fail-open
  }
}

function loadRunSummaryText(projectRoot: string, env: NodeJS.ProcessEnv): string | null {
  const dest = resolveRunSummaryDestination(resolve(projectRoot), { env });
  if (dest.kind === "stdout") {
    return inProcessVerificationText();
  }
  if (dest.kind !== "file") {
    return null;
  }
  if (!existsSync(dest.path)) {
    return null;
  }
  try {
    return readFileSync(dest.path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Evaluate run-summary verification events for pass-after-fail-with-method-change.
 */
export function evaluateProductOracleIntegrity(
  options: EvaluateProductOracleIntegrityOptions,
): ProductOracleIntegrityVerdict {
  const env = options.env;
  const text =
    options.runSummaryText === undefined
      ? env !== undefined
        ? loadRunSummaryText(options.projectRoot, env)
        : null
      : options.runSummaryText;
  if (text === null || text.trim().length === 0) {
    return { ok: true, code: 0, flagged: [], unresolved: [], message: "" };
  }
  const flagged = flagPassAfterFailWithMethodChange(
    readVerificationAttempts(parseRunSummaryJsonl(text)),
  );
  const unresolved = unresolvedMethodChangePasses(flagged);
  if (unresolved.length === 0) {
    return { ok: true, code: 0, flagged, unresolved, message: "" };
  }
  const lead =
    `UNRESOLVED product-oracle discrepancy (#3322): ${unresolved.map(formatUnresolved).join("; ")}. ` +
    "Resolve by a product change (same method) or independently re-derive both sides " +
    "and record independent_rederivation=true.";
  return {
    ok: false,
    code: 1,
    flagged,
    unresolved,
    message: lead,
  };
}

/**
 * Lead the verify:ac message with any unresolved discrepancy.
 * Config errors (code 2) stay 2; unresolved oracle is exit 1.
 */
export function mergeOracleVerdict<T extends OracleIntegrityResultFields>(
  result: T,
  verdict: ProductOracleIntegrityVerdict,
): T {
  if (verdict.ok || verdict.message.length === 0) {
    return result;
  }
  const message = result.message ? `${verdict.message}\n${result.message}` : verdict.message;
  const code = result.code === 2 ? 2 : 1;
  return {
    ...result,
    ok: false,
    code,
    message,
  };
}
