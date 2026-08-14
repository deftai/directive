/**
 * evaluate verify:ac — product-first acceptance gate (#3284).
 *
 * Runs plan.acceptance.commands (or #3267 literal ledger) via the shared
 * literal-acceptance runner. Records source_rung in the result message.
 * Project floor with empty commands is a soft pass only when a suite floor
 * exists (suite gates own the floor inside full `task check`). With no suite
 * floor, empty resolution is soft_empty — not a green run (#3334).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  type EvaluateLiteralAcceptanceOptions,
  evaluateLiteralAcceptanceFromPlan,
  type LiteralAcceptanceGateResult,
  type LiteralAcceptanceRunner,
  runLiteralAcceptanceCommands,
} from "../literal-acceptance/index.js";
import {
  type AcceptanceRunSummaryOutcome,
  ENV_RUN_SUMMARY_PATH,
  RunSummaryEmitter,
} from "../run-summary/index.js";
import { maybeBankOnAcPass } from "../session/ac-pass-banking.js";
import {
  type ClauseWalkResult,
  formatClauseWalkMessage,
  walkAcceptanceClauses,
} from "../verify-ac/clauses.js";
import {
  emitVerifyAcAttempts,
  evaluateProductOracleIntegrity,
  mergeOracleVerdict,
} from "../verify-ac/evaluate.js";
import { readPlanAcceptance, validatePlanAcceptance } from "./acceptance.js";
import {
  formatSoftEmptyMessage,
  isEmptyAcResolution,
  projectHasSuiteFloor,
  type VerifyAcResolution,
} from "./empty-resolution.js";
import type { AcSourceRung, PlanAcceptance } from "./types.js";

export interface VerifyAcResult extends LiteralAcceptanceGateResult {
  readonly sourceRung: AcSourceRung;
  readonly noneStated: boolean;
  readonly acceptance: PlanAcceptance;
  readonly resolution: VerifyAcResolution;
  readonly resolvedCommandCount: number;
  readonly clauseOutcomes?: readonly ClauseWalkResult[];
  readonly clauseWalked?: boolean;
}

export interface EvaluateVerifyAcOptions extends EvaluateLiteralAcceptanceOptions {
  /**
   * When true, missing xBRIEF / no active scope is exit 0 (check composition).
   * Default false for standalone done-gate use.
   */
  readonly softMissingXbrief?: boolean;
  /**
   * Check-graph mode (#3284): used by `task check` via `--soft-missing-xbrief`.
   * - Unpromoted capture-only (task_statement) commands do not fail the graph
   *   (promotion remains a done-gate / scope:complete concern via verify:ac standalone).
   * - Executable command failures still fail closed (product-first).
   * - Safety-rejected ledger still fails closed.
   */
  readonly checkIntegrated?: boolean;
  /** Allow task_statement sources to execute (tests / explicit promote). */
  readonly allowTaskStatement?: boolean;
  /**
   * When false, skip AC-pass banking after executable pass (#3285).
   * Default true — first green executable AC banks a finalize checkpoint.
   */
  readonly bankOnPass?: boolean;
  /** Optional scope id override for the bank ledger (default plan.id / path). */
  readonly bankScopeId?: string | null;
  /**
   * Injected run-summary JSONL for product-oracle integrity (#3322).
   * Undefined → read DEFT_RUN_SUMMARY_PATH / default dest; null → skip disk.
   */
  readonly runSummaryText?: string | null;
  /** When false, skip #3322 oracle integrity. Default true. */
  readonly applyOracleIntegrity?: boolean;
  /** Env seam for run-summary dest resolution (#3322 / #3334). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Inject suite-floor detection (tests). Default: framework source has a
   * suite floor; consumer projects do not (#3334).
   */
  readonly hasSuiteFloor?: boolean;
  /**
   * When true, skip the acceptance run-summary emit so the path helper can
   * emit after the #3285 bank checkpoint.
   */
  readonly skipAcceptanceEmit?: boolean;
  /**
   * Active scope key for product-oracle check_id namespacing (#3337).
   * Prefer plan.id; path stem when id is missing. Multi-active verify:ac
   * under one session must not share a single global `verify:ac` check id.
   */
  readonly oracleScopeKey?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Evaluate product AC from an in-memory plan.
 */
export function evaluateVerifyAcFromPlan(
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions = {},
): VerifyAcResult {
  const planId = typeof plan.id === "string" && plan.id.trim() ? plan.id.trim() : null;
  const optionsWithScope: EvaluateVerifyAcOptions = {
    ...options,
    oracleScopeKey: options.oracleScopeKey?.trim() || planId || null,
  };
  const acceptance = readPlanAcceptance(plan);
  const schemaErrors = validatePlanAcceptance(plan.acceptance ?? acceptance);
  // Only hard-fail schema when an explicit plan.acceptance object exists.
  if (plan.acceptance !== undefined && schemaErrors.length > 0) {
    return applyOracle(
      {
        ok: false,
        code: 2,
        message: `verify:ac config error (#3284): ${schemaErrors.join("; ")}`,
        commands: [],
        runs: [],
        sourceRung: acceptance.source_rung,
        noneStated: acceptance.none_stated,
        acceptance,
        resolution: "config",
        resolvedCommandCount: 0,
      },
      optionsWithScope,
    );
  }

  const projectRoot = resolve(optionsWithScope.projectRoot ?? process.cwd());

  // Prefer shared literal-acceptance path so safety / promotion rules stay one place.
  // Empty plan.acceptance.commands still consults the #3267 rejected ledger
  // (Greptile P1: rejected stated AC must never soft-pass).
  // For derived/floor commands already on plan.acceptance, inject as explicit metadata
  // if the literal ledger is empty of executables.
  const base = evaluateLiteralAcceptanceFromPlan(plan, {
    projectRoot,
    runner: optionsWithScope.runner,
    // Check composition uses the stamped ledger only. Re-scanning issue prose
    // during `task check` re-captures backtick `verify:ac` lines as rejected
    // and deadlocks the graph (#3323 / #3284 check-integrated).
    captureFromNarratives:
      optionsWithScope.captureFromNarratives ??
      (optionsWithScope.checkIntegrated === true ? false : undefined),
    quiet: optionsWithScope.quiet,
  });

  // When literal path had nothing executable but plan.acceptance has derived commands,
  // run them directly with source=explicit semantics.
  if (
    base.ok &&
    base.runs.length === 0 &&
    acceptance.commands.length > 0 &&
    (acceptance.source_rung === "derived" || acceptance.source_rung === "project_floor")
  ) {
    const runner: LiteralAcceptanceRunner | undefined = optionsWithScope.runner;
    const direct = runLiteralAcceptanceCommands(
      acceptance.commands.map((c) => ({
        command: c.command,
        cwd: c.cwd ?? null,
        expectedStdout: c.expectedStdout ?? null,
        expectedExitCode: c.expectedExitCode ?? 0,
        source: "explicit" as const,
        sourceSpan: "plan.acceptance.commands",
      })),
      {
        projectRoot,
        runner,
        allowTaskStatement: optionsWithScope.allowTaskStatement,
      },
    );
    return applyOracle(annotate(direct, acceptance, optionsWithScope.quiet), optionsWithScope);
  }

  // Check composition: mid-story unpromoted capture-only may soft-pass so the
  // framework graph is not deadlocked before agents promote peers.
  // Greptile P1 #3284: safety-rejected stated commands NEVER soft-pass — they
  // block product verification until a safe alternative is promoted.
  if (optionsWithScope.checkIntegrated === true && !base.ok && base.runs.length === 0) {
    const hasRejected = (base.rejected?.length ?? 0) > 0;
    if (hasRejected) {
      return applyOracle(annotate(base, acceptance, optionsWithScope.quiet), optionsWithScope);
    }
    const unpromoted =
      /capture-only|task_statement|no matching agent-promoted/i.test(base.message) ||
      (base.commands.length > 0 && base.commands.every((c) => c.source === "task_statement"));
    if (unpromoted || base.commands.length === 0) {
      return applyOracle(
        {
          ok: true,
          code: 0,
          message: optionsWithScope.quiet
            ? ""
            : `verify:ac advisory (#3284 check-integrated): no executable AC peers yet ` +
              `(capture-only / empty). Done-gate standalone verify:ac still requires promotion. ` +
              `[rung=${acceptance.source_rung}]\n` +
              base.message,
          commands: base.commands,
          runs: [],
          rejected: base.rejected,
          sourceRung: acceptance.source_rung,
          noneStated: acceptance.none_stated,
          acceptance,
          resolution: classifyResolution({
            ok: true,
            code: 0,
            runsLength: 0,
            commandCount: base.commands.length,
            rejectedCount: base.rejected?.length ?? 0,
          }),
          resolvedCommandCount: base.commands.length,
        },
        optionsWithScope,
      );
    }
  }

  return applyOracle(annotate(base, acceptance, optionsWithScope.quiet), optionsWithScope);
}

function classifyResolution(input: {
  readonly ok: boolean;
  readonly code: number;
  readonly runsLength: number;
  readonly commandCount: number;
  readonly rejectedCount: number;
  readonly resolution?: VerifyAcResolution;
}): VerifyAcResolution {
  if (input.resolution !== undefined) {
    return input.resolution;
  }
  if (input.code === 2) {
    return "config";
  }
  if (!input.ok) {
    return "fail";
  }
  if (input.runsLength > 0) {
    return "verified-pass";
  }
  if (isEmptyAcResolution(input)) {
    return "empty-pass";
  }
  return "empty-pass";
}

function applyEmptyFloorPolicy(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
): VerifyAcResult {
  if (
    !isEmptyAcResolution({
      ok: result.ok,
      code: result.code,
      runsLength: result.runs.length,
      commandCount: Math.max(result.commands.length, result.acceptance.commands.length),
      rejectedCount: result.rejected?.length ?? 0,
      resolution: result.resolution,
    })
  ) {
    return result;
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const suiteFloor = options.hasSuiteFloor ?? projectHasSuiteFloor(projectRoot);
  if (suiteFloor) {
    return {
      ...result,
      resolution: "empty-pass",
      resolvedCommandCount: 0,
    };
  }
  return {
    ...result,
    ok: false,
    code: 1,
    message: formatSoftEmptyMessage(result.acceptance),
    resolution: "soft_empty",
    resolvedCommandCount: 0,
  };
}

function acceptanceOutcomeOf(result: VerifyAcResult): AcceptanceRunSummaryOutcome | null {
  if (result.resolution === "verified-pass") return "verified-pass";
  if (result.resolution === "empty-pass") return "empty-pass";
  if (result.resolution === "soft_empty") return "soft_empty";
  if (result.resolution === "fail") return "fail";
  return null;
}

function emitAcceptanceOutcome(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
): void {
  if (options.env === undefined) {
    return;
  }
  const dest = options.env[ENV_RUN_SUMMARY_PATH];
  if (dest === undefined || dest.trim().length === 0) {
    return;
  }
  const outcome = acceptanceOutcomeOf(result);
  if (outcome === null) {
    return;
  }
  try {
    const emitter = new RunSummaryEmitter({
      projectRoot,
      sessionId:
        (typeof options.env.DEFT_SESSION_ID === "string" && options.env.DEFT_SESSION_ID.trim()) ||
        "verify-ac",
      env: options.env,
    });
    emitter.emitAcceptance({
      resolved_command_count: result.resolvedCommandCount,
      outcome,
      source_rung: result.sourceRung,
      none_stated: result.noneStated,
      clause_count: result.clauseOutcomes?.length,
      clause_outcomes: result.clauseOutcomes?.map((row) => ({
        id: row.id,
        outcome: row.outcome,
      })),
    });
  } catch {
    // fail-open
  }
}

function applyClauseWalk(result: VerifyAcResult, options: EvaluateVerifyAcOptions): VerifyAcResult {
  const clauses = result.acceptance.clauses ?? [];
  if (clauses.length === 0 || result.resolution === "config" || result.resolution === "skipped") {
    return result;
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const report = walkAcceptanceClauses(clauses, projectRoot);
  const message = options.quiet ? result.message : formatClauseWalkMessage(report, result.message);
  const ok = result.ok && report.ok;
  return {
    ...result,
    ok,
    code: ok ? result.code : result.code === 2 ? 2 : 1,
    message,
    resolution: ok
      ? result.resolution === "empty-pass"
        ? "verified-pass"
        : result.resolution
      : "fail",
    clauseOutcomes: report.clauses,
    clauseWalked: true,
  };
}

function applyOracle(result: VerifyAcResult, options: EvaluateVerifyAcOptions): VerifyAcResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const walked = applyClauseWalk(result, options);
  const gated = walked.clauseWalked === true ? walked : applyEmptyFloorPolicy(walked, options);
  // Emit/read disk only when the caller supplied env (CLI passes process.env).
  // Tests stay isolated unless they opt in with env or runSummaryText.
  if (options.env !== undefined) {
    emitVerifyAcAttempts({
      projectRoot,
      runs: gated.runs,
      env: options.env,
      scopeKey: options.oracleScopeKey,
    });
  }
  let next = gated;
  if (options.applyOracleIntegrity !== false) {
    const verdict = evaluateProductOracleIntegrity({
      projectRoot,
      runSummaryText: options.runSummaryText,
      env: options.env,
    });
    next = mergeOracleVerdict(gated, verdict);
    if (!verdict.ok && next.resolution !== "soft_empty" && next.resolution !== "config") {
      next = { ...next, resolution: "fail" };
    }
  }
  if (options.skipAcceptanceEmit !== true) {
    emitAcceptanceOutcome(next, options, projectRoot);
  }
  return next;
}

function annotate(
  result: LiteralAcceptanceGateResult,
  acceptance: PlanAcceptance,
  quiet?: boolean,
): VerifyAcResult {
  const prefix = result.ok
    ? `verify:ac passed (#3284) [rung=${acceptance.source_rung}]`
    : `verify:ac FAILED (#3284) [rung=${acceptance.source_rung}]`;
  let message = result.message;
  if (!quiet) {
    if (message.includes("#3267")) {
      message = message.replace(/#3267/g, "#3284/#3267");
    }
    if (!message.startsWith("verify:ac")) {
      message = `${prefix}\n${message}`;
    } else if (!message.includes(`rung=${acceptance.source_rung}`)) {
      message = `${message} [rung=${acceptance.source_rung}]`;
    }
  } else if (result.ok) {
    message = "";
  }
  const commandCount = Math.max(result.commands.length, acceptance.commands.length);
  return {
    ...result,
    message,
    sourceRung: acceptance.source_rung,
    noneStated: acceptance.none_stated,
    acceptance,
    resolution: classifyResolution({
      ok: result.ok,
      code: result.code,
      runsLength: result.runs.length,
      commandCount,
      rejectedCount: result.rejected?.length ?? 0,
    }),
    resolvedCommandCount: result.runs.length > 0 ? result.runs.length : commandCount,
  };
}

/**
 * Evaluate from xBRIEF path.
 */
export function evaluateVerifyAcFromPath(
  xbriefPath: string,
  options: EvaluateVerifyAcOptions = {},
): VerifyAcResult {
  const abs = resolve(xbriefPath);
  if (!existsSync(abs)) {
    if (options.softMissingXbrief) {
      return applyOracle(softSkip(`xBRIEF not found: ${abs}`, options.quiet), options);
    }
    return applyOracle(configResult(`verify:ac: xBRIEF not found: ${abs}`), options);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return applyOracle(configResult(`verify:ac: unreadable xBRIEF (${msg}): ${abs}`), options);
  }
  const data = asRecord(parsed);
  if (data === null) {
    return applyOracle(
      configResult(`verify:ac: xBRIEF top-level is not an object: ${abs}`),
      options,
    );
  }
  const plan = asRecord(data.plan);
  if (plan === null) {
    return applyOracle(configResult(`verify:ac: xBRIEF missing plan object: ${abs}`), options);
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  // Path-relative keys stay unique across xbrief/ vs vbrief/ and duplicate plan.id (#3337 Greptile).
  const oracleScopeKey =
    options.oracleScopeKey?.trim() || resolveOracleScopeKey(plan, abs, projectRoot);
  const result = evaluateVerifyAcFromPlan(plan, {
    ...options,
    skipAcceptanceEmit: true,
    oracleScopeKey,
  });
  const banked = maybeAttachAcPassBank(result, plan, abs, options);
  emitAcceptanceOutcome(banked, options, projectRoot);
  return banked;
}

/**
 * Unique product-oracle scope key for one active xBRIEF path (#3337).
 * Relative path is always unique across active roots; plan.id alone is not
 * (duplicate ids / same stem in xbrief+vbrief). Prefer `id@relPath` when both exist.
 */
export function resolveOracleScopeKey(
  plan: Record<string, unknown>,
  xbriefPath: string,
  projectRoot: string,
): string {
  const abs = resolve(xbriefPath);
  const root = resolve(projectRoot);
  let rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    rel = basename(abs);
  }
  const planId = typeof plan.id === "string" && plan.id.trim() ? plan.id.trim() : null;
  if (planId !== null) {
    return `${planId}@${rel}`;
  }
  return rel;
}

/**
 * After executable AC pass, FINALIZE the banking checkpoint (#3285).
 * Soft/advisory passes with zero runs do not bank. Fail-open on ledger errors.
 */
function maybeAttachAcPassBank(
  result: VerifyAcResult,
  plan: Record<string, unknown>,
  xbriefPath: string,
  options: EvaluateVerifyAcOptions,
): VerifyAcResult {
  if (options.bankOnPass === false) {
    return result;
  }
  if (!result.ok || result.runs.length === 0) {
    return result;
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const planId = typeof plan.id === "string" && plan.id.trim() ? plan.id.trim() : null;
  const scopeId =
    options.bankScopeId?.trim() ||
    planId ||
    basename(xbriefPath)
      .replace(/\.xbrief\.json$/i, "")
      .replace(/\.vbrief\.json$/i, "");
  try {
    const banked = maybeBankOnAcPass({
      projectRoot,
      scopeId,
      executableRuns: result.runs.length,
      quiet: options.quiet,
    });
    if (options.quiet || banked.notes.length === 0) {
      return result;
    }
    const extra = banked.notes.join("\n");
    return {
      ...result,
      message: result.message ? `${result.message}\n${extra}` : extra,
    };
  } catch (err: unknown) {
    // Checkpoint is mandatory after executable AC green (#3285 Greptile residual).
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...result,
      ok: false,
      code: 1,
      resolution: "fail",
      message:
        `verify:ac bank checkpoint failed (#3285): ${msg}` +
        (result.message ? `\n${result.message}` : ""),
    };
  }
}

function configResult(message: string): VerifyAcResult {
  return {
    ok: false,
    code: 2,
    message,
    commands: [],
    runs: [],
    sourceRung: "project_floor",
    noneStated: true,
    acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
    resolution: "config",
    resolvedCommandCount: 0,
  };
}

function softSkip(detail: string, quiet?: boolean): VerifyAcResult {
  return {
    ok: true,
    code: 0,
    message: quiet ? "" : `verify:ac skipped (#3284 soft-missing): ${detail}`,
    commands: [],
    runs: [],
    sourceRung: "project_floor",
    noneStated: true,
    acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
    resolution: "skipped",
    resolvedCommandCount: 0,
  };
}

/** Pure: product AC is required at every ceremony depth (#3284 / #3267 / #3156). */
export function isVerifyAcRequiredAtCeremonyDepth(_depth: string | null | undefined): boolean {
  return true;
}
