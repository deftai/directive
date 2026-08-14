/**
 * Hand-authored briefs run #3323 clause derivation on activate/promote (#3360).
 *
 * issue:ingest already stamps clauses. The dominant consumer path authors the
 * brief by hand; #3334 only required plan.acceptance to exist. This module is
 * the missing derive step.
 */

import { ENV_RUN_SUMMARY_PATH, RunSummaryEmitter } from "../run-summary/index.js";
import {
  type AcceptanceClause,
  deriveAcceptanceClauses,
  readAcceptanceClauses,
  serializeAcceptanceClauses,
} from "../verify-ac/clauses.js";

const NARRATIVE_KEYS = [
  "Overview",
  "Description",
  "Acceptance",
  "AcceptanceCriteria",
  "Acceptance sketch",
  "AcceptanceSketch",
  "Test",
  "Verification",
  "ImplementationPlan",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when activate/promote must run #3323 (absent, empty none_stated, or command-only). */
export function needsClauseDerivation(acceptance: unknown): boolean {
  if (acceptance === undefined || acceptance === null) {
    return true;
  }
  const rec = asRecord(acceptance);
  if (rec === null) {
    return true;
  }
  return !(Array.isArray(rec.clauses) && rec.clauses.length > 0);
}

/** Task-statement text from title, narratives, and item Acceptance fields. */
export function collectTaskStatementFromPlan(plan: Record<string, unknown>): string {
  const parts: string[] = [];
  if (isNonEmptyString(plan.title)) {
    parts.push(plan.title.trim());
  }
  const narratives = asRecord(plan.narratives);
  if (narratives !== null) {
    const seen = new Set<string>();
    for (const key of NARRATIVE_KEYS) {
      const value = narratives[key];
      if (isNonEmptyString(value)) {
        parts.push(value.trim());
        seen.add(key.toLowerCase());
      }
    }
    for (const [key, value] of Object.entries(narratives)) {
      if (seen.has(key.toLowerCase()) || !isNonEmptyString(value)) {
        continue;
      }
      parts.push(value.trim());
    }
  }
  if (Array.isArray(plan.items)) {
    for (const item of plan.items) {
      const rec = asRecord(item);
      if (rec === null) {
        continue;
      }
      const narrative = asRecord(rec.narrative);
      const text = narrative?.Acceptance;
      if (isNonEmptyString(text)) {
        parts.push(text.trim());
      }
    }
  }
  return parts.join("\n\n");
}

export interface ClauseDerivationResult {
  readonly applied: boolean;
  readonly clauses: readonly AcceptanceClause[];
  readonly notice: string;
}

function formatAmbiguousClauseNotice(clauses: readonly AcceptanceClause[]): string {
  const flagged = clauses.filter((clause) => clause.ambiguous);
  const lines = [
    `#3323 clause derivation stamped ${clauses.length} clause(s)` +
      (flagged.length > 0 ? `; flagged-ambiguous: ${flagged.length}` : ""),
  ];
  for (const clause of flagged) {
    const chosen = clause.chosen_reading ?? 0;
    const chosenPath = clause.readings?.[chosen]?.artifact_path ?? clause.artifact_path ?? "(none)";
    lines.push(
      `  clause ${clause.id}: two readings; chosen_reading=${chosen} (${chosenPath}) [headless #3323]`,
    );
    for (const [index, reading] of (clause.readings ?? []).entries()) {
      lines.push(`    reading ${index}: ${reading.artifact_path ?? "(none)"}`);
    }
  }
  return lines.join("\n");
}

/**
 * Stamp derived clauses onto plan.acceptance in place. Headless: records
 * chosen_reading, never blocks on a question.
 */
export function applyClauseDerivationToPlan(
  plan: Record<string, unknown>,
  options: { readonly projectRoot?: string; readonly emitStamp?: boolean } = {},
): ClauseDerivationResult {
  if (!needsClauseDerivation(plan.acceptance)) {
    return {
      applied: false,
      clauses: readAcceptanceClauses(plan.acceptance),
      notice: "",
    };
  }
  const clauses = deriveAcceptanceClauses(collectTaskStatementFromPlan(plan));
  if (clauses.length === 0) {
    return { applied: false, clauses: [], notice: "" };
  }
  const existing = asRecord(plan.acceptance);
  const commands = existing !== null && Array.isArray(existing.commands) ? existing.commands : [];
  const hasCommands = commands.length > 0;
  const noneStated = hasCommands ? existing?.none_stated === true : true;
  const sourceRung =
    hasCommands && existing?.none_stated !== true
      ? isNonEmptyString(existing?.source_rung)
        ? existing.source_rung
        : "stated"
      : "derived";
  plan.acceptance = {
    ...(existing ?? {}),
    commands: hasCommands ? commands : [],
    none_stated: noneStated,
    source_rung: sourceRung,
    derived_reason: `derived ${clauses.length} independently testable clauses from the task statement before product edit (#3323)`,
    clauses: serializeAcceptanceClauses(clauses),
  };
  if (options.emitStamp !== false && options.projectRoot !== undefined) {
    emitAcceptanceStampFromPlan(options.projectRoot, plan);
  }
  return {
    applied: true,
    clauses,
    notice: formatAmbiguousClauseNotice(clauses),
  };
}

/** Fail-open acceptance_stamp emission (same contract as issue:ingest / #3355). */
export function emitAcceptanceStampFromPlan(projectRoot: string, plan: unknown): void {
  const rec = asRecord(plan);
  if (rec === null) {
    return;
  }
  const acceptance = asRecord(rec.acceptance);
  if (acceptance === null) {
    return;
  }
  const env = process.env;
  const dest = env[ENV_RUN_SUMMARY_PATH];
  if (dest === undefined || dest.trim().length === 0) {
    return;
  }
  try {
    const sessionId =
      typeof env.DEFT_SESSION_ID === "string" && env.DEFT_SESSION_ID.trim().length > 0
        ? env.DEFT_SESSION_ID.trim()
        : "clause-derivation";
    const emitter = new RunSummaryEmitter({ projectRoot, sessionId, env });
    const commands = Array.isArray(acceptance.commands) ? acceptance.commands.length : 0;
    const clauses = Array.isArray(acceptance.clauses) ? acceptance.clauses.length : 0;
    emitter.emitAcceptanceStamp({
      rung: typeof acceptance.source_rung === "string" ? acceptance.source_rung : "project_floor",
      none_stated: acceptance.none_stated === true,
      command_count: commands,
      clause_count: clauses,
    });
  } catch {
    // fail-open
  }
}
