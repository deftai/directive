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
  emitAcceptanceStampFromPlan,
  MISSING_AMBIGUITY_ATTESTATION_CAUSE,
  stampedAmbiguityAttestationError,
} from "../intake/clause-derivation.js";
import {
  appendLiteralAcceptanceAdvisory,
  type EvaluateLiteralAcceptanceOptions,
  evaluateLiteralAcceptanceFromPlan,
  isNoopRefusalReason,
  type LiteralAcceptanceGateResult,
  type LiteralAcceptanceRunner,
  type RejectedLiteralCommand,
  runLiteralAcceptanceCommands,
  stripLiteralAcceptanceAdvisory,
} from "../literal-acceptance/index.js";
import {
  type AcceptanceRunSummaryOutcome,
  ENV_RUN_SUMMARY_PATH,
  RunSummaryEmitter,
} from "../run-summary/index.js";
import { maybeBankOnAcPass } from "../session/ac-pass-banking.js";
import {
  resolveAcReuse,
  resolveScopeIdForAcReuse,
  snapshotFromReuseFields,
} from "../session/ac-pass-reuse.js";
import { gitHead } from "../session/git.js";
import { hashProductState } from "../session/product-state-hash.js";
import {
  type AcServedFrom,
  resolveVerifyAcSessionId,
  writeVerifyAcSessionCache,
} from "../session/verify-ac-session-cache.js";
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
  clauseWalkBlocks,
  formatAcceptanceVerdict,
  resolveAcceptanceVerdict,
} from "./acceptance-resolver.js";
import {
  formatSoftEmptyMessage,
  formatTranscriptEmptyMessage,
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
  /** How the result was obtained (#3387). */
  readonly servedFrom?: AcServedFrom;
  /** Config-error cause when resolution is config (#3559). */
  readonly cause?: string;
  /** Reuse-gate miss cause when servedFrom is executed (#3558). */
  readonly missReason?: string;
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
   * Raw plan.acceptance as observed on the brief (#3355). Distinct from the
   * synthesized floor: stamp only when the plan actually carries a block.
   */
  readonly observedAcceptance?: unknown;
  /**
   * Active scope key for product-oracle check_id namespacing (#3337).
   * Prefer plan.id; path stem when id is missing. Multi-active verify:ac
   * under one session must not share a single global `verify:ac` check id.
   */
  readonly oracleScopeKey?: string | null;
  /**
   * Reuse a matching #3285 bank / same-session cache (#3387).
   * - auto (default): cache then bank
   * - bank: complete walk — bank only
   * - never: always execute
   */
  readonly reuseMode?: "auto" | "bank" | "never";
  readonly sessionId?: string | null;
  readonly productPaths?: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function tryReuseVerifyAc(
  plan: Record<string, unknown>,
  acceptance: PlanAcceptance,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
): VerifyAcResult | null {
  const mode = options.reuseMode ?? "auto";
  if (mode === "never") return null;
  const reuse = resolveAcReuse({
    projectRoot,
    plan,
    scopeId: options.bankScopeId,
    sessionId: options.sessionId,
    env: options.env,
    productPaths: options.productPaths,
    allowCache: mode === "auto",
    allowBank: true,
  });
  if (reuse.kind === "miss") return null;

  if (reuse.kind === "cache") {
    const snap = reuse.cache.snapshot;
    const cachedAcceptance = readPlanAcceptance({ acceptance: snap.acceptance });
    return {
      ok: snap.ok,
      code: snap.code,
      message: options.quiet
        ? ""
        : snap.message.includes("served_from=")
          ? snap.message
          : `${snap.message} served_from=cache`,
      commands: snap.commands as VerifyAcResult["commands"],
      runs: snap.runs as VerifyAcResult["runs"],
      rejected: snap.rejected as VerifyAcResult["rejected"],
      sourceRung: acceptance.source_rung,
      noneStated: acceptance.none_stated,
      acceptance: cachedAcceptance.commands.length > 0 ? cachedAcceptance : acceptance,
      resolution: "verified-pass",
      resolvedCommandCount: snap.resolvedCommandCount,
      servedFrom: "cache",
    };
  }

  const commandCount = acceptance.commands.length;
  if (commandCount === 0) return null;
  return {
    ok: true,
    code: 0,
    message: options.quiet
      ? ""
      : `verify:ac passed (#3284) served_from=bank [rung=${acceptance.source_rung}]`,
    commands: acceptance.commands.map((c) => ({
      command: c.command,
      cwd: c.cwd ?? null,
      expectedStdout: c.expectedStdout ?? null,
      expectedExitCode: c.expectedExitCode ?? 0,
      source: "explicit" as const,
      sourceSpan: "plan.acceptance.commands",
    })),
    runs: [],
    sourceRung: acceptance.source_rung,
    noneStated: acceptance.none_stated,
    acceptance,
    resolution: "verified-pass",
    resolvedCommandCount: commandCount,
    servedFrom: "bank",
  };
}

function persistVerifyAcSessionCache(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
  plan: Record<string, unknown>,
): void {
  if (!result.ok || result.resolution !== "verified-pass") return;
  const sessionId = resolveVerifyAcSessionId(options.env, options.sessionId);
  const resolvedScope = resolveScopeIdForAcReuse(plan, options.bankScopeId);
  if (sessionId === null || resolvedScope === null) return;
  const hashed = hashProductState({
    projectRoot,
    plan,
    productPaths: options.productPaths,
  });
  if (!hashed.complete) return;
  try {
    writeVerifyAcSessionCache({
      projectRoot,
      sessionId,
      scopeId: resolvedScope,
      productStateHash: hashed.digest,
      snapshot: snapshotFromReuseFields({
        ok: result.ok,
        code: result.code === 2 ? 2 : result.code === 1 ? 1 : 0,
        message: result.message,
        commands: result.commands,
        runs: result.runs,
        rejected: result.rejected,
        sourceRung: result.sourceRung,
        noneStated: result.noneStated,
        acceptance: result.acceptance,
        resolution: result.resolution,
        resolvedCommandCount: result.resolvedCommandCount,
      }),
    });
  } catch {
    // fail-open: missing cache must not fail a green run
  }
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
    bankScopeId: options.bankScopeId?.trim() || planId || options.bankScopeId,
    observedAcceptance:
      options.observedAcceptance !== undefined ? options.observedAcceptance : plan.acceptance,
  };
  const acceptance = readPlanAcceptance(plan);
  const schemaErrors = validatePlanAcceptance(plan.acceptance ?? acceptance);
  // Only hard-fail schema when an explicit plan.acceptance object exists.
  if (plan.acceptance !== undefined && schemaErrors.length > 0) {
    const noop = schemaErrors.some((error) => isNoopRefusalReason(error));
    return applyOracle(
      {
        ok: false,
        code: noop ? 1 : 2,
        message: noop
          ? `verify:ac rejected-noop (#3396): ${schemaErrors.join("; ")}`
          : `verify:ac config error (#3284): ${schemaErrors.join("; ")}`,
        commands: [],
        runs: [],
        sourceRung: acceptance.source_rung,
        noneStated: acceptance.none_stated,
        acceptance,
        resolution: noop ? "rejected-noop" : "config",
        resolvedCommandCount: 0,
      },
      optionsWithScope,
      plan,
    );
  }

  const projectRoot = resolve(optionsWithScope.projectRoot ?? process.cwd());

  const attestationError = stampedAmbiguityAttestationError(
    optionsWithScope.observedAcceptance !== undefined
      ? optionsWithScope.observedAcceptance
      : plan.acceptance,
  );
  if (attestationError !== null) {
    return applyOracle(
      {
        ok: false,
        code: 2,
        message: optionsWithScope.quiet === true ? "" : attestationError.message,
        commands: [],
        runs: [],
        sourceRung: acceptance.source_rung,
        noneStated: acceptance.none_stated,
        acceptance,
        resolution: "config",
        resolvedCommandCount: 0,
        cause: attestationError.cause ?? MISSING_AMBIGUITY_ATTESTATION_CAUSE,
      },
      optionsWithScope,
      plan,
    );
  }

  const reused = tryReuseVerifyAc(plan, acceptance, optionsWithScope, projectRoot);
  if (reused !== null) {
    return applyOracle(reused, optionsWithScope, plan);
  }

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

  // When the literal ledger produced no runs, execute non-empty plan.acceptance.commands
  // as source=explicit. The documented key is plan.acceptance.commands (#3284 / #3449);
  // the #3267 ledger is a parallel store and can be empty while stated commands exist.
  // Stated was previously excluded, so rung=stated + empty ledger printed "nothing to run".
  // Do not override a blocking rejected ledger or a config error.
  if (shouldRunPlanAcceptanceDirectly(base, acceptance)) {
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
    // Carry the #3484 demotion forward: the direct path replaces `base`, and the
    // advisory ledger must stay visible (reported, never blocking) (#3497).
    const advisory: readonly RejectedLiteralCommand[] = base.advisoryRejected ?? [];
    const directWithAdvisory: LiteralAcceptanceGateResult = {
      ...direct,
      advisoryRejected: advisory,
      message:
        optionsWithScope.quiet === true
          ? direct.message
          : appendLiteralAcceptanceAdvisory(direct.message, advisory),
    };
    return applyOracle(
      annotate(directWithAdvisory, acceptance, optionsWithScope.quiet),
      optionsWithScope,
      plan,
    );
  }

  // Check composition: mid-story unpromoted capture-only may soft-pass so the
  // framework graph is not deadlocked before agents promote peers.
  // Greptile P1 #3284: safety-rejected stated commands NEVER soft-pass — they
  // block product verification until a safe alternative is promoted.
  if (optionsWithScope.checkIntegrated === true && !base.ok && base.runs.length === 0) {
    const hasRejected = (base.rejected?.length ?? 0) > 0;
    if (hasRejected) {
      return applyOracle(
        annotate(base, acceptance, optionsWithScope.quiet),
        optionsWithScope,
        plan,
      );
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
        plan,
      );
    }
  }

  return applyOracle(annotate(base, acceptance, optionsWithScope.quiet), optionsWithScope, plan);
}

function shouldRunPlanAcceptanceDirectly(
  base: LiteralAcceptanceGateResult,
  acceptance: PlanAcceptance,
): boolean {
  if (acceptance.commands.length === 0) return false;
  if (base.runs.length > 0) return false;
  if (base.code === 2) return false;
  if ((base.rejected?.length ?? 0) > 0) return false;
  return true;
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
  const skippedPrompts = result.transcriptPromptSkipped ?? 0;
  if (suiteFloor && skippedPrompts > 0) {
    return {
      ...result,
      ok: false,
      code: 1,
      message: options.quiet === true ? "" : formatTranscriptEmptyMessage(result.acceptance),
      resolution: "fail",
      resolvedCommandCount: 0,
    };
  }
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

function acceptanceOutcomeOf(result: VerifyAcResult): AcceptanceRunSummaryOutcome {
  if (result.resolution === "verified-pass") return "verified-pass";
  if (result.resolution === "empty-pass") return "empty-pass";
  if (result.resolution === "soft_empty") return "soft_empty";
  if (result.resolution === "fail") return "fail";
  if (result.resolution === "config") return "config-error";
  if (result.resolution === "rejected-noop") return "rejected-noop";
  return "soft-missing";
}

function emitAcceptanceObservedStamp(options: EvaluateVerifyAcOptions, projectRoot: string): void {
  if (options.env === undefined) {
    return;
  }
  const dest = options.env[ENV_RUN_SUMMARY_PATH];
  if (dest === undefined || dest.trim().length === 0) {
    return;
  }
  emitAcceptanceStampFromPlan(projectRoot, { acceptance: options.observedAcceptance }, options.env);
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
  try {
    const emitter = new RunSummaryEmitter({
      projectRoot,
      sessionId: options.sessionId,
      env: options.env,
      component: "verify-ac",
    });
    emitter.emitAcceptance({
      resolved_command_count: result.resolvedCommandCount,
      outcome: acceptanceOutcomeOf(result),
      source_rung: result.sourceRung,
      none_stated: result.noneStated,
      clause_count: result.clauseOutcomes?.length,
      clause_outcomes: result.clauseOutcomes?.map((row) => ({
        id: row.id,
        outcome: row.outcome,
      })),
      served_from: result.servedFrom ?? "executed",
      ...(result.cause !== undefined ? { cause: result.cause } : {}),
      miss_reason: (result.servedFrom ?? "executed") === "executed" ? result.missReason : undefined,
    });
  } catch {
    // fail-open
  }
}

/** Outcome on every terminal path; stamp from observed plan.acceptance (#3355). */
function emitAcceptanceTelemetry(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
): void {
  emitAcceptanceObservedStamp(options, projectRoot);
  emitAcceptanceOutcome(result, options, projectRoot);
}

/**
 * CLI-only early returns that never reach evaluate still emit an acceptance
 * outcome so field streams see config-error / soft-missing (#3355).
 */
export function emitVerifyAcTerminalOutcome(input: {
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly outcome: AcceptanceRunSummaryOutcome;
  readonly sourceRung?: AcSourceRung;
  readonly noneStated?: boolean;
}): void {
  emitAcceptanceOutcome(
    {
      ok:
        input.outcome !== "config-error" &&
        input.outcome !== "fail" &&
        input.outcome !== "rejected-noop",
      code:
        input.outcome === "config-error"
          ? 2
          : input.outcome === "fail" || input.outcome === "rejected-noop"
            ? 1
            : 0,
      message: "",
      commands: [],
      runs: [],
      sourceRung: input.sourceRung ?? "project_floor",
      noneStated: input.noneStated ?? true,
      acceptance: {
        commands: [],
        none_stated: input.noneStated ?? true,
        source_rung: input.sourceRung ?? "project_floor",
      },
      resolution:
        input.outcome === "config-error"
          ? "config"
          : input.outcome === "soft-missing"
            ? "skipped"
            : input.outcome === "fail"
              ? "fail"
              : input.outcome === "rejected-noop"
                ? "rejected-noop"
                : input.outcome === "soft_empty"
                  ? "soft_empty"
                  : input.outcome === "verified-pass"
                    ? "verified-pass"
                    : "empty-pass",
      resolvedCommandCount: 0,
    },
    { projectRoot: input.projectRoot, env: input.env },
    resolve(input.projectRoot),
  );
}

function applyClauseWalk(result: VerifyAcResult, options: EvaluateVerifyAcOptions): VerifyAcResult {
  const clauses = result.acceptance.clauses ?? [];
  if (clauses.length === 0 || result.resolution === "config" || result.resolution === "skipped") {
    return result;
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const report = walkAcceptanceClauses(clauses, projectRoot);
  const message = options.quiet ? result.message : formatClauseWalkMessage(report, result.message);
  // #3497: a clause the static walk cannot decide is evidence of nothing. It blocks
  // only when nothing else verified the product; a green executable acceptance run
  // already is the product-first oracle. Failed clauses still block unconditionally.
  const blocked = clauseWalkBlocks({
    failed: report.failed.length,
    verified: report.verified.length,
    walked: report.clauses.length,
    hasGreenExecutableRun:
      result.ok && result.runs.length > 0 && result.runs.every((run) => run.ok),
  });
  const ok = result.ok && !blocked;
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

function applyRejectedNoop(result: VerifyAcResult): VerifyAcResult {
  if (result.resolution === "rejected-noop") {
    return result;
  }
  const rejected = result.rejected ?? [];
  const fromLedger = rejected.some((row) => isNoopRefusalReason(row.reason));
  const fromRuns = result.runs.some(
    (row) => !row.ok && isNoopRefusalReason(row.detail.replace(/^refused:\s*/i, "")),
  );
  // #3484 / #3497: the advisory block quotes refusal reasons that were deliberately
  // demoted because the plan states structured acceptance commands. Sniffing the
  // rendered message resurrected them as a blocking no-op verdict — verify:ac
  // refused while its own output said "do NOT block". Read the blocking ledgers,
  // and inspect only the non-advisory part of the message.
  const fromMessage = isNoopRefusalReason(stripLiteralAcceptanceAdvisory(result.message));
  if (!fromLedger && !fromRuns && !fromMessage) {
    return result;
  }
  return {
    ...result,
    ok: false,
    code: result.code === 2 ? 2 : 1,
    resolution: "rejected-noop",
  };
}

/**
 * Make the rendered message agree with the verdict (#3497).
 *
 * `annotate` stamps "verify:ac passed" from the sub-gate result, but later stages
 * (clause walk, no-op ledger, oracle integrity) can still flip `ok`. The old output
 * left the stale "passed" lead in place, so scope:complete printed four passing lines
 * and then refused. Re-label the lead and name the deciding predicate.
 */
function labelVerdict(result: VerifyAcResult): string {
  const verdict = resolveAcceptanceVerdict(result);
  if (verdict.ok) {
    return result.message;
  }
  const relabelled = result.message.replace(
    /verify:ac passed \(#3284\)/g,
    "verify:ac FAILED (#3284)",
  );
  const line = formatAcceptanceVerdict(verdict);
  return relabelled.length > 0 ? `${relabelled}\n${line}` : line;
}

function applyOracle(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
  plan: Record<string, unknown> = {},
): VerifyAcResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const walked = applyClauseWalk(applyRejectedNoop(result), options);
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
    if (
      !verdict.ok &&
      next.resolution !== "soft_empty" &&
      next.resolution !== "config" &&
      next.resolution !== "rejected-noop"
    ) {
      next = { ...next, resolution: "fail" };
    }
  }
  const servedFrom = next.servedFrom ?? "executed";
  let missReason = next.missReason;
  if (servedFrom === "executed" && (missReason === undefined || missReason.length === 0)) {
    const reuse = resolveAcReuse({
      projectRoot,
      plan,
      scopeId: options.bankScopeId,
      sessionId: options.sessionId,
      env: options.env,
      productPaths: options.productPaths,
      allowCache: (options.reuseMode ?? "auto") === "auto",
      allowBank: true,
    });
    if (reuse.kind === "miss") missReason = reuse.reason;
  }
  const stamped: VerifyAcResult = {
    ...next,
    message: options.quiet === true ? next.message : labelVerdict(next),
    servedFrom,
    missReason: servedFrom === "executed" ? missReason : undefined,
  };
  persistVerifyAcSessionCache(stamped, options, projectRoot, plan);
  if (options.skipAcceptanceEmit !== true) {
    emitAcceptanceTelemetry(stamped, options, projectRoot);
  }
  return stamped;
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
    servedFrom: "executed",
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
  const emitOptions: EvaluateVerifyAcOptions = {
    ...options,
    oracleScopeKey,
    observedAcceptance: plan.acceptance,
  };
  const result = evaluateVerifyAcFromPlan(plan, {
    ...emitOptions,
    skipAcceptanceEmit: true,
  });
  const banked = maybeAttachAcPassBank(result, plan, abs, emitOptions);
  emitAcceptanceTelemetry(banked, emitOptions, projectRoot);
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
 * After verified-pass, FINALIZE the banking checkpoint (#3285 / #3558).
 * Soft/advisory empty-pass still skips. Ledger I/O failures fail closed.
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
  if (!result.ok || result.resolution !== "verified-pass") {
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
    const hashed = hashProductState({
      projectRoot,
      plan,
      productPaths: options.productPaths,
    });
    const banked = maybeBankOnAcPass({
      projectRoot,
      scopeId,
      executableRuns: result.runs.length,
      verifiedPass: true,
      quiet: options.quiet,
      productStateHash: hashed.complete ? hashed.digest : null,
      environ: options.env,
      headSha: gitHead(projectRoot).head,
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
