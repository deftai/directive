/**
 * Lightweight structured agent decision log schema (#1396).
 *
 * Intent-debt records for significant choices only. Not a full lifecycle xBRIEF
 * and not a replacement for docs/decisions/ADR-*.md.
 */

export const DECISION_SCHEMA_VERSION = "deft.decision.v1" as const;

/** Directory under project root for standalone (cross-cutting) decision files. */
export const DECISIONS_DIR_REL = "xbrief/decisions";

/** Filename suffix for decision records. */
export const DECISION_FILE_SUFFIX = ".decision.json";

export type DecisionConfidence = "low" | "medium" | "high";

/** Governing rule or constraint that informed the decision. */
export interface DecisionGoverningRule {
  /** Human-readable description of the rule/constraint. */
  readonly description: string;
  /** Path to the rule source (skill, docs, AGENTS.md section, issue). */
  readonly path?: string | null;
  /** RFC2119 tier when the rule is MUST/SHOULD/MAY style. */
  readonly rfc2119?: "MUST" | "SHOULD" | "MAY" | "MUST NOT" | "SHOULD NOT" | null;
}

/** One alternative considered and not chosen. */
export interface DecisionAlternative {
  readonly option: string;
  readonly whyNot?: string | null;
}

/**
 * Validated decision record (v1).
 *
 * Required fields per #1396 design lock: decision, governing rule/constraint,
 * alternatives considered, why winner, confidence, active scope ref(s) if any,
 * timestamp, revisit trigger.
 */
export interface DecisionRecord {
  readonly schemaVersion: typeof DECISION_SCHEMA_VERSION;
  /** Stable slug used in the filename (kebab-case). */
  readonly id: string;
  /** One-line or short paragraph of what was decided. */
  readonly decision: string;
  readonly governingRule: DecisionGoverningRule;
  readonly alternativesConsidered: readonly DecisionAlternative[];
  /** Why the chosen option won over the alternatives. */
  readonly whyWinner: string;
  readonly confidence: DecisionConfidence;
  /** Relative path(s) to related scope xBRIEF(s), if any. */
  readonly activeScopeRefs: readonly string[];
  /** ISO-8601 UTC timestamp (second precision preferred). */
  readonly timestamp: string;
  /** When/why a later agent should re-open this decision. */
  readonly revisitTrigger: string;
  /** Optional tags for list filtering. */
  readonly tags?: readonly string[];
  /** Optional related issue numbers (without #). */
  readonly relatedIssues?: readonly number[];
  /** Relative path of the written file (filled after write). */
  readonly path?: string;
}

export interface DecisionValidationError {
  readonly field: string;
  readonly message: string;
}

export interface DecisionValidationResult {
  readonly ok: boolean;
  readonly errors: readonly DecisionValidationError[];
  readonly record?: DecisionRecord;
}

const CONFIDENCE_VALUES: ReadonlySet<string> = new Set(["low", "medium", "high"]);
const RFC_VALUES: ReadonlySet<string> = new Set([
  "MUST",
  "SHOULD",
  "MAY",
  "MUST NOT",
  "SHOULD NOT",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Normalize timestamps to second-precision UTC with trailing Z. */
export function normalizeTimestamp(raw?: string | null): string {
  if (raw !== undefined && raw !== null && raw.trim().length > 0) {
    const parsed = new Date(raw.trim());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Derive a kebab-case slug from free text (max 64 chars). */
export function slugifyDecision(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : "decision";
}

/** Date prefix YYYY-MM-DD from an ISO timestamp. */
export function datePrefixFromTimestamp(timestamp: string): string {
  const m = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? new Date().toISOString().slice(0, 10);
}

/** Build standalone filename: YYYY-MM-DD-<slug>.decision.json */
export function decisionFilename(id: string, timestamp: string): string {
  const date = datePrefixFromTimestamp(timestamp);
  const slug = slugifyDecision(id);
  return `${date}-${slug}${DECISION_FILE_SUFFIX}`;
}

/** Validate and normalize an unknown JSON value into a DecisionRecord. */
export function validateDecisionRecord(input: unknown): DecisionValidationResult {
  const errors: DecisionValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ field: "", message: "decision record must be a JSON object" }] };
  }

  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== DECISION_SCHEMA_VERSION) {
    errors.push({
      field: "schemaVersion",
      message: `expected ${DECISION_SCHEMA_VERSION}, got ${String(schemaVersion)}`,
    });
  }

  const decision = input.decision;
  if (!nonEmptyString(decision)) {
    errors.push({ field: "decision", message: "required non-empty string" });
  }

  let governingRule: DecisionGoverningRule | null = null;
  if (!isPlainObject(input.governingRule) && !nonEmptyString(input.governingRule)) {
    errors.push({
      field: "governingRule",
      message: "required object { description, path?, rfc2119? } or non-empty string",
    });
  } else if (nonEmptyString(input.governingRule)) {
    governingRule = { description: input.governingRule.trim() };
  } else if (isPlainObject(input.governingRule)) {
    const gr = input.governingRule;
    if (!nonEmptyString(gr.description)) {
      errors.push({ field: "governingRule.description", message: "required non-empty string" });
    } else {
      let rfc2119: DecisionGoverningRule["rfc2119"] = null;
      if (gr.rfc2119 !== undefined && gr.rfc2119 !== null) {
        if (typeof gr.rfc2119 === "string" && RFC_VALUES.has(gr.rfc2119)) {
          rfc2119 = gr.rfc2119 as DecisionGoverningRule["rfc2119"];
        } else {
          errors.push({
            field: "governingRule.rfc2119",
            message: `must be one of ${[...RFC_VALUES].join(", ")}`,
          });
        }
      }
      governingRule = {
        description: gr.description.trim(),
        path: typeof gr.path === "string" && gr.path.trim().length > 0 ? gr.path.trim() : null,
        rfc2119,
      };
    }
  }

  const alternativesRaw = input.alternativesConsidered ?? input.alternatives;
  const alternatives: DecisionAlternative[] = [];
  if (!Array.isArray(alternativesRaw)) {
    errors.push({
      field: "alternativesConsidered",
      message: "required array of { option, whyNot? } or strings",
    });
  } else if (alternativesRaw.length === 0) {
    errors.push({
      field: "alternativesConsidered",
      message: 'must include at least one alternative (use [{option:"none"}] if truly sole path)',
    });
  } else {
    for (let i = 0; i < alternativesRaw.length; i += 1) {
      const alt = alternativesRaw[i];
      if (nonEmptyString(alt)) {
        alternatives.push({ option: alt.trim() });
      } else if (isPlainObject(alt) && nonEmptyString(alt.option)) {
        alternatives.push({
          option: alt.option.trim(),
          whyNot:
            typeof alt.whyNot === "string" && alt.whyNot.trim().length > 0
              ? alt.whyNot.trim()
              : null,
        });
      } else {
        errors.push({
          field: `alternativesConsidered[${i}]`,
          message: "must be a non-empty string or { option, whyNot? }",
        });
      }
    }
  }

  const whyWinner = input.whyWinner ?? input.why_winner;
  if (!nonEmptyString(whyWinner)) {
    errors.push({ field: "whyWinner", message: "required non-empty string" });
  }

  const confidenceRaw = input.confidence;
  let confidence: DecisionConfidence | null = null;
  if (
    !nonEmptyString(confidenceRaw) ||
    !CONFIDENCE_VALUES.has(confidenceRaw.trim().toLowerCase())
  ) {
    errors.push({ field: "confidence", message: "required: low | medium | high" });
  } else {
    confidence = confidenceRaw.trim().toLowerCase() as DecisionConfidence;
  }

  const scopeRaw = input.activeScopeRefs ?? input.active_scope_refs ?? input.scopeRefs;
  const activeScopeRefs: string[] = [];
  if (scopeRaw === undefined || scopeRaw === null) {
    // optional
  } else if (Array.isArray(scopeRaw)) {
    for (let i = 0; i < scopeRaw.length; i += 1) {
      const s = scopeRaw[i];
      if (nonEmptyString(s)) {
        activeScopeRefs.push(s.trim().replace(/\\/g, "/"));
      } else {
        errors.push({ field: `activeScopeRefs[${i}]`, message: "must be a non-empty path string" });
      }
    }
  } else if (nonEmptyString(scopeRaw)) {
    activeScopeRefs.push(scopeRaw.trim().replace(/\\/g, "/"));
  } else {
    errors.push({
      field: "activeScopeRefs",
      message: "must be a string path, array of paths, or omitted",
    });
  }

  const revisitTrigger = input.revisitTrigger ?? input.revisit_trigger;
  if (!nonEmptyString(revisitTrigger)) {
    errors.push({ field: "revisitTrigger", message: "required non-empty string" });
  }

  let timestamp = normalizeTimestamp(typeof input.timestamp === "string" ? input.timestamp : null);
  if (typeof input.timestamp === "string" && input.timestamp.trim().length > 0) {
    const parsed = new Date(input.timestamp.trim());
    if (Number.isNaN(parsed.getTime())) {
      errors.push({ field: "timestamp", message: "invalid ISO-8601 timestamp" });
    } else {
      timestamp = normalizeTimestamp(input.timestamp);
    }
  }

  const id =
    typeof input.id === "string" && input.id.trim().length > 0
      ? slugifyDecision(input.id)
      : slugifyDecision(typeof decision === "string" ? decision : "decision");

  const tags: string[] = [];
  if (Array.isArray(input.tags)) {
    for (const t of input.tags) {
      if (nonEmptyString(t)) tags.push(t.trim());
    }
  }

  const relatedIssues: number[] = [];
  if (Array.isArray(input.relatedIssues)) {
    for (const n of input.relatedIssues) {
      if (typeof n === "number" && Number.isInteger(n) && n > 0) relatedIssues.push(n);
      else if (typeof n === "string" && /^\d+$/.test(n.trim()))
        relatedIssues.push(Number(n.trim()));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const record: DecisionRecord = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    id,
    decision: (decision as string).trim(),
    governingRule: governingRule as DecisionGoverningRule,
    alternativesConsidered: alternatives,
    whyWinner: (whyWinner as string).trim(),
    confidence: confidence as DecisionConfidence,
    activeScopeRefs,
    timestamp,
    revisitTrigger: (revisitTrigger as string).trim(),
    ...(tags.length > 0 ? { tags } : {}),
    ...(relatedIssues.length > 0 ? { relatedIssues } : {}),
  };

  return { ok: true, errors: [], record };
}

/** Format validation errors for CLI stderr. */
export function formatDecisionValidationErrors(errors: readonly DecisionValidationError[]): string {
  return errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("\n");
}
