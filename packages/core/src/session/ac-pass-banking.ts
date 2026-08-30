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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import {
  type AcPassBankingConfig,
  DEFAULT_SURPLUS_THRESHOLD,
  resolveAcPassBanking,
} from "../policy/ac-pass-banking.js";
import { RunSummaryEmitter } from "../run-summary/emit.js";
import type { HardEffortBudget, VerificationDepthPolicy } from "./effort-budget.js";
import {
  detectHardEffortBudget,
  formatDeepeningSkippedNote,
  recommendVerificationDepth,
} from "./effort-budget.js";
import { gitHead } from "./git.js";

/** Durable bank ledger directory (under already-ignored `.deft/cache/`). */
export const AC_PASS_BANK_DIR = ".deft/cache/ac-pass-banks";

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
  /** Product+acceptance digest; missing/empty is stale for #3387 reuse. */
  readonly productStateHash?: string | null;
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
  readonly productStateHash?: string | null;
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

/**
 * Sanitize scopeId for a ledger filename without unbounded quantifiers (CodeQL).
 * Walks characters once — O(n), no ReDoS risk on pathological "-" runs.
 */
export function sanitizeScopeIdForFilename(scopeId: string): string {
  const out: string[] = [];
  let prevDash = false;
  for (let i = 0; i < scopeId.length && out.length < 48; i += 1) {
    const ch = scopeId[i] as string;
    const code = ch.charCodeAt(0);
    const alnum =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const ok = alnum || ch === "." || ch === "_" || ch === "-";
    if (ok) {
      if (ch === "-") {
        if (prevDash || out.length === 0) continue;
        prevDash = true;
        out.push("-");
      } else {
        prevDash = false;
        out.push(ch);
      }
    } else if (!prevDash && out.length > 0) {
      prevDash = true;
      out.push("-");
    }
  }
  while (out.length > 0 && out[out.length - 1] === "-") {
    out.pop();
  }
  return out.join("") || "scope";
}

/** Stable filename for a scope bank record. */
export function acPassBankFilename(scopeId: string): string {
  const digest = createHash("sha256").update(scopeId, "utf8").digest("hex").slice(0, 16);
  const safe = sanitizeScopeIdForFilename(scopeId);
  return `${safe}-${digest}.json`;
}

export function acPassBankPath(projectRoot: string, scopeId: string): string {
  return join(acPassBanksDir(projectRoot), acPassBankFilename(scopeId));
}

/**
 * Persist a bank checkpoint that survives session death (#3285).
 * Also appends a bank-event to DEFT_RUN_SUMMARY_PATH when set (fail-open).
 */
/** Append-only findings journal (never truncated by re-bank). */
export function acPassFindingsJournalPath(projectRoot: string, scopeId: string): string {
  return `${acPassBankPath(projectRoot, scopeId)}.findings.jsonl`;
}

function readFindingsJournal(projectRoot: string, scopeId: string): readonly PostBankFinding[] {
  const jpath = acPassFindingsJournalPath(projectRoot, scopeId);
  if (!existsSync(jpath)) return [];
  try {
    const text = readFileSync(jpath, { encoding: "utf8" });
    const out: PostBankFinding[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed: unknown = JSON.parse(t);
        if (isPostBankFinding(parsed)) out.push(parsed);
      } catch {
        // skip bad lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

function appendFindingsJournal(
  projectRoot: string,
  scopeId: string,
  findings: readonly PostBankFinding[],
): void {
  if (findings.length === 0) return;
  const root = resolve(projectRoot);
  const jpath = acPassFindingsJournalPath(root, scopeId);
  const dir = acPassBanksDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lines = findings.map((f) => JSON.stringify(f)).join("\n") + "\n";
  containedWrite({ root, target: jpath, data: lines, mode: "append" });
}

export function bankAcPass(input: BankAcPassInput): AcPassBankRecord {
  const bankedAt = utcIso(input.now);
  const root = resolve(input.projectRoot);
  const path = acPassBankPath(root, input.scopeId);
  const existed = existsSync(path);
  // Preserve prior post-bank findings on re-bank so ledger history survives (#3285 Greptile).
  const prior = readAcPassBank(input.projectRoot, input.scopeId);
  const journal = readFindingsJournal(input.projectRoot, input.scopeId);
  // Unrecoverable existing ledger (no findings recoverable): refuse overwrite.
  if (existed && prior === null) {
    throw new Error(
      `ac-pass-banking: unrecoverable existing ledger at ${path}; ` +
        `refusing overwrite and banked=true without write (#3285)`,
    );
  }
  // Partial recovery stub: do not treat stub as authoritative. Drop damaged
  // primary/tmp so the next write is a fresh bank seeded from the journal only.
  if (prior !== null && prior.bankedAt === "1970-01-01T00:00:00Z") {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // ignore
    }
    try {
      if (existsSync(`${path}.tmp`)) unlinkSync(`${path}.tmp`);
    } catch {
      // ignore
    }
  }

  const record: AcPassBankRecord = {
    schemaVersion: AC_PASS_BANK_SCHEMA_VERSION,
    scopeId: input.scopeId,
    bankedAt,
    headSha: input.headSha ?? null,
    productStateHash: input.productStateHash ?? prior?.productStateHash ?? null,
    remainingTurns: input.budget.remainingTurns,
    remainingBudget: input.budget.remainingBudget,
    maxTurns: input.budget.maxTurns,
    maxBudget: input.budget.maxBudget,
    surplusThreshold: input.surplus.surplusThreshold,
    hadSurplus: input.surplus.hasSurplus,
    nextAction: input.nextAction,
    // Journal is append-only SoT for findings across corrupt rewrites (#3285).
    postBankFindings: mergeFindings(prior?.postBankFindings ?? [], journal),
  };

  const dir = acPassBanksDir(root);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Crash-atomic replace: write tmp then rename. Never truncate live ledger.
  // If rename fails, keep .tmp as the durable checkpoint (read prefers newer).
  const tmpPath = `${path}.tmp`;
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  containedWrite({
    root,
    target: tmpPath,
    data: payload,
    mode: "replace",
  });
  let durablePath = path;
  try {
    renameSync(tmpPath, path);
  } catch {
    if (!existed) {
      // First bank: no prior ledger to protect — direct write is safe.
      containedWrite({ root, target: path, data: payload, mode: "replace" });
    } else {
      // Prior ledger preserved; .tmp holds the refreshed checkpoint.
      durablePath = tmpPath;
    }
  }

  try {
    const env = { ...(input.environ ?? process.env) };
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      env,
      component: "ac-pass-banking",
    });
    emitter.emitAcPassBank({
      scope_id: record.scopeId,
      banked_at: record.bankedAt,
      next_action: record.nextAction,
      had_surplus: record.hadSurplus,
      surplus_threshold: record.surplusThreshold,
      remaining_fraction: input.surplus.remainingFraction,
      remaining_turns: record.remainingTurns,
      remaining_budget: record.remainingBudget,
      max_turns: record.maxTurns,
      max_budget: record.maxBudget,
      head_sha: record.headSha,
      path: durablePath,
    });
  } catch {
    // fail-open
  }

  return record;
}

/**
 * Best-effort recovery of postBankFindings from a truncated/corrupt ledger
 * so re-bank cannot silently wipe history (#3285 Greptile residual).
 *
 * Handles complete arrays and truncated arrays (missing closing bracket)
 * by salvaging fully-closed finding objects.
 */
function isPostBankFinding(item: unknown): item is PostBankFinding {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as PostBankFinding).summary === "string" &&
    typeof (item as PostBankFinding).action === "string"
  );
}

/** Recover complete JSON objects from a (possibly truncated) array body. */
export function recoverCompleteJsonObjects(arrayBody: string): readonly unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < arrayBody.length) {
    while (i < arrayBody.length && arrayBody[i] !== "{") i += 1;
    if (i >= arrayBody.length) break;
    const startObj = i;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let closed = false;
    for (; i < arrayBody.length; i += 1) {
      const ch = arrayBody[i] as string;
      if (inString) {
        if (escapeNext) escapeNext = false;
        else if (ch === "\\") escapeNext = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            out.push(JSON.parse(arrayBody.slice(startObj, i + 1)));
          } catch {
            // skip incomplete object
          }
          i += 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) break;
  }
  return out;
}

export function recoverFindingsFromLedgerText(raw: string): readonly PostBankFinding[] {
  const key = '"postBankFindings"';
  const idx = raw.indexOf(key);
  if (idx < 0) return [];
  let i = idx + key.length;
  while (
    i < raw.length &&
    (raw[i] === " " || raw[i] === "\t" || raw[i] === "\n" || raw[i] === "\r" || raw[i] === ":")
  ) {
    i += 1;
  }
  if (raw[i] !== "[") return [];
  const arrayStart = i + 1;
  let depth = 0;
  for (let j = i; j < raw.length; j += 1) {
    const ch = raw[j];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(raw.slice(i, j + 1));
          if (Array.isArray(parsed)) {
            return parsed.filter(isPostBankFinding);
          }
        } catch {
          // fall through to partial recovery
        }
        break;
      }
    }
  }
  return recoverCompleteJsonObjects(raw.slice(arrayStart)).filter(isPostBankFinding);
}

function recoveredStubRecord(
  scopeId: string,
  findings: readonly PostBankFinding[],
): AcPassBankRecord {
  return {
    schemaVersion: AC_PASS_BANK_SCHEMA_VERSION,
    scopeId,
    // Epoch so recovery stubs never win fresher-metadata selection over a
    // valid primary ledger (#3285 Greptile residual).
    bankedAt: "1970-01-01T00:00:00Z",
    headSha: null,
    productStateHash: null,
    remainingTurns: null,
    remainingBudget: null,
    maxTurns: null,
    maxBudget: null,
    surplusThreshold: DEFAULT_SURPLUS_THRESHOLD,
    hadSurplus: false,
    nextAction: "finalize_and_ship",
    postBankFindings: findings,
  };
}

/**
 * Load a bank record when present. Corrupt files recover findings when possible
 * so re-bank preserves post-bank history (#3285).
 */
function parseBankText(scopeId: string, text: string): AcPassBankRecord | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      const findings = recoverFindingsFromLedgerText(text);
      return findings.length > 0 ? recoveredStubRecord(scopeId, findings) : null;
    }
    const rec = raw as AcPassBankRecord;
    if (!Array.isArray(rec.postBankFindings)) {
      return {
        ...rec,
        postBankFindings: recoverFindingsFromLedgerText(text),
      };
    }
    return rec;
  } catch {
    const findings = recoverFindingsFromLedgerText(text);
    return findings.length > 0 ? recoveredStubRecord(scopeId, findings) : null;
  }
}

function mergeFindings(
  a: readonly PostBankFinding[],
  b: readonly PostBankFinding[],
): readonly PostBankFinding[] {
  const out: PostBankFinding[] = [];
  const seen = new Set<string>();
  for (const f of [...a, ...b]) {
    const key = `${f.action}|${f.summary}|${f.recordedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Load bank record. When both primary and .tmp exist, prefer a fully-valid
 * JSON primary over a partial tmp, and union recovered findings so partial
 * recovery cannot erase durable history (#3285 Greptile residual).
 */
export function readAcPassBank(projectRoot: string, scopeId: string): AcPassBankRecord | null {
  const path = acPassBankPath(projectRoot, scopeId);
  const tmpPath = `${path}.tmp`;
  let primaryText: string | null = null;
  let tmpText: string | null = null;
  if (existsSync(path)) {
    try {
      primaryText = readFileSync(path, { encoding: "utf8" });
    } catch {
      primaryText = null;
    }
  }
  if (existsSync(tmpPath)) {
    try {
      tmpText = readFileSync(tmpPath, { encoding: "utf8" });
    } catch {
      tmpText = null;
    }
  }
  if (primaryText === null && tmpText === null) return null;

  const primary = primaryText !== null ? parseBankText(scopeId, primaryText) : null;
  const tmp = tmpText !== null ? parseBankText(scopeId, tmpText) : null;

  const journal = readFindingsJournal(projectRoot, scopeId);

  // Prefer fresher fully-parsed record for metadata; always union findings + journal.
  if (primary !== null && tmp !== null) {
    const base = tmp.bankedAt >= primary.bankedAt ? tmp : primary;
    const other = base === tmp ? primary : tmp;
    return {
      ...base,
      postBankFindings: mergeFindings(
        mergeFindings(base.postBankFindings, other.postBankFindings),
        journal,
      ),
    };
  }
  if (primary !== null) {
    return {
      ...primary,
      postBankFindings: mergeFindings(primary.postBankFindings, journal),
    };
  }
  if (tmp !== null) {
    return {
      ...tmp,
      postBankFindings: mergeFindings(tmp.postBankFindings, journal),
    };
  }

  // Both unparsable as records: union raw recoveries + journal.
  const findings = mergeFindings(
    mergeFindings(
      primaryText !== null ? recoverFindingsFromLedgerText(primaryText) : [],
      tmpText !== null ? recoverFindingsFromLedgerText(tmpText) : [],
    ),
    journal,
  );
  return findings.length > 0 ? recoveredStubRecord(scopeId, findings) : null;
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
  // Durable append-only journal first so re-bank cannot lose this finding.
  appendFindingsJournal(projectRoot, scopeId, [finding]);
  const updated: AcPassBankRecord = {
    ...existing,
    postBankFindings: mergeFindings(existing.postBankFindings, [finding]),
  };
  const root = resolve(projectRoot);
  const path = acPassBankPath(root, scopeId);
  const tmpPath = `${path}.tmp`;
  const payload = `${JSON.stringify(updated, null, 2)}\n`;
  containedWrite({ root, target: tmpPath, data: payload, mode: "replace" });
  try {
    renameSync(tmpPath, path);
  } catch {
    // leave .tmp; journal already durable
  }
  return updated;
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

export interface MaybeBankOnAcPassInput {
  readonly projectRoot: string;
  /** plan.id or path-derived scope key. */
  readonly scopeId: string;
  readonly budget?: HardEffortBudget;
  readonly config?: Partial<AcPassBankingConfig>;
  readonly headSha?: string | null;
  readonly now?: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  /**
   * Only bank when real acceptance commands executed and passed.
   * Soft/advisory passes with zero runs do not bank.
   */
  readonly executableRuns: number;
  readonly quiet?: boolean;
  readonly productStateHash?: string | null;
  /**
   * Bank a verified-pass walk even when no shell runs were recorded (#3558).
   * Soft/advisory empty passes still skip via executableRuns === 0.
   */
  readonly verifiedPass?: boolean;
}

export interface MaybeBankOnAcPassResult {
  readonly banked: boolean;
  readonly decision: AcPassBankingDecision | null;
  readonly bank: AcPassBankRecord | null;
  readonly notes: readonly string[];
}

/**
 * Production bridge (#3285 Greptile P1): after verify:ac reports executable
 * success, FINALIZE the bank checkpoint + surplus decision.
 * Throws on I/O failure so verify:ac can fail closed (checkpoint mandatory).
 */
export function maybeBankOnAcPass(input: MaybeBankOnAcPassInput): MaybeBankOnAcPassResult {
  if (input.executableRuns <= 0 && input.verifiedPass !== true) {
    return { banked: false, decision: null, bank: null, notes: [] };
  }
  const budget = input.budget ?? detectHardEffortBudget({ environ: input.environ ?? process.env });
  const config =
    input.config ?? resolveBankingConfigForRoot(input.projectRoot, input.environ ?? process.env);
  const decision = evaluateAcPassBanking({
    budget,
    statedAcceptanceMet: true,
    config,
  });
  const nextAction =
    decision.nextAction === "still_open" ? "finalize_and_ship" : decision.nextAction;
  const bank = bankAcPass({
    projectRoot: input.projectRoot,
    scopeId: input.scopeId,
    budget,
    surplus: decision.surplus,
    nextAction,
    headSha: input.headSha !== undefined ? input.headSha : gitHead(input.projectRoot).head,
    productStateHash: input.productStateHash ?? null,
    now: input.now,
    environ: input.environ,
  });
  const notes = [
    ...decision.notes,
    `[deft ac-pass-banking] banked scope=${input.scopeId} next=${nextAction} ` +
      `had_surplus=${decision.surplus.hasSurplus} (#3285)`,
  ];
  return { banked: true, decision, bank, notes };
}
