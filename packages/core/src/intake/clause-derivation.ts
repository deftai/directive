/**
 * Hand-authored briefs run #3323 clause derivation on activate/promote (#3360).
 *
 * issue:ingest already stamps clauses. The dominant consumer path authors the
 * brief by hand; #3334 only required plan.acceptance to exist. This module is
 * the missing derive step.
 */

import {
  type AcceptanceStampRunSummaryPayload,
  ENV_RUN_SUMMARY_PATH,
  RunSummaryEmitter,
} from "../run-summary/index.js";
import {
  type AcceptanceClause,
  deriveAcceptanceClauses,
  readAcceptanceClauses,
  serializeAcceptanceClauses,
} from "../verify-ac/clauses.js";

/** One-line remediation when a stamp has no statement-traceable clause (#3398). */
export const CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION =
  "derive clauses from the statement's testable constraints";

export type ClauseProvenance = "statement" | "implementation";

export interface ProvenanceCounts {
  readonly statement: number;
  readonly implementation: number;
}

export interface TracedAcceptanceClause extends AcceptanceClause {
  readonly provenance: ClauseProvenance;
}

export interface ClauseStampPreparation {
  readonly ok: boolean;
  readonly clauses: readonly TracedAcceptanceClause[];
  readonly provenance_counts: ProvenanceCounts;
  readonly ambiguity_attestation?: "none_found";
  readonly remediation?: string;
}

export interface AmbiguityAttestationCheck {
  readonly ok: boolean;
  readonly attested: boolean;
  readonly kind: "ambiguous-clause" | "none_found" | "missing";
  readonly message: string;
}

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
  readonly clauses: readonly (AcceptanceClause | TracedAcceptanceClause)[];
  readonly notice: string;
}

function hasAmbiguousReadings(clause: AcceptanceClause): boolean {
  return clause.ambiguous === true && (clause.readings?.length ?? 0) > 0;
}

function extractClauseTokens(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const token = raw.trim();
    if (token.length < 2 || seen.has(token)) {
      return;
    }
    seen.add(token);
    found.push(token);
  };
  const quoted = /["'`]([^"'`\n]{2,80})["'`]/g;
  let match = quoted.exec(text);
  while (match !== null) {
    push(match[1] ?? "");
    match = quoted.exec(text);
  }
  const pathRe =
    /(?<![A-Za-z0-9_])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]+)(?![A-Za-z0-9_])/g;
  match = pathRe.exec(text);
  while (match !== null) {
    push(match[1] ?? "");
    match = pathRe.exec(text);
  }
  const ident = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g;
  match = ident.exec(text);
  while (match !== null) {
    const token = match[1] ?? "";
    const camelOrPascal = /[a-z][A-Z]/.test(token) || /[A-Z][a-z]+[A-Z]/.test(token);
    const codeShaped = camelOrPascal || token.includes("_");
    if (codeShaped) {
      push(token);
    }
    match = ident.exec(text);
  }
  return found;
}

/** Statement-traceable when the clause text or its identifiers appear in the statement. */
export function traceClauseProvenance(
  clause: AcceptanceClause,
  statement: string,
): ClauseProvenance {
  const normClause = clause.text.replace(/\s+/g, " ").trim();
  const normStatement = statement.replace(/\s+/g, " ").trim();
  if (normClause.length > 0 && normStatement.includes(normClause)) {
    return "statement";
  }
  const tokens = extractClauseTokens(clause.text);
  if (tokens.length === 0) {
    return "implementation";
  }
  return tokens.every((token) => statement.includes(token)) ? "statement" : "implementation";
}

export function countClauseProvenance(
  clauses: readonly TracedAcceptanceClause[],
): ProvenanceCounts {
  let statement = 0;
  let implementation = 0;
  for (const clause of clauses) {
    if (clause.provenance === "statement") {
      statement += 1;
    } else {
      implementation += 1;
    }
  }
  return { statement, implementation };
}

/** Fail closed when every clause is implementation-provenance; else attest ambiguity. */
export function prepareClauseStamp(
  clauses: readonly AcceptanceClause[],
  statement: string,
): ClauseStampPreparation {
  const traced: TracedAcceptanceClause[] = clauses.map((clause) => ({
    ...clause,
    provenance: traceClauseProvenance(clause, statement),
  }));
  const provenance_counts = countClauseProvenance(traced);
  if (traced.length > 0 && provenance_counts.statement === 0) {
    return {
      ok: false,
      clauses: traced,
      provenance_counts,
      remediation: CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION,
    };
  }
  return {
    ok: true,
    clauses: traced,
    provenance_counts,
    ambiguity_attestation: traced.some(hasAmbiguousReadings) ? undefined : "none_found",
  };
}

const AMBIGUITY_ATTESTATION_MISSING =
  "verify:ac config error: missing ambiguity attestation; record at least one ambiguous: true clause with readings, or set ambiguity_attestation: none_found";

/** Config-error surface for verify:ac: attestation or an ambiguous clause with readings. */
export function evaluateAmbiguityAttestation(acceptance: unknown): AmbiguityAttestationCheck {
  const rec = asRecord(acceptance);
  if (rec === null) {
    return { ok: false, attested: false, kind: "missing", message: AMBIGUITY_ATTESTATION_MISSING };
  }
  const clauses = readAcceptanceClauses(rec);
  if (clauses.some(hasAmbiguousReadings)) {
    return { ok: true, attested: true, kind: "ambiguous-clause", message: "" };
  }
  if (rec.ambiguity_attestation === "none_found") {
    return { ok: true, attested: true, kind: "none_found", message: "" };
  }
  return { ok: false, attested: false, kind: "missing", message: AMBIGUITY_ATTESTATION_MISSING };
}

function serializeTracedClauses(
  clauses: readonly TracedAcceptanceClause[],
): Record<string, unknown>[] {
  return serializeAcceptanceClauses(clauses).map((row, index) => ({
    ...row,
    provenance: clauses[index]?.provenance ?? "implementation",
  }));
}

/**
 * Annotate stamped clauses with provenance and an ambiguity attestation.
 * An all-implementation stamp is stripped (never sufficient alone).
 */
export function applyClauseQualityToPlan(plan: Record<string, unknown>): ClauseDerivationResult {
  const existing = asRecord(plan.acceptance);
  if (existing === null) {
    return { applied: false, clauses: [], notice: "" };
  }
  const clauses = readAcceptanceClauses(existing);
  if (clauses.length === 0) {
    return { applied: false, clauses: [], notice: "" };
  }
  const prepared = prepareClauseStamp(clauses, collectTaskStatementFromPlan(plan));
  if (!prepared.ok) {
    const next = { ...existing };
    delete next.clauses;
    plan.acceptance = next;
    return {
      applied: false,
      clauses: prepared.clauses,
      notice: prepared.remediation ?? CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION,
    };
  }
  const next: Record<string, unknown> = {
    ...existing,
    clauses: serializeTracedClauses(prepared.clauses),
  };
  if (
    prepared.ambiguity_attestation !== undefined &&
    existing.ambiguity_attestation === undefined
  ) {
    next.ambiguity_attestation = prepared.ambiguity_attestation;
  }
  plan.acceptance = next;
  return {
    applied: true,
    clauses: prepared.clauses,
    notice: formatAmbiguousClauseNotice(prepared.clauses),
  };
}

/** Ingest path: strip an implementation-only stamp and record the remediation. */
export function applyClauseQualityForIngest(plan: Record<string, unknown>): ClauseDerivationResult {
  const quality = applyClauseQualityToPlan(plan);
  if (!quality.applied && quality.notice.length > 0) {
    const existing = asRecord(plan.acceptance);
    if (existing !== null) {
      plan.acceptance = {
        ...existing,
        derived_reason: quality.notice,
        quality_notice: quality.notice,
      };
    }
  }
  return quality;
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
  const previousAcceptance = plan.acceptance;
  plan.acceptance = {
    ...(existing ?? {}),
    commands: hasCommands ? commands : [],
    none_stated: noneStated,
    source_rung: sourceRung,
    derived_reason: `derived ${clauses.length} independently testable clauses from the task statement before product edit (#3323)`,
    clauses: serializeAcceptanceClauses(clauses),
  };
  const quality = applyClauseQualityToPlan(plan);
  if (!quality.applied) {
    const existing = asRecord(previousAcceptance);
    if (existing !== null && quality.notice.length > 0) {
      plan.acceptance = {
        ...existing,
        quality_notice: quality.notice,
        derived_reason: quality.notice,
      };
    } else {
      plan.acceptance = previousAcceptance;
    }
    return {
      applied: false,
      clauses: quality.clauses,
      notice: quality.notice,
    };
  }
  if (options.emitStamp !== false && options.projectRoot !== undefined) {
    emitAcceptanceStampFromPlan(options.projectRoot, plan);
  }
  return {
    applied: true,
    clauses: quality.clauses,
    notice: quality.notice,
  };
}

/** Stable fingerprint of plan.acceptance for first-write / material-change detection (#3355). */
export function acceptanceFingerprint(acceptance: unknown): string | null {
  const rec = asRecord(acceptance);
  if (rec === null) {
    return null;
  }
  const commands = Array.isArray(rec.commands) ? rec.commands.length : 0;
  const clauses = Array.isArray(rec.clauses)
    ? rec.clauses.map((entry, index) => {
        const row = asRecord(entry);
        if (row === null) {
          return `${index}`;
        }
        return `${row.id ?? index}:${row.text ?? ""}:${row.artifact_path ?? ""}`;
      })
    : [];
  const rung = typeof rec.source_rung === "string" ? rec.source_rung : "";
  return `${rung}|${rec.none_stated === true}|${commands}|${clauses.join(";")}`;
}

/** True when next is a first write or a material change versus previous (#3355). */
export function isMaterialAcceptanceChange(previous: unknown, next: unknown): boolean {
  const nextFp = acceptanceFingerprint(next);
  if (nextFp === null) {
    return false;
  }
  return acceptanceFingerprint(previous) !== nextFp;
}

/** Fail-open acceptance_stamp emission (same contract as issue:ingest / #3355). */
export function emitAcceptanceStampFromPlan(
  projectRoot: string,
  plan: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const rec = asRecord(plan);
  if (rec === null) {
    return;
  }
  const acceptance = asRecord(rec.acceptance);
  if (acceptance === null) {
    return;
  }
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
    const statement = collectTaskStatementFromPlan(rec);
    const rawRows = Array.isArray(acceptance.clauses) ? acceptance.clauses : [];
    const traced = readAcceptanceClauses(acceptance).map((clause, index) => {
      const row = asRecord(rawRows[index]);
      const stamped =
        row?.provenance === "statement" || row?.provenance === "implementation"
          ? row.provenance
          : undefined;
      return {
        ...clause,
        provenance:
          stamped ??
          (statement.trim().length > 0 ? traceClauseProvenance(clause, statement) : "statement"),
      };
    });
    const payload: AcceptanceStampRunSummaryPayload & {
      provenance_counts: ProvenanceCounts;
      ambiguity_attested: boolean;
    } = {
      rung: typeof acceptance.source_rung === "string" ? acceptance.source_rung : "project_floor",
      none_stated: acceptance.none_stated === true,
      command_count: commands,
      clause_count: clauses,
      provenance_counts: countClauseProvenance(traced),
      ambiguity_attested: evaluateAmbiguityAttestation(acceptance).attested,
    };
    emitter.emitAcceptanceStamp(payload);
  } catch {
    // fail-open
  }
}

/**
 * Emit acceptance_stamp when plan.acceptance is first written or materially changed.
 * State-observed: callers pass the before/after blocks from any lifecycle verb (#3355).
 */
export function maybeEmitAcceptanceStampFromChange(
  projectRoot: string,
  previous: unknown,
  next: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isMaterialAcceptanceChange(previous, next)) {
    return false;
  }
  emitAcceptanceStampFromPlan(projectRoot, { acceptance: next }, env);
  return true;
}
