/**
 * Per-acceptance-criterion evidence / disposition for scope:complete (#3240 / epic #3237 Q3).
 *
 * Merge ancestry alone must not auto-complete acceptance items. Each non-terminal
 * plan item needs either typed evidence or a human-origin disposition before complete
 * may advance it. Kind suitability: merge/review alone cannot satisfy smoke, UAT,
 * deploy, or observed_behavior requirements.
 */

import { isHumanOrigin } from "../authz/origin.js";
import type { GrantOrigin } from "../authz/types.js";

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

function evaluateOneItem(item: Record<string, unknown>, path: string): CriterionAcceptanceReport {
  const title = itemLabel(item, path);
  const status = String(item.status ?? "");
  if (!NON_TERMINAL_ITEM_STATUSES.has(status)) {
    return {
      path,
      title,
      outcome: "already_terminal",
      detail: `status=${status || "(empty)"} (not advanced)`,
    };
  }

  const hasEvidence = item.evidence !== undefined && item.evidence !== null;
  const hasDisposition = item.disposition !== undefined && item.disposition !== null;

  if (hasEvidence && hasDisposition) {
    return {
      path,
      title,
      outcome: "invalid",
      detail: "exactly one of evidence or disposition required; both present",
    };
  }

  if (!hasEvidence && !hasDisposition) {
    return {
      path,
      title,
      outcome: "missing",
      detail: "no evidence or disposition; scope:complete refuses to auto-complete (#3240)",
    };
  }

  if (hasDisposition) {
    const parsed = parseDisposition(item.disposition);
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

  const parsed = parseEvidence(item.evidence);
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
      `Acceptance evidence required for scope:complete (#3240). ` +
      `${blockers.length} criterion/criteria missing suitable evidence or disposition:\n` +
      `${lines.join("\n")}\n` +
      `Each non-terminal plan item needs evidence ` +
      `{kind: test|review|merge|deploy|smoke|uat|observed_behavior, pointer, recorded_at, recorded_by} ` +
      `or disposition {disposition: waived|deferred|not_applicable, reason, provenance (human-origin), recorded_at}. ` +
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
