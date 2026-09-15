/**
 * Intent-constraint snapshot types (#4541).
 *
 * Closed file types: production .ts/.js, not tests.
 * Closed fact kinds: throw-site, reject-site, abort-site, numeric-const.
 */
export const INTENT_CONSTRAINT_PLAN_KEY = "x-directive/intentConstraint";
export const INTENT_CONSTRAINT_DIR = ".deft/intent-constraint";
export const INTENT_CONSTRAINT_RECORD_SCHEMA = "deft.intent-constraint.v1";
export const INTENT_CONSTRAINT_REMEDIATION =
  "INTENT_CONSTRAINT_MISSING: Link the hard constraint and rejection scope to a base-approved requirement or decision, or remove the behavior. Tests and in-scope file paths are not authority.";

export const FACT_KINDS = ["throw-site", "reject-site", "abort-site", "numeric-const"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const REJECTION_SCOPES = ["item", "invocation", "operation"] as const;
export type RejectionScope = (typeof REJECTION_SCOPES)[number];

export interface ConstraintFact {
  readonly kind: FactKind;
  readonly id: string;
  readonly value?: string;
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
