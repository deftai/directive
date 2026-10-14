/**
 * Intent-constraint snapshot types (#4541).
 *
 * Closed file types: production .ts/.js, not tests.
 * Closed fact kinds: throw-site, reject-site, abort-site, numeric-const.
 */
export const INTENT_CONSTRAINT_PLAN_KEY = "x-directive/intentConstraint";
export const INTENT_CONSTRAINT_DIR = ".deft/intent-constraint";
export const INTENT_CONSTRAINT_RECORD_SCHEMA = "deft.intent-constraint.v1";
/** Prefer-A (#5574 / #5010): operational → returned-failure; invariant → ask+mint / park. TTY mint is legacy repair only. */
export const INTENT_CONSTRAINT_REMEDIATION =
  "INTENT_CONSTRAINT_MISSING: Classify the condition, not the API name. Expected operational deny (missing grant / caller-may-retry / lock-busy) → returned-failure / filter without throw-reject-abort-numeric-const (free; no mint). Invariant / corruption / impossible-if-healthy → fail-fast throw (or language-equivalent) + attended human mint; rewrite solely to clear the gate is forbidden. Attended invariant: ask the human in the parent chat; on yes the human lands `.deft/intent-constraint/<plan-id>.json` with humanApproval (mintedVia in-harness-ask) on a real TTY — agent/CI shells still refuse (attestation is not an agent-shell bypass). Commit that record on the delivery-branch merge base first, then rebase the implementation branch onto it; same-PR working-tree-only records are not authoritative. Unattended/C1/operator-gone: operational may rewrite or park; invariant requiring a new hard fact must park pending a human mint — do not soften/remove that failure solely to clear the gate; do not ask an empty room; leave-harness TTY scope:record-intent-constraint is not the primary path (legacy repair only). Tests and in-scope file paths are not authority.";

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
