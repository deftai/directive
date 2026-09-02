/**
 * One resolver for "does this artifact carry executable acceptance that passed?" (#3497).
 *
 * Before this module `verify:ac` and `scope:complete` read the same artifact through
 * two different lenses and reported two different things:
 *
 * - verify:ac composed a message from the sub-gates (`verify:ac passed`, `Literal
 *   acceptance-command gate passed`) and then flipped `ok` in a later stage
 *   (clause walk / no-op ledger / oracle integrity) without relabelling the message.
 * - scope:complete took that `ok=false` and asserted "empty or failing acceptance"
 *   even when acceptance was neither empty nor failing.
 *
 * Both now read the verdict here. One predicate name, one observed value, printed
 * identically by both consumers.
 *
 * This module is intentionally structural (no import of `VerifyAcResult`) so the
 * done-gate evaluator and the scope gate can both depend on it without a cycle.
 */

import { NOOP_ACCEPTANCE_REMEDIATION } from "../literal-acceptance/index.js";
import type { VerifyAcResolution } from "./empty-resolution.js";
import type { AcSourceRung } from "./types.js";

/**
 * Which check decided the acceptance verdict. Named in operator output so the
 * message can never again assert a predicate that did not fire (#3497).
 */
export type AcceptancePredicate =
  /** Executable acceptance commands ran and every one exited as expected. */
  | "executable-pass"
  /** Nothing executable to run and the project floor allows it. */
  | "empty-pass"
  /** plan.acceptance schema / brief could not be read. */
  | "config-error"
  /** A stated command cannot fail (#3396 no-op denylist). */
  | "noop-refused"
  /** Safety-rejected shell-shaped stated command(s) block completion (#3267). */
  | "safety-rejected"
  /** At least one executable command exited other than expected. */
  | "commands-failed"
  /** No executable acceptance stamped and no suite floor to stand on (#3334). */
  | "empty-acceptance"
  /** Derived clause walk contradicted the shipped artifact (#3323). */
  | "clause-walk-failed"
  /** Unresolved pass-after-fail-with-method-change (#3322). */
  | "integrity-discrepancy"
  /** Fell through every named predicate — carries the message lead verbatim. */
  | "unclassified";

export interface AcceptanceVerdict {
  readonly ok: boolean;
  readonly predicate: AcceptancePredicate;
  /** The value the deciding check actually read. Never a restatement of the rule. */
  readonly observed: string;
  /** What to change so the predicate stops firing. */
  readonly remedy: string;
}

/**
 * Structural view of a verify:ac result. `VerifyAcResult` satisfies this shape;
 * keeping it structural avoids an import cycle with `evaluate.ts`.
 */
export interface AcceptanceReading {
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
  readonly resolution: VerifyAcResolution;
  readonly sourceRung: AcSourceRung;
  readonly runs: readonly { readonly ok: boolean; readonly command: string }[];
  readonly commands: readonly unknown[];
  readonly rejected?: readonly { readonly command: string; readonly reason: string }[];
  readonly advisoryRejected?: readonly { readonly command: string }[];
  readonly clauseOutcomes?: readonly { readonly id: number; readonly outcome: string }[];
  readonly acceptance: { readonly commands: readonly unknown[] };
}

const REMEDY: Record<AcceptancePredicate, string> = {
  "executable-pass": "",
  "empty-pass": "",
  "config-error": "fix plan.acceptance so it matches the #3284 schema, then re-run task verify:ac",
  "noop-refused": NOOP_ACCEPTANCE_REMEDIATION,
  "safety-rejected":
    "promote a safe alternative into plan.metadata.swarm.verify_commands or remove the stated command from the task statement (#3267)",
  "commands-failed":
    "fix the product until the stated acceptance command exits as expected — the command, not the gate, is the oracle (#3284)",
  "empty-acceptance":
    "stamp executable commands on plan.acceptance.commands (or plan.metadata.swarm.verify_commands) with source_rung derived|project_floor (#3334)",
  "clause-walk-failed":
    "ship the artifact each failed clause names, or bind the clause to the path it actually landed at (#3323)",
  "integrity-discrepancy":
    "resolve by a product change under the same method, or independently re-derive both sides and record independent_rederivation=true (#3322)",
  unclassified: "read the verify:ac message below; the deciding check did not name itself",
};

function countClauses(reading: AcceptanceReading, outcome: string): number {
  return (reading.clauseOutcomes ?? []).filter((row) => row.outcome === outcome).length;
}

function firstLine(message: string): string {
  const line = message.split("\n").find((row) => row.trim().length > 0);
  return line === undefined ? "(no detail)" : line.trim();
}

function verdict(ok: boolean, predicate: AcceptancePredicate, observed: string): AcceptanceVerdict {
  return { ok, predicate, observed, remedy: REMEDY[predicate] };
}

/** Executable command count this reading resolved (stamped or ledger). */
export function resolvedAcceptanceCommandCount(reading: AcceptanceReading): number {
  return Math.max(reading.commands.length, reading.acceptance.commands.length);
}

/**
 * One row of the resolved literal+swarm+narrative contract (#4060).
 * Identity is command + cwd + expectedExitCode -- not plan.acceptance.commands.length.
 */
export interface AcceptanceLedgerEntry {
  readonly command: string;
  readonly cwd?: string | null;
  readonly expectedExitCode?: number;
}

function asLedgerRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Stable identity for one executable acceptance command. */
export function acceptanceLedgerKey(entry: AcceptanceLedgerEntry): string {
  const cwd =
    entry.cwd !== undefined && entry.cwd !== null && String(entry.cwd).trim().length > 0
      ? String(entry.cwd).trim()
      : "";
  const exit = typeof entry.expectedExitCode === "number" ? entry.expectedExitCode : 0;
  return `${entry.command}\0${cwd}\0${String(exit)}`;
}

/** Coerce a bank/cache snapshot command list into ledger entries. */
export function readAcceptanceLedger(
  raw: readonly unknown[] | null | undefined,
): AcceptanceLedgerEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AcceptanceLedgerEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push({ command: item.trim(), cwd: null, expectedExitCode: 0 });
      continue;
    }
    const rec = asLedgerRecord(item);
    if (rec === null || typeof rec.command !== "string" || rec.command.trim().length === 0) {
      continue;
    }
    out.push({
      command: rec.command.trim(),
      cwd: typeof rec.cwd === "string" ? rec.cwd : null,
      expectedExitCode: typeof rec.expectedExitCode === "number" ? rec.expectedExitCode : 0,
    });
  }
  return out;
}

/**
 * Swarm-only banks are eligible only when both ledgers are non-empty and equal.
 * Truly empty stays refused. 0-run verified-pass is not this allow-list (#4060).
 */
export function acceptanceLedgersEqual(
  current: readonly AcceptanceLedgerEntry[],
  minted: readonly AcceptanceLedgerEntry[],
): boolean {
  if (current.length === 0 || minted.length === 0) return false;
  if (current.length !== minted.length) return false;
  for (let i = 0; i < current.length; i += 1) {
    const left = current[i];
    const right = minted[i];
    if (left === undefined || right === undefined) return false;
    if (acceptanceLedgerKey(left) !== acceptanceLedgerKey(right)) return false;
  }
  return true;
}

/**
 * Name the predicate that decided this verify:ac result, and the value it read.
 *
 * Order matters: the earliest fail-closed stage wins so the operator is pointed at
 * the check that actually refused rather than a downstream symptom.
 */
export function resolveAcceptanceVerdict(reading: AcceptanceReading): AcceptanceVerdict {
  const commandCount = resolvedAcceptanceCommandCount(reading);
  const greenRuns = reading.runs.filter((run) => run.ok).length;
  const failedRuns = reading.runs.filter((run) => !run.ok);

  if (reading.ok) {
    if (reading.runs.length > 0) {
      return verdict(
        true,
        "executable-pass",
        `${greenRuns}/${reading.runs.length} command(s) exited as expected [rung=${reading.sourceRung}]`,
      );
    }
    return verdict(
      true,
      "empty-pass",
      `no executable command resolved; project floor allows it [rung=${reading.sourceRung}]`,
    );
  }

  if (reading.resolution === "config" || reading.code === 2) {
    return verdict(false, "config-error", firstLine(reading.message));
  }
  if (reading.resolution === "rejected-noop") {
    const noop = (reading.rejected ?? []).map((row) => row.command);
    return verdict(
      false,
      "noop-refused",
      noop.length > 0
        ? `blocking ledger command(s) that cannot fail: ${noop.join(", ")}`
        : firstLine(reading.message),
    );
  }
  const rejected = reading.rejected ?? [];
  if (rejected.length > 0) {
    return verdict(
      false,
      "safety-rejected",
      `${rejected.length} blocking safety-rejected command(s): ${rejected
        .map((row) => row.command)
        .join(", ")}`,
    );
  }
  if (failedRuns.length > 0) {
    return verdict(
      false,
      "commands-failed",
      `${failedRuns.length}/${reading.runs.length} command(s) did not exit as expected: ${failedRuns
        .map((row) => row.command)
        .join(", ")}`,
    );
  }
  if (reading.resolution === "soft_empty") {
    return verdict(
      false,
      "empty-acceptance",
      `plan.acceptance.commands=${commandCount}, runs=0 [rung=${reading.sourceRung}]`,
    );
  }
  if ((reading.clauseOutcomes?.length ?? 0) > 0) {
    const failed = countClauses(reading, "failed");
    const unverifiable = countClauses(reading, "unverifiable");
    const verified = countClauses(reading, "verified");
    return verdict(
      false,
      "clause-walk-failed",
      `clause walk read ${verified} verified, ${unverifiable} unverifiable, ${failed} failed ` +
        `against ${commandCount} stamped command(s) and ${reading.runs.length} run(s)`,
    );
  }
  if (/#3322/.test(reading.message)) {
    return verdict(false, "integrity-discrepancy", firstLine(reading.message));
  }
  if (commandCount === 0) {
    return verdict(
      false,
      "empty-acceptance",
      `plan.acceptance.commands=0, runs=0 [rung=${reading.sourceRung}]`,
    );
  }
  return verdict(false, "unclassified", firstLine(reading.message));
}

/** One line naming the predicate and the value it read (#3497). */
export function formatAcceptanceVerdict(verdictResult: AcceptanceVerdict): string {
  const lead = `acceptance verdict (#3497): ${verdictResult.predicate} — ${verdictResult.observed}`;
  if (verdictResult.ok || verdictResult.remedy.length === 0) {
    return lead;
  }
  return `${lead}\n  remedy: ${verdictResult.remedy}`;
}

/**
 * Clause-walk composition (#3323 / #3497 / #3826).
 *
 * A clause the shipped artifact contradicts (`failed`) always blocks. A clause the
 * static walk cannot decide (`unverifiable`) is evidence of nothing — it blocks only
 * when nothing else verified the product. A green executable acceptance run IS that
 * something: the product-first oracle already ran. Before #3497 an all-unverifiable
 * clause set refused an artifact whose stated command had just exited 0.
 *
 * #3826 excused a set the walk has no oracle for at all: a clause with no bound
 * artifact path can only ever come back `unverifiable`, so demanding a positive
 * `verified` from a set of them cannot be satisfied by doing the work correctly.
 * Where the walk has no oracle, `failed === 0` is the strongest verdict available
 * and `evaluateAcceptanceEvidenceGate` adjudicates those criteria at `scope:complete`.
 *
 * #3835 makes that excusal per clause. As a *set* predicate, `verified > 0` was
 * re-armed for every clause by any single bound one, so one verified binding
 * covered siblings that had their own oracle and did not meet it.
 * `adjudicableUnverified` counts exactly those siblings.
 */
export function clauseWalkBlocks(input: {
  readonly failed: number;
  readonly walked: number;
  /** Clauses the walk had an oracle for and that did not come back `verified`. */
  readonly adjudicableUnverified: number;
  readonly hasGreenExecutableRun: boolean;
}): boolean {
  if (input.failed > 0) {
    return true;
  }
  if (input.walked === 0 || input.adjudicableUnverified === 0) {
    return false;
  }
  return !input.hasGreenExecutableRun;
}

/** Which consumer is reading acceptance. Selects one shared option profile (#3497). */
export type AcceptanceReaderProfile =
  /** `task verify:ac -- <xbrief>` standalone done-gate run. */
  | "standalone"
  /** `task check` composition (`--soft-missing-xbrief`). */
  | "check"
  /** `scope:complete` hard precondition walk (#3357). */
  | "complete";

export interface AcceptanceGateProfileOptions {
  readonly captureFromNarratives: boolean | undefined;
  readonly checkIntegrated: boolean;
  readonly reuseMode: "auto" | "bank" | "never";
}

/**
 * The single option set each reader uses. Previously verify:ac and scope:complete
 * hand-assembled divergent option objects at their call sites (#3497).
 */
export function resolveAcceptanceGateProfile(
  profile: AcceptanceReaderProfile,
): AcceptanceGateProfileOptions {
  switch (profile) {
    case "check":
      // Re-scanning issue prose during `task check` re-captures backtick lines
      // as rejected and deadlocks the graph (#3323).
      return { captureFromNarratives: false, checkIntegrated: true, reuseMode: "auto" };
    case "complete":
      // Completion re-scans narratives so a narrative-only stated command fails
      // closed rather than being skipped, and never serves from a same-session cache.
      return { captureFromNarratives: true, checkIntegrated: false, reuseMode: "bank" };
    default:
      return { captureFromNarratives: undefined, checkIntegrated: false, reuseMode: "auto" };
  }
}
