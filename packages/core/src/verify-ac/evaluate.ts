/**
 * Apply product-oracle integrity to verify:ac (#3322).
 *
 * Missing run-summary is a no-op (no evidence). A flagged
 * fail → method-change → pass without independent_rederivation fails closed.
 */

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
  return (
    `check_id=${flag.check_id} fail method=${flag.failed_method} ` +
    `then pass method=${flag.passed_method} without independent re-derivation`
  );
}

const VERIFY_AC_CHECK_ID = "verify:ac";

/**
 * Record each executed acceptance command as a verification event (#3322).
 * Fail-open: missing dest / write errors never change the AC result.
 */
export function emitVerifyAcAttempts(options: {
  readonly projectRoot: string;
  readonly runs: readonly LiteralAcceptanceRunResult[];
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId?: string;
}): void {
  if (options.runs.length === 0) {
    return;
  }
  try {
    const env = options.env ?? process.env;
    const sessionId =
      options.sessionId?.trim() ||
      (typeof env.DEFT_SESSION_ID === "string" ? env.DEFT_SESSION_ID.trim() : "") ||
      "verify-ac";
    const emitter = new RunSummaryEmitter({
      projectRoot: resolve(options.projectRoot),
      sessionId,
      env,
    });
    for (const run of options.runs) {
      emitter.emitVerification({
        check_id: VERIFY_AC_CHECK_ID,
        method_fingerprint: `${run.command}\0${run.cwd}`,
        outcome: run.ok ? "pass" : "fail",
      });
    }
  } catch {
    // fail-open
  }
}

function loadRunSummaryText(projectRoot: string, env: NodeJS.ProcessEnv): string | null {
  const dest = resolveRunSummaryDestination(resolve(projectRoot), { env });
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
