/**
 * Per-acceptance-criterion evidence / disposition for scope:complete (#3240 / epic #3237 Q3).
 *
 * Merge ancestry alone must not auto-complete acceptance items. Each non-terminal
 * plan item needs either typed evidence or a human-origin disposition before complete
 * may advance it. Kind suitability: merge/review alone cannot satisfy smoke, UAT,
 * deploy, or observed_behavior requirements.
 *
 * Canonical item keys are namespaced under #1620 / #3305 (Option B):
 * - plan.items[].x-directive/evidence
 * - plan.items[].x-directive/disposition
 * Bare `evidence` / `disposition` are not valid typed evidence (no dual-read).
 * ITEM_CORE is not expanded with bare keys; verify:vbrief-conformance rejects them.
 */

import { isHumanOrigin } from "../authz/origin.js";
import type { GrantOrigin } from "../authz/types.js";
import {
  type AcceptancePredicate,
  formatAcceptanceVerdict,
  resolveAcceptanceGateProfile,
  resolveAcceptanceVerdict,
} from "../product-first-done-gate/acceptance-resolver.js";
import {
  type EvaluateVerifyAcOptions,
  evaluateVerifyAcFromPlan,
} from "../product-first-done-gate/evaluate.js";

/** Canonical namespaced key for typed acceptance evidence (#3305 / #1620). */
export const ACCEPTANCE_EVIDENCE_KEY = "x-directive/evidence" as const;

/** Canonical namespaced key for human-origin disposition (#3305 / #1620). */
export const ACCEPTANCE_DISPOSITION_KEY = "x-directive/disposition" as const;

/** Closed evidence kinds (locked Q3). */
export const ACCEPTANCE_EVIDENCE_KINDS = [
  "test",
  "review",
  "merge",
  "deploy",
  "smoke",
  "uat",
  "observed_behavior",
] as const;

export type AcceptanceEvidenceKind = (typeof ACCEPTANCE_EVIDENCE_KINDS)[number];

/** Closed dispositions (locked Q3). */
export const ACCEPTANCE_DISPOSITIONS = ["waived", "deferred", "not_applicable"] as const;

export type AcceptanceDispositionKind = (typeof ACCEPTANCE_DISPOSITIONS)[number];

/**
 * Axes that merge/review evidence alone cannot satisfy.
 * Matches epic #3237 Q3 suitability rule.
 */
export const STRICT_ACCEPTANCE_AXES = ["deploy", "smoke", "uat", "observed_behavior"] as const;

export type StrictAcceptanceAxis = (typeof STRICT_ACCEPTANCE_AXES)[number];

const EVIDENCE_KIND_SET = new Set<string>(ACCEPTANCE_EVIDENCE_KINDS);
const DISPOSITION_SET = new Set<string>(ACCEPTANCE_DISPOSITIONS);
const STRICT_AXIS_SET = new Set<string>(STRICT_ACCEPTANCE_AXES);

/** Item statuses that still represent unfinished acceptance work (#2862 / #3240). */
const NON_TERMINAL_ITEM_STATUSES = new Set(["pending", "proposed", "running"]);

export interface AcceptanceEvidenceRecord {
  readonly kind: AcceptanceEvidenceKind;
  readonly pointer: string;
  readonly recorded_at: string;
  readonly recorded_by: string;
}

export interface AcceptanceDispositionRecord {
  readonly disposition: AcceptanceDispositionKind;
  readonly reason: string;
  /** Human-origin provenance (kind + actor required; other GrantOrigin fields optional). */
  readonly provenance: Pick<GrantOrigin, "kind" | "actor"> & Partial<GrantOrigin>;
  readonly recorded_at: string;
  readonly resume_when?: string;
}

export interface CriterionAcceptanceReport {
  readonly path: string;
  readonly title: string;
  readonly outcome: "evidence" | "disposition" | "already_terminal" | "missing" | "invalid";
  readonly detail: string;
  readonly evidence?: AcceptanceEvidenceRecord;
  readonly disposition?: AcceptanceDispositionRecord;
}

export interface AcceptanceEvidenceGateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly reports: readonly CriterionAcceptanceReport[];
  /** How the #3357 walk obtained AC (#3387). */
  readonly servedFrom?: "bank" | "cache" | "executed" | "refused";
  /** Which acceptance check decided the walk (#3497). Undefined when no walk ran. */
  readonly predicate?: AcceptancePredicate;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isAcceptanceEvidenceKind(value: unknown): value is AcceptanceEvidenceKind {
  return typeof value === "string" && EVIDENCE_KIND_SET.has(value.trim().toLowerCase());
}

export function isAcceptanceDispositionKind(value: unknown): value is AcceptanceDispositionKind {
  return typeof value === "string" && DISPOSITION_SET.has(value.trim().toLowerCase());
}

/**
 * Infer strict axes a criterion requires from explicit fields and title/Acceptance text.
 * Explicit `requires` / `requiredEvidenceKind` / `acceptanceAxis` wins when valid.
 */
export function inferRequiredStrictAxes(item: Record<string, unknown>): StrictAcceptanceAxis[] {
  const explicit = [
    item.requires,
    item.requiredEvidenceKind,
    item.required_evidence_kind,
    item.acceptanceAxis,
    item.acceptance_axis,
  ];
  for (const raw of explicit) {
    if (typeof raw !== "string") continue;
    const norm = raw.trim().toLowerCase().replace(/-/g, "_");
    if (STRICT_AXIS_SET.has(norm)) {
      return [norm as StrictAcceptanceAxis];
    }
  }

  const narrative = asRecord(item.narrative);
  const parts: string[] = [];
  if (typeof item.title === "string") parts.push(item.title);
  if (typeof item.id === "string") parts.push(item.id);
  if (narrative !== null) {
    for (const key of ["Acceptance", "acceptance", "Description", "description", "Test", "test"]) {
      if (typeof narrative[key] === "string") parts.push(narrative[key] as string);
    }
  }
  const text = parts.join("\n").toLowerCase();
  const found: StrictAcceptanceAxis[] = [];
  // Order: longer / more specific phrases first so "observed behavior" wins over generic.
  if (
    /\bobserved[_\s-]?behavior\b/.test(text) ||
    /\bobserved behaviour\b/.test(text) ||
    /\brunning behaviour\b/.test(text) ||
    /\brunning behavior\b/.test(text)
  ) {
    found.push("observed_behavior");
  }
  if (/\buat\b/.test(text) || /\buser acceptance\b/.test(text)) {
    found.push("uat");
  }
  if (/\bsmoke\b/.test(text)) {
    found.push("smoke");
  }
  if (/\bdeploy(?:ment|ed|s)?\b/.test(text)) {
    found.push("deploy");
  }
  return found;
}

/**
 * Whether evidence.kind is suitable for the criterion's required strict axes.
 * merge and review never satisfy smoke/UAT/deploy/observed_behavior.
 *
 * A single evidence.kind covers only that axis. When free-text inference yields
 * multiple axes (e.g. "smoke after deploy"), every required axis must match the
 * same kind — which is only possible when the axes are identical. Otherwise use
 * explicit `requires` / `acceptanceAxis` for a single axis, split the criterion,
 * or record a human-origin disposition (#3240 Greptile P1).
 */
export function isEvidenceKindSuitable(
  kind: AcceptanceEvidenceKind,
  requiredAxes: readonly StrictAcceptanceAxis[],
): boolean {
  if (requiredAxes.length === 0) {
    return true;
  }
  if (kind === "merge" || kind === "review") {
    return false;
  }
  // All required strict axes must be covered by this single evidence kind.
  return requiredAxes.every((axis) => kind === axis);
}

function parseEvidence(raw: unknown):
  | {
      ok: true;
      record: AcceptanceEvidenceRecord;
    }
  | {
      ok: false;
      message: string;
    } {
  const obj = asRecord(raw);
  if (obj === null) {
    return { ok: false, message: "evidence must be an object" };
  }
  const allowedEvidenceKeys = new Set(["kind", "pointer", "recorded_at", "recorded_by"]);
  const extra = Object.keys(obj)
    .filter((k) => !allowedEvidenceKeys.has(k))
    .sort((a, b) => a.localeCompare(b));
  if (extra.length > 0) {
    return {
      ok: false,
      message:
        "evidence has extra properties " +
        extra.join(", ") +
        "; allowed: kind|pointer|recorded_at|recorded_by",
    };
  }
  const kindRaw = typeof obj.kind === "string" ? obj.kind.trim().toLowerCase() : "";
  if (!isAcceptanceEvidenceKind(kindRaw)) {
    return {
      ok: false,
      message:
        `unknown or missing evidence.kind ${JSON.stringify(obj.kind)}; ` +
        `allowed: ${ACCEPTANCE_EVIDENCE_KINDS.join("|")}`,
    };
  }
  if (!isNonEmptyString(obj.pointer)) {
    return { ok: false, message: "evidence.pointer is required (non-empty string)" };
  }
  if (!isNonEmptyString(obj.recorded_at)) {
    return { ok: false, message: "evidence.recorded_at is required" };
  }
  if (!isNonEmptyString(obj.recorded_by)) {
    return { ok: false, message: "evidence.recorded_by is required" };
  }
  return {
    ok: true,
    record: {
      kind: kindRaw as AcceptanceEvidenceKind,
      pointer: obj.pointer.trim(),
      recorded_at: obj.recorded_at.trim(),
      recorded_by: obj.recorded_by.trim(),
    },
  };
}

function parseDisposition(raw: unknown):
  | {
      ok: true;
      record: AcceptanceDispositionRecord;
    }
  | {
      ok: false;
      message: string;
    } {
  const obj = asRecord(raw);
  if (obj === null) {
    return { ok: false, message: "disposition must be an object" };
  }
  const dispRaw = typeof obj.disposition === "string" ? obj.disposition.trim().toLowerCase() : "";
  if (!isAcceptanceDispositionKind(dispRaw)) {
    return {
      ok: false,
      message:
        `unknown or missing disposition.disposition ${JSON.stringify(obj.disposition)}; ` +
        `allowed: ${ACCEPTANCE_DISPOSITIONS.join("|")}`,
    };
  }
  if (!isNonEmptyString(obj.reason)) {
    return { ok: false, message: "disposition.reason is required" };
  }
  if (!isNonEmptyString(obj.recorded_at)) {
    return { ok: false, message: "disposition.recorded_at is required" };
  }
  const provenance = asRecord(obj.provenance);
  if (provenance === null) {
    return { ok: false, message: "disposition.provenance is required (human-origin)" };
  }
  // Reuse authz human-origin gate (#2944) so agent-self stamps cannot waive criteria.
  const originForCheck: GrantOrigin = {
    kind: String(provenance.kind ?? ""),
    actor: String(provenance.actor ?? ""),
    mintedAt: typeof provenance.mintedAt === "string" ? provenance.mintedAt : "",
    mintedVia: typeof provenance.mintedVia === "string" ? provenance.mintedVia : "",
    eventRef: typeof provenance.eventRef === "string" ? provenance.eventRef : null,
  };
  if (!isHumanOrigin(originForCheck)) {
    return {
      ok: false,
      message:
        "disposition.provenance must be human-origin " +
        "(kind operator-cli|operator-session|human-event + non-agent actor)",
    };
  }
  const record: AcceptanceDispositionRecord = {
    disposition: dispRaw as AcceptanceDispositionKind,
    reason: obj.reason.trim(),
    provenance: {
      kind: originForCheck.kind,
      actor: originForCheck.actor,
      ...(originForCheck.mintedAt.length > 0 ? { mintedAt: originForCheck.mintedAt } : {}),
      ...(originForCheck.mintedVia.length > 0 ? { mintedVia: originForCheck.mintedVia } : {}),
      ...(originForCheck.eventRef !== null ? { eventRef: originForCheck.eventRef } : {}),
    },
    recorded_at: obj.recorded_at.trim(),
  };
  if (isNonEmptyString(obj.resume_when)) {
    return {
      ok: true,
      record: { ...record, resume_when: obj.resume_when.trim() },
    };
  }
  return { ok: true, record };
}

function itemLabel(item: Record<string, unknown>, path: string): string {
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (typeof item.id === "string" && item.id.trim().length > 0) {
    return item.id.trim();
  }
  return path;
}

/**
 * Read only namespaced acceptance fields (#3305). Bare `evidence` / `disposition`
 * are never treated as success (no permanent dual-read).
 */
export function readNamespacedAcceptanceFields(item: Record<string, unknown>): {
  readonly evidence: unknown;
  readonly disposition: unknown;
  readonly hasEvidence: boolean;
  readonly hasDisposition: boolean;
  readonly hasBareEvidence: boolean;
  readonly hasBareDisposition: boolean;
} {
  const evidence = item[ACCEPTANCE_EVIDENCE_KEY];
  const disposition = item[ACCEPTANCE_DISPOSITION_KEY];
  return {
    evidence,
    disposition,
    hasEvidence: evidence !== undefined && evidence !== null,
    hasDisposition: disposition !== undefined && disposition !== null,
    hasBareEvidence: item.evidence !== undefined && item.evidence !== null,
    hasBareDisposition: item.disposition !== undefined && item.disposition !== null,
  };
}

/** Clear bare and namespaced acceptance fields so stamps never leave dual/conflicting keys. */
function clearAcceptanceStampFields(item: Record<string, unknown>): void {
  delete item.evidence;
  delete item.disposition;
  delete item[ACCEPTANCE_EVIDENCE_KEY];
  delete item[ACCEPTANCE_DISPOSITION_KEY];
}

/**
 * Stamp typed evidence under the canonical namespaced key only.
 * Clears bare evidence/disposition and any prior namespaced disposition so the item
 * cannot carry both acceptance fields after a replace (#3305 Greptile P2).
 */
export function stampNamespacedEvidence(
  item: Record<string, unknown>,
  record: AcceptanceEvidenceRecord,
): void {
  clearAcceptanceStampFields(item);
  item[ACCEPTANCE_EVIDENCE_KEY] = {
    kind: record.kind,
    pointer: record.pointer,
    recorded_at: record.recorded_at,
    recorded_by: record.recorded_by,
  };
}

/**
 * Stamp human-origin disposition under the canonical namespaced key only.
 * Clears bare evidence/disposition and any prior namespaced evidence so the item
 * cannot carry both acceptance fields after a replace (#3305 Greptile P2).
 */
export function stampNamespacedDisposition(
  item: Record<string, unknown>,
  record: AcceptanceDispositionRecord,
): void {
  clearAcceptanceStampFields(item);
  const body: Record<string, unknown> = {
    disposition: record.disposition,
    reason: record.reason,
    provenance: { ...record.provenance },
    recorded_at: record.recorded_at,
  };
  if (record.resume_when !== undefined) {
    body.resume_when = record.resume_when;
  }
  item[ACCEPTANCE_DISPOSITION_KEY] = body;
}

function evaluateOneItem(item: Record<string, unknown>, path: string): CriterionAcceptanceReport {
  const title = itemLabel(item, path);
  const status = String(item.status ?? "");
  if (!NON_TERMINAL_ITEM_STATUSES.has(status)) {
    // Already-terminal: complete does not re-validate typed evidence (#3240 / #3305).
    // Suitability/provenance apply only when advancing non-terminal items. Pre-marking
    // items completed with narrative-only fields still skips the typed gate — that is
    // intentional for fail/cancel and historical terminals, not a silent dual success path.
    return {
      path,
      title,
      outcome: "already_terminal",
      detail: `status=${status || "(empty)"} (not advanced; typed evidence not re-checked)`,
    };
  }

  const fields = readNamespacedAcceptanceFields(item);
  const { hasEvidence, hasDisposition, hasBareEvidence, hasBareDisposition } = fields;

  if (hasEvidence && hasDisposition) {
    return {
      path,
      title,
      outcome: "invalid",
      detail: `exactly one of ${ACCEPTANCE_EVIDENCE_KEY} or ${ACCEPTANCE_DISPOSITION_KEY} required; both present`,
    };
  }

  if (!hasEvidence && !hasDisposition) {
    const bareHint =
      hasBareEvidence || hasBareDisposition
        ? ` bare evidence/disposition ignored — use ${ACCEPTANCE_EVIDENCE_KEY} or ${ACCEPTANCE_DISPOSITION_KEY} (#3305);`
        : "";
    return {
      path,
      title,
      outcome: "missing",
      detail:
        `no ${ACCEPTANCE_EVIDENCE_KEY} or ${ACCEPTANCE_DISPOSITION_KEY};` +
        `${bareHint} scope:complete refuses to auto-complete (#3240)`,
    };
  }

  if (hasDisposition) {
    const parsed = parseDisposition(fields.disposition);
    if (!parsed.ok) {
      return { path, title, outcome: "invalid", detail: parsed.message };
    }
    return {
      path,
      title,
      outcome: "disposition",
      detail: `${parsed.record.disposition}: ${parsed.record.reason}`,
      disposition: parsed.record,
    };
  }

  const parsed = parseEvidence(fields.evidence);
  if (!parsed.ok) {
    return { path, title, outcome: "invalid", detail: parsed.message };
  }
  const requiredAxes = inferRequiredStrictAxes(item);
  if (!isEvidenceKindSuitable(parsed.record.kind, requiredAxes)) {
    const axes = requiredAxes.length > 0 ? requiredAxes.join("|") : "(none)";
    return {
      path,
      title,
      outcome: "invalid",
      detail:
        `evidence.kind=${parsed.record.kind} is not suitable for required axis/axes [${axes}]; ` +
        `merge/review alone cannot satisfy smoke|uat|deploy|observed_behavior (#3240)`,
      evidence: parsed.record,
    };
  }
  return {
    path,
    title,
    outcome: "evidence",
    detail: `${parsed.record.kind} @ ${parsed.record.pointer}`,
    evidence: parsed.record,
  };
}

function walkItems(items: unknown, pathPrefix: string, reports: CriterionAcceptanceReport[]): void {
  if (!Array.isArray(items)) {
    return;
  }
  items.forEach((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const obj = item as Record<string, unknown>;
    const path = `${pathPrefix}[${index}]`;
    reports.push(evaluateOneItem(obj, path));
    walkItems(obj.subItems, `${path}.subItems`, reports);
    walkItems(obj.items, `${path}.items`, reports);
  });
}

/**
 * Standing contract for scope:complete's acceptance precondition (#3357 / #3497).
 *
 * It no longer asserts a predicate ("empty or failing") — the actual predicate is
 * named per refusal by the shared resolver. It also no longer tells operators to
 * stamp by running verify:ac: verify:ac is the verifier and never writes the brief
 * (a verifier that authors the acceptance it then checks is not a gate). Stamping
 * happens at intake / promote via clause derivation (#3323).
 */
export const SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION =
  "scope:complete requires executable plan.acceptance that runs green; stamp commands on " +
  "plan.acceptance.commands (or plan.metadata.swarm.verify_commands) — task verify:ac verifies, " +
  "it does not stamp — then re-run task verify:ac -- <completing-xbrief> " +
  "(disposition is not a substitute) (#3357/#3497)";

/**
 * Hard precondition for scope:complete (#3357 / #3267 / #3284).
 *
 * Runs the same verify:ac walk check uses, through the one shared option profile and
 * the one shared verdict resolver (#3497) — so scope:complete can no longer report a
 * different story than verify:ac about the same artifact. Disposition on plan items
 * does not skip it. Briefs with no stamped plan.acceptance and no executable commands
 * keep the legacy #3267 "nothing to run" pass so existing evidence-only fixtures stay
 * valid.
 */
export function evaluateScopeCompleteAcceptanceWalk(
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions = {},
): AcceptanceEvidenceGateResult {
  const stamped = plan.acceptance !== undefined;
  const profile = resolveAcceptanceGateProfile("complete");
  const walk = evaluateVerifyAcFromPlan(plan, {
    ...options,
    checkIntegrated: profile.checkIntegrated,
    captureFromNarratives: options.captureFromNarratives ?? profile.captureFromNarratives,
    reuseMode: options.reuseMode ?? profile.reuseMode,
  });
  const rejectedCount = walk.rejected?.length ?? 0;
  const hadWork = walk.runs.length > 0 || walk.commands.length > 0 || rejectedCount > 0;
  const servedFrom = walk.servedFrom ?? "executed";
  if (!stamped && !hadWork) {
    return {
      ok: true,
      message: "Acceptance walk not required (no stamped plan.acceptance) (#3357)",
      reports: [],
      servedFrom: "executed",
    };
  }
  const verdict = resolveAcceptanceVerdict(walk);
  if (walk.ok) {
    return {
      ok: true,
      message: walk.message,
      reports: [],
      servedFrom,
      predicate: verdict.predicate,
    };
  }
  return {
    ok: false,
    // Name the check that refused and the value it read BEFORE the standing
    // contract, so the first line the operator sees is the actual cause (#3497).
    message:
      `scope:complete refused acceptance — ${formatAcceptanceVerdict(verdict)}\n` +
      `${SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION}\n${walk.message}`,
    reports: [],
    servedFrom,
    predicate: verdict.predicate,
  };
}

/**
 * Fail closed when any non-terminal plan item lacks suitable evidence or a human-origin disposition.
 */
export function evaluateAcceptanceEvidenceGate(
  plan: Record<string, unknown>,
): AcceptanceEvidenceGateResult {
  const reports: CriterionAcceptanceReport[] = [];
  walkItems(plan.items, "items", reports);

  const blockers = reports.filter((r) => r.outcome === "missing" || r.outcome === "invalid");

  if (blockers.length === 0) {
    const lines = reports
      .filter((r) => r.outcome === "evidence" || r.outcome === "disposition")
      .map((r) => `  - ${r.path} "${r.title}": ${r.outcome} (${r.detail})`);
    const summary =
      lines.length > 0
        ? `Acceptance evidence gate passed (#3240):\n${lines.join("\n")}`
        : "Acceptance evidence gate passed (#3240): no non-terminal criteria";
    return { ok: true, message: summary, reports };
  }

  const lines = blockers.map((r) => `  - ${r.path} "${r.title}": ${r.detail}`);
  return {
    ok: false,
    message:
      `Acceptance evidence required for scope:complete (#3240 / #3305). ` +
      `${blockers.length} criterion/criteria missing suitable evidence or disposition:\n` +
      `${lines.join("\n")}\n` +
      `Each non-terminal plan item needs ${ACCEPTANCE_EVIDENCE_KEY} ` +
      `{kind: test|review|merge|deploy|smoke|uat|observed_behavior, pointer, recorded_at, recorded_by} ` +
      `or ${ACCEPTANCE_DISPOSITION_KEY} {disposition: waived|deferred|not_applicable, reason, provenance (human-origin), recorded_at}. ` +
      `Bare evidence/disposition keys are not valid (#1620 / #3305). ` +
      `merge/review alone cannot satisfy smoke|uat|deploy|observed_behavior criteria.`,
    reports,
  };
}

/**
 * Format a short multi-line listing of evidence/disposition for every criterion
 * (including already-terminal) for complete success output.
 */
export function formatAcceptanceCompletionListing(
  reports: readonly CriterionAcceptanceReport[],
): string {
  if (reports.length === 0) {
    return "Acceptance criteria: (none)";
  }
  const lines = reports.map((r) => {
    if (r.outcome === "evidence" && r.evidence) {
      return `  - ${r.path} "${r.title}": evidence kind=${r.evidence.kind} pointer=${r.evidence.pointer}`;
    }
    if (r.outcome === "disposition" && r.disposition) {
      return (
        `  - ${r.path} "${r.title}": disposition=${r.disposition.disposition} ` +
        `reason=${r.disposition.reason}`
      );
    }
    return `  - ${r.path} "${r.title}": ${r.outcome} (${r.detail})`;
  });
  return `Acceptance criteria:\n${lines.join("\n")}`;
}
