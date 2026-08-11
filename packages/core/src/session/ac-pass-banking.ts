/**
 * AC-pass banking checkpoint (#3285).
 *
 * When stated acceptance criteria first pass, FINALIZE: record a durable bank
 * checkpoint, optionally append a bank-event to the run summary, and refuse
 * self-imposed deepening unless remaining budget meets the surplus threshold
 * (default 20% of max turns/cost). Post-bank out-of-scope findings are
 * reported, not chased, when surplus is insufficient.
 *
 * Sharpens #3266 bank-the-pass. Composes product-first done-gate (#3284) and
 * optional DEFT_RUN_SUMMARY_PATH telemetry (#3282 hook, fail-open).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import {
  type AcPassBankingConfig,
  DEFAULT_SURPLUS_THRESHOLD,
  resolveAcPassBanking,
} from "../policy/ac-pass-banking.js";
import type { HardEffortBudget, VerificationDepthPolicy } from "./effort-budget.js";
import { formatDeepeningSkippedNote, recommendVerificationDepth } from "./effort-budget.js";

/** Durable bank ledger directory (gitignored under `.deft/`). */
export const AC_PASS_BANK_DIR = ".deft/ac-pass-banks";

export const AC_PASS_BANK_SCHEMA_VERSION = 1 as const;

/** Env path for optional JSONL run summary (#3282). Unset = silent. */
export const ENV_RUN_SUMMARY_PATH = "DEFT_RUN_SUMMARY_PATH";

export type PostBankFindingAction = "report" | "chase" | "fix-regression";

export type AcPassNextAction = "still_open" | "finalize_and_ship" | "finalize_and_deepen";

export interface SurplusEvaluation {
  readonly hasSurplus: boolean;
  /** Remaining / max when both known; null when unknown. */
  readonly remainingFraction: number | null;
  readonly surplusThreshold: number;
  readonly axis: "turns" | "cost" | "both" | "unknown";
  readonly reason: string;
}

export interface PostBankFinding {
  readonly summary: string;
  readonly action: PostBankFindingAction;
  readonly recordedAt: string;
  readonly regressesStatedAc: boolean;
}

export interface AcPassBankRecord {
  readonly schemaVersion: typeof AC_PASS_BANK_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly bankedAt: string;
  readonly headSha: string | null;
  readonly remainingTurns: number | null;
  readonly remainingBudget: number | null;
  readonly maxTurns: number | null;
  readonly maxBudget: number | null;
  readonly surplusThreshold: number;
  readonly hadSurplus: boolean;
  readonly nextAction: Exclude<AcPassNextAction, "still_open">;
  readonly postBankFindings: readonly PostBankFinding[];
}

export interface EvaluateSurplusInput {
  readonly budget: HardEffortBudget;
  /** Fraction 0–1; default from policy / {@link DEFAULT_SURPLUS_THRESHOLD}. */
  readonly surplusThreshold?: number;
}

export interface EvaluateAcPassBankingInput {
  readonly budget: HardEffortBudget;
  /** Whether stated AC (verify:ac / official checker) is met. */
  readonly statedAcceptanceMet: boolean;
  readonly config?: Partial<AcPassBankingConfig>;
  /** Absolute turn reserve floor (still applied; #3266). Default 3. */
  readonly deepenReserveTurns?: number;
  readonly deepenReserveBudget?: number | null;
}

export interface AcPassBankingDecision {
  readonly nextAction: AcPassNextAction;
  readonly surplus: SurplusEvaluation;
  readonly depthPolicy: VerificationDepthPolicy;
  readonly deepeningAllowed: boolean;
  readonly notes: readonly string[];
}

export interface BankAcPassInput {
  readonly projectRoot: string;
  readonly scopeId: string;
  readonly budget: HardEffortBudget;
  readonly surplus: SurplusEvaluation;
  readonly nextAction: Exclude<AcPassNextAction, "still_open">;
  readonly headSha?: string | null;
  readonly now?: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
}

export interface DecidePostBankFindingInput {
  readonly findingSummary: string;
  readonly regressesStatedAc: boolean;
  readonly hasSurplus: boolean;
  readonly now?: string;
}

function utcIso(now?: string): string {
  if (now) return now;
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fractionOk(remaining: number, max: number, threshold: number): boolean {
  if (max <= 0) return remaining > 0 && threshold <= 0;
  return remaining / max >= threshold;
}

/**
 * Evaluate whether remaining budget meets the surplus threshold (#3285).
 *
 * When max is known: remaining/max >= threshold on every known axis.
 * When only remaining is known (no max): surplus is false (fail-safe) —
 * absolute #3266 reserve still applies separately via recommendVerificationDepth.
 */
export function evaluateSurplus(input: EvaluateSurplusInput): SurplusEvaluation {
  const threshold = input.surplusThreshold ?? DEFAULT_SURPLUS_THRESHOLD;
  const { budget } = input;

  if (!budget.detected) {
    return {
      hasSurplus: true,
      remainingFraction: null,
      surplusThreshold: threshold,
      axis: "unknown",
      reason: "unbounded budget — surplus gate inactive",
    };
  }

  const turnsKnown =
    budget.remainingTurns !== null && budget.maxTurns !== null && budget.maxTurns > 0;
  const costKnown =
    budget.remainingBudget !== null && budget.maxBudget !== null && budget.maxBudget > 0;

  if (!turnsKnown && !costKnown) {
    return {
      hasSurplus: false,
      remainingFraction: null,
      surplusThreshold: threshold,
      axis: "unknown",
      reason: "hard budget without max+remaining pair — refuse deepen (fail-safe surplus unknown)",
    };
  }

  let turnsOk = true;
  let costOk = true;
  let remFrac: number | null = null;
  let axis: SurplusEvaluation["axis"] = "unknown";

  if (turnsKnown) {
    const rem = budget.remainingTurns as number;
    const max = budget.maxTurns as number;
    turnsOk = fractionOk(rem, max, threshold);
    remFrac = rem / max;
    axis = "turns";
  }
  if (costKnown) {
    const rem = budget.remainingBudget as number;
    const max = budget.maxBudget as number;
    costOk = fractionOk(rem, max, threshold);
    const costFrac = rem / max;
    remFrac = remFrac === null ? costFrac : Math.min(remFrac, costFrac);
    axis = turnsKnown ? "both" : "cost";
  }

  const hasSurplus = turnsOk && costOk;
  const pct = Math.round(threshold * 100);
  const remPct = remFrac === null ? "?" : String(Math.round(remFrac * 100));
  return {
    hasSurplus,
    remainingFraction: remFrac,
    surplusThreshold: threshold,
    axis,
    reason: hasSurplus
      ? `surplus ok: remaining≈${remPct}% of max >= ${pct}% threshold (axis=${axis})`
      : `surplus insufficient: remaining≈${remPct}% of max < ${pct}% threshold (axis=${axis})`,
  };
}

/**
 * Full AC-pass banking decision: still open / finalize+ship / finalize+deepen.
 */
export function evaluateAcPassBanking(input: EvaluateAcPassBankingInput): AcPassBankingDecision {
  const enabled = input.config?.enabled ?? true;
  const surplusThreshold = input.config?.surplusThreshold ?? DEFAULT_SURPLUS_THRESHOLD;
  const surplus = evaluateSurplus({
    budget: input.budget,
    surplusThreshold,
  });

  if (!input.statedAcceptanceMet) {
    const depthPolicy = recommendVerificationDepth({
      budget: input.budget,
      statedAcceptanceMet: false,
      deepenReserveTurns: input.deepenReserveTurns,
      deepenReserveBudget: input.deepenReserveBudget,
      surplusThreshold,
    });
    return {
      nextAction: "still_open",
      surplus,
      depthPolicy,
      deepeningAllowed: false,
      notes: ["stated acceptance not yet met — bank the pass first (#3285/#3266)"],
    };
  }

  // AC met → FINALIZE is mandatory; deepen only with surplus + absolute reserve.
  const baseDepth = recommendVerificationDepth({
    budget: input.budget,
    statedAcceptanceMet: true,
    deepenReserveTurns: input.deepenReserveTurns,
    deepenReserveBudget: input.deepenReserveBudget,
    surplusThreshold: enabled ? surplusThreshold : null,
  });

  const notes: string[] = ["AC-pass bank checkpoint required (finalize-on-green) (#3285)"];

  if (!enabled || !input.budget.detected) {
    const deepen = baseDepth === "stated-then-deepen" || baseDepth === "unconstrained-deepen";
    return {
      nextAction: deepen ? "finalize_and_deepen" : "finalize_and_ship",
      surplus,
      depthPolicy: baseDepth,
      deepeningAllowed: deepen,
      notes: [
        ...notes,
        !enabled
          ? "acPassBanking.enabled=false — surplus gate inactive"
          : "unbounded budget — dual-stop still applies; bank is optional discipline",
      ],
    };
  }

  // Hard-capped + AC met: require surplus AND absolute reserve (baseDepth).
  const absoluteOk = baseDepth === "stated-then-deepen";
  const deepeningAllowed = surplus.hasSurplus && absoluteOk;
  const depthPolicy: VerificationDepthPolicy = deepeningAllowed
    ? "stated-then-deepen"
    : "stated-only";

  if (!deepeningAllowed) {
    notes.push(surplus.reason);
    notes.push(formatDeepeningSkippedNote(input.budget, surplus.reason));
  } else {
    notes.push(surplus.reason);
  }

  return {
    nextAction: deepeningAllowed ? "finalize_and_deepen" : "finalize_and_ship",
    surplus,
    depthPolicy,
    deepeningAllowed,
    notes,
  };
}

/**
 * Post-bank finding disposition: report (default) vs chase (only with surplus)
 * vs fix-regression (always when stated AC regressed).
 */
export function decidePostBankFinding(input: DecidePostBankFindingInput): PostBankFinding {
  const recordedAt = utcIso(input.now);
  if (input.regressesStatedAc) {
    return {
      summary: input.findingSummary,
      action: "fix-regression",
      recordedAt,
      regressesStatedAc: true,
    };
  }
  if (input.hasSurplus) {
    return {
      summary: input.findingSummary,
      action: "chase",
      recordedAt,
      regressesStatedAc: false,
    };
  }
  return {
    summary: input.findingSummary,
    action: "report",
    recordedAt,
    regressesStatedAc: false,
  };
}

export function acPassBanksDir(projectRoot: string): string {
  return join(resolve(projectRoot), ...AC_PASS_BANK_DIR.split("/"));
}

/** Stable filename for a scope bank record. */
export function acPassBankFilename(scopeId: string): string {
  const digest = createHash("sha256").update(scopeId, "utf8").digest("hex").slice(0, 16);
  const safe = scopeId
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${safe || "scope"}-${digest}.json`;
}

export function acPassBankPath(projectRoot: string, scopeId: string): string {
  return join(acPassBanksDir(projectRoot), acPassBankFilename(scopeId));
}

/**
 * Persist a bank checkpoint that survives session death (#3285).
 * Also appends a bank-event to DEFT_RUN_SUMMARY_PATH when set (fail-open).
 */
export function bankAcPass(input: BankAcPassInput): AcPassBankRecord {
  const bankedAt = utcIso(input.now);
  const record: AcPassBankRecord = {
    schemaVersion: AC_PASS_BANK_SCHEMA_VERSION,
    scopeId: input.scopeId,
    bankedAt,
    headSha: input.headSha ?? null,
    remainingTurns: input.budget.remainingTurns,
    remainingBudget: input.budget.remainingBudget,
    maxTurns: input.budget.maxTurns,
    maxBudget: input.budget.maxBudget,
    surplusThreshold: input.surplus.surplusThreshold,
    hadSurplus: input.surplus.hasSurplus,
    nextAction: input.nextAction,
    postBankFindings: [],
  };

  const root = resolve(input.projectRoot);
  const dir = acPassBanksDir(root);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = acPassBankPath(root, input.scopeId);
  containedWrite({
    root,
    target: path,
    data: `${JSON.stringify(record, null, 2)}\n`,
    mode: "replace",
  });

  appendBankEventToRunSummary({
    environ: input.environ ?? process.env,
    event: {
      type: "ac_pass_bank",
      schemaVersion: AC_PASS_BANK_SCHEMA_VERSION,
      scopeId: record.scopeId,
      bankedAt: record.bankedAt,
      nextAction: record.nextAction,
      hadSurplus: record.hadSurplus,
      surplusThreshold: record.surplusThreshold,
      remainingFraction: input.surplus.remainingFraction,
      remainingTurns: record.remainingTurns,
      remainingBudget: record.remainingBudget,
      maxTurns: record.maxTurns,
      maxBudget: record.maxBudget,
      headSha: record.headSha,
      path,
    },
  });

  return record;
}

/** Load a bank record when present. */
export function readAcPassBank(projectRoot: string, scopeId: string): AcPassBankRecord | null {
  const path = acPassBankPath(projectRoot, scopeId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, { encoding: "utf8" })) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return raw as AcPassBankRecord;
  } catch {
    return null;
  }
}

/**
 * Append a post-bank finding to an existing bank record (report/chase/fix).
 */
export function recordPostBankFinding(
  projectRoot: string,
  scopeId: string,
  finding: PostBankFinding,
): AcPassBankRecord | null {
  const existing = readAcPassBank(projectRoot, scopeId);
  if (existing === null) return null;
  const updated: AcPassBankRecord = {
    ...existing,
    postBankFindings: [...existing.postBankFindings, finding],
  };
  const root = resolve(projectRoot);
  containedWrite({
    root,
    target: acPassBankPath(root, scopeId),
    data: `${JSON.stringify(updated, null, 2)}\n`,
    mode: "replace",
  });
  return updated;
}

export interface BankEventPayload {
  readonly type: "ac_pass_bank" | "ac_pass_post_bank_finding" | "ac_pass_deepening_skipped";
  readonly schemaVersion: number;
  readonly scopeId?: string;
  readonly bankedAt?: string;
  readonly nextAction?: string;
  readonly hadSurplus?: boolean;
  readonly surplusThreshold?: number;
  readonly remainingFraction?: number | null;
  readonly remainingTurns?: number | null;
  readonly remainingBudget?: number | null;
  readonly maxTurns?: number | null;
  readonly maxBudget?: number | null;
  readonly headSha?: string | null;
  readonly path?: string;
  readonly finding?: PostBankFinding;
  readonly note?: string;
  readonly [key: string]: unknown;
}

/**
 * Format one JSONL bank-event line for run-summary telemetry (#3285 / #3282).
 */
export function formatBankEventLine(event: BankEventPayload): string {
  return JSON.stringify({
    ...event,
    ts: typeof event.bankedAt === "string" ? event.bankedAt : utcIso(),
    source: "ac-pass-banking",
    issue: 3285,
  });
}

/**
 * Append bank event to DEFT_RUN_SUMMARY_PATH when set.
 * Unset = silent. `-` = stdout. Failures warn once to stderr (fail-open).
 */
export function appendBankEventToRunSummary(input: {
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly event: BankEventPayload;
  readonly writeLine?: (path: string, line: string) => void;
  readonly warn?: (message: string) => void;
}): { written: boolean; path: string | null } {
  const environ = input.environ ?? process.env;
  const raw = (environ[ENV_RUN_SUMMARY_PATH] ?? "").trim();
  if (!raw) {
    return { written: false, path: null };
  }

  const line = `${formatBankEventLine(input.event)}\n`;
  if (raw === "-") {
    process.stdout.write(line);
    return { written: true, path: "-" };
  }

  try {
    if (input.writeLine) {
      input.writeLine(raw, line);
    } else {
      const abs = resolve(raw);
      const parent = dirname(abs);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
      // Contain under the parent directory of the summary file.
      containedWrite({
        root: parent,
        target: abs,
        data: line,
        mode: "append",
      });
    }
    return { written: true, path: raw };
  } catch (err: unknown) {
    const msg =
      err instanceof ContainedWriteError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    const warn = input.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
    warn(`[deft ac-pass-banking] run-summary write failed path=${raw}: ${msg} (#3285)`);
    return { written: false, path: raw };
  }
}

/**
 * Simulated run used by the surplus-insufficient acceptance test (#3285):
 * AC passes → bank → extra checks would exceed budget → ship + report finding.
 */
export function simulateSurplusInsufficientRun(input: {
  readonly projectRoot: string;
  readonly scopeId: string;
  readonly budget: HardEffortBudget;
  readonly findingSummary: string;
  readonly surplusThreshold?: number;
  readonly headSha?: string | null;
  readonly now?: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
}): {
  readonly decision: AcPassBankingDecision;
  readonly bank: AcPassBankRecord;
  readonly finding: PostBankFinding;
  readonly shipped: boolean;
  readonly findingAction: PostBankFindingAction;
} {
  const config: Partial<AcPassBankingConfig> = {
    enabled: true,
    surplusThreshold: input.surplusThreshold ?? DEFAULT_SURPLUS_THRESHOLD,
  };
  const decision = evaluateAcPassBanking({
    budget: input.budget,
    statedAcceptanceMet: true,
    config,
  });
  const nextAction =
    decision.nextAction === "still_open" ? "finalize_and_ship" : decision.nextAction;
  const bank = bankAcPass({
    projectRoot: input.projectRoot,
    scopeId: input.scopeId,
    budget: input.budget,
    surplus: decision.surplus,
    nextAction,
    headSha: input.headSha ?? null,
    now: input.now,
    environ: input.environ,
  });
  const finding = decidePostBankFinding({
    findingSummary: input.findingSummary,
    regressesStatedAc: false,
    hasSurplus: decision.surplus.hasSurplus,
    now: input.now,
  });
  recordPostBankFinding(input.projectRoot, input.scopeId, finding);
  const shipped = !decision.deepeningAllowed || finding.action === "report";
  return {
    decision,
    bank,
    finding,
    shipped: shipped || nextAction === "finalize_and_ship",
    findingAction: finding.action,
  };
}

/**
 * Resolve policy config for a project root (typed → env → default).
 */
export function resolveBankingConfigForRoot(
  projectRoot?: string | null,
  environ?: Readonly<Record<string, string | undefined>>,
): AcPassBankingConfig {
  const resolved = resolveAcPassBanking(projectRoot, environ ?? process.env);
  return {
    enabled: resolved.enabled,
    surplusThreshold: resolved.surplusThreshold,
  };
}
