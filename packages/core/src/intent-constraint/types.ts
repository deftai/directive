/**
 * Intent-constraint snapshot types (#4541).
 *
 * Closed file types: production .ts/.js, not tests.
 * Closed fact kinds: throw-site, reject-site, abort-site, numeric-const.
 */
export const INTENT_CONSTRAINT_PLAN_KEY = "x-directive/intentConstraint";
export const INTENT_CONSTRAINT_DIR = ".deft/intent-constraint";
export const INTENT_CONSTRAINT_RECORD_SCHEMA = "deft.intent-constraint.v1";
/** Prefer-A (#5574): operational → returned-failure; invariant → declared record landed before the product PR (#7031). */
export const INTENT_CONSTRAINT_REMEDIATION =
  'INTENT_CONSTRAINT_MISSING: Classify the condition, not the API name. Expected operational deny (missing grant / caller-may-retry / lock-busy) → returned-failure / filter without throw-reject-abort-numeric-const (free; no record). Invariant / corruption / impossible-if-healthy → fail-fast throw (or language-equivalent) + a declared intent-constraint record; rewrite solely to clear the gate is forbidden. Any remaining new hard fact among the four FACT_KINDS (including numeric-const on an otherwise operational path) also needs that record — a free rewrite introduces none of them. Write the declaration: put value / unit / rejectionScope on plan["x-directive/intentConstraint"] and run scope:record-intent-constraint from any shell (#7031: no terminal step; it writes kind declared). Land the record on the delivery-branch merge base before the product PR (a record PR, or the activation PR that adds its brief), then rebase the implementation branch onto it; same-PR working-tree-only records are not authoritative. A declaration is not consent: only under human merge does a person review it. Do not soften/remove an invariant failure solely to clear the gate. Tests and in-scope file paths are not authority.';

export const FACT_KINDS = ["throw-site", "reject-site", "abort-site", "numeric-const"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const REJECTION_SCOPES = ["item", "invocation", "operation"] as const;
export type RejectionScope = (typeof REJECTION_SCOPES)[number];

export interface ConstraintFact {
  readonly kind: FactKind;
  readonly id: string;
  readonly value?: string;
  /** 1-based source line, for naming the fact; not part of its identity (#6336). */
  readonly line?: number;
}

export interface SurfaceSnapshot {
  readonly path: string;
  readonly facts: readonly ConstraintFact[];
}

export interface MintConstraint {
  readonly value: string;
  readonly unit: string;
  readonly rejectionScope: RejectionScope;
}

export interface IntentConstraintHumanApproval {
  readonly kind: string;
  readonly actor: string;
  readonly mintedAt: string;
  readonly mintedVia?: string;
}

export interface IntentConstraintRecord {
  readonly schema: typeof INTENT_CONSTRAINT_RECORD_SCHEMA;
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly approvedAt: string;
  readonly constraints: readonly MintConstraint[];
  readonly humanApproval: IntentConstraintHumanApproval;
  readonly contractDigest: string;
}

export interface IntentConstraintFinding {
  readonly kind: "unapproved-fact" | "missing-mint" | "same-pr-rewrite";
  readonly path?: string;
  readonly detail: string;
}
