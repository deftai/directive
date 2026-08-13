/**
 * evaluate verify:ac — product-first acceptance gate (#3284).
 *
 * Runs plan.acceptance.commands (or #3267 literal ledger) via the shared
 * literal-acceptance runner. Records source_rung in the result message.
 * Project floor with empty commands is a soft pass (suite gates own the floor
 * inside full `task check`); standalone done paths still surface the rung.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  type EvaluateLiteralAcceptanceOptions,
  evaluateLiteralAcceptanceFromPlan,
  type LiteralAcceptanceGateResult,
  type LiteralAcceptanceRunner,
  runLiteralAcceptanceCommands,
} from "../literal-acceptance/index.js";
import { maybeBankOnAcPass } from "../session/ac-pass-banking.js";
import { evaluateProductOracleIntegrity, mergeOracleVerdict } from "../verify-ac/evaluate.js";
import { readPlanAcceptance, validatePlanAcceptance } from "./acceptance.js";
import type { AcSourceRung, PlanAcceptance } from "./types.js";

export interface VerifyAcResult extends LiteralAcceptanceGateResult {
  readonly sourceRung: AcSourceRung;
  readonly noneStated: boolean;
  readonly acceptance: PlanAcceptance;
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
  /** Env seam for run-summary dest resolution (#3322). */
  readonly env?: NodeJS.ProcessEnv;
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
      },
      options,
    );
  }

  const projectRoot = resolve(options.projectRoot ?? process.cwd());

  // Prefer shared literal-acceptance path so safety / promotion rules stay one place.
  // Empty plan.acceptance.commands still consults the #3267 rejected ledger
  // (Greptile P1: rejected stated AC must never soft-pass).
  // For derived/floor commands already on plan.acceptance, inject as explicit metadata
  // if the literal ledger is empty of executables.
  const base = evaluateLiteralAcceptanceFromPlan(plan, {
    projectRoot,
    runner: options.runner,
    captureFromNarratives: options.captureFromNarratives,
    quiet: options.quiet,
  });

  // When literal path had nothing executable but plan.acceptance has derived commands,
  // run them directly with source=explicit semantics.
  if (
    base.ok &&
    base.runs.length === 0 &&
    acceptance.commands.length > 0 &&
    (acceptance.source_rung === "derived" || acceptance.source_rung === "project_floor")
  ) {
    const runner: LiteralAcceptanceRunner | undefined = options.runner;
    const direct = runLiteralAcceptanceCommands(
      acceptance.commands.map((c) => ({
        command: c.command,
        cwd: c.cwd ?? null,
        expectedStdout: c.expectedStdout ?? null,
        expectedExitCode: c.expectedExitCode ?? 0,
        source: "explicit" as const,
        sourceSpan: "plan.acceptance.commands",
      })),
      { projectRoot, runner, allowTaskStatement: options.allowTaskStatement },
    );
    return applyOracle(annotate(direct, acceptance, options.quiet), options);
  }

  // Check composition: mid-story unpromoted capture-only may soft-pass so the
  // framework graph is not deadlocked before agents promote peers.
  // Greptile P1 #3284: safety-rejected stated commands NEVER soft-pass — they
  // block product verification until a safe alternative is promoted.
  if (options.checkIntegrated === true && !base.ok && base.runs.length === 0) {
    const hasRejected = (base.rejected?.length ?? 0) > 0;
    if (hasRejected) {
      return applyOracle(annotate(base, acceptance, options.quiet), options);
    }
    const unpromoted =
      /capture-only|task_statement|no matching agent-promoted/i.test(base.message) ||
      (base.commands.length > 0 && base.commands.every((c) => c.source === "task_statement"));
    if (unpromoted || base.commands.length === 0) {
      return applyOracle(
        {
          ok: true,
          code: 0,
          message: options.quiet
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
        },
        options,
      );
    }
  }

  return applyOracle(annotate(base, acceptance, options.quiet), options);
}

function applyOracle(result: VerifyAcResult, options: EvaluateVerifyAcOptions): VerifyAcResult {
  if (options.applyOracleIntegrity === false) {
    return result;
  }
  const verdict = evaluateProductOracleIntegrity({
    projectRoot: resolve(options.projectRoot ?? process.cwd()),
    runSummaryText: options.runSummaryText,
    env: options.env ?? process.env,
  });
  return mergeOracleVerdict(result, verdict);
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
  return {
    ...result,
    message,
    sourceRung: acceptance.source_rung,
    noneStated: acceptance.none_stated,
    acceptance,
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
    return applyOracle(
      {
        ok: false,
        code: 2,
        message: `verify:ac: xBRIEF not found: ${abs}`,
        commands: [],
        runs: [],
        sourceRung: "project_floor",
        noneStated: true,
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      options,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return applyOracle(
      {
        ok: false,
        code: 2,
        message: `verify:ac: unreadable xBRIEF (${msg}): ${abs}`,
        commands: [],
        runs: [],
        sourceRung: "project_floor",
        noneStated: true,
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      options,
    );
  }
  const data = asRecord(parsed);
  if (data === null) {
    return applyOracle(
      {
        ok: false,
        code: 2,
        message: `verify:ac: xBRIEF top-level is not an object: ${abs}`,
        commands: [],
        runs: [],
        sourceRung: "project_floor",
        noneStated: true,
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      options,
    );
  }
  const plan = asRecord(data.plan);
  if (plan === null) {
    return applyOracle(
      {
        ok: false,
        code: 2,
        message: `verify:ac: xBRIEF missing plan object: ${abs}`,
        commands: [],
        runs: [],
        sourceRung: "project_floor",
        noneStated: true,
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      options,
    );
  }
  const result = evaluateVerifyAcFromPlan(plan, options);
  return maybeAttachAcPassBank(result, plan, abs, options);
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
      message:
        `verify:ac bank checkpoint failed (#3285): ${msg}` +
        (result.message ? `\n${result.message}` : ""),
    };
  }
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
  };
}

/** Pure: product AC is required at every ceremony depth (#3284 / #3267 / #3156). */
export function isVerifyAcRequiredAtCeremonyDepth(_depth: string | null | undefined): boolean {
  return true;
}
