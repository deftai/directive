/**
 * Human-origin approval grants + UAT mutation lease (#2944 Wave 1 / #2948 L1–L2).
 *
 * Threat model (aligned agent, not malice): lifecycle/xBRIEF/dispatch tokens the
 * agent authors must not independently satisfy implementation-approval gates.
 * Local-file forgery by a credential-compromised agent remains #983-class OOS.
 */

/** Operation classes bound on a grant (Wave 1 structural binding + Wave 4 closed verbs). */
export const AUTHZ_OPERATIONS = [
  "edit",
  "push",
  "pr",
  "merge",
  "settings",
  "deployment",
  "issue_mutation",
  /** Release-class closed verbs (#1095 Wave 4) — also satisfied by `deployment`. */
  "release-cut",
  "release-publish",
  "release-rollback",
] as const;

export type AuthzOperation = (typeof AUTHZ_OPERATIONS)[number];

/**
 * Human-origin kinds accepted as approval provenance.
 * Agent-minted / self-asserted kinds are rejected by the gate.
 */
export const HUMAN_ORIGIN_KINDS = ["operator-cli", "operator-session", "human-event"] as const;

export type HumanOriginKind = (typeof HUMAN_ORIGIN_KINDS)[number];

/** Origin kinds that NEVER satisfy an implementation-approval gate. */
export const REJECTED_ORIGIN_KINDS = [
  "agent-lifecycle",
  "xbrief-status",
  "dispatch-envelope",
  "allocation-context",
  "self-asserted",
  "agent-authored",
] as const;

export type RejectedOriginKind = (typeof REJECTED_ORIGIN_KINDS)[number];

export interface GrantOrigin {
  readonly kind: string;
  readonly actor: string;
  readonly mintedAt: string;
  readonly mintedVia: string;
  /** Optional external human event ref (issue comment URL, plan:approved id, …). */
  readonly eventRef: string | null;
}

export interface GrantScope {
  /** Immutable plan id or content hash string (structural; not crypto HMAC). */
  readonly planRef: string | null;
  readonly repo: string | null;
  readonly branch: string | null;
  readonly worktree: string | null;
  /** Path globs for permitted file/product surfaces (incl. user-visible UI). */
  readonly surfaces: readonly string[];
  readonly operations: readonly AuthzOperation[];
  readonly storyIds: readonly string[];
  readonly issueIds: readonly number[];
  /**
   * Named fix cohort under an active UAT lease. Required when UAT is active
   * for product mutations; approving one cohort does not clear UAT.
   */
  readonly cohortId: string | null;
}

export interface GrantSemantics {
  readonly expiresAt: string | null;
  readonly singleUse: boolean;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
}

export interface HumanOriginGrant {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly origin: GrantOrigin;
  readonly scope: GrantScope;
  readonly semantics: GrantSemantics;
}

export interface UatLease {
  readonly active: boolean;
  readonly campaignId: string;
  readonly startedAt: string;
  readonly startedBy: GrantOrigin;
  readonly suspendedAt: string | null;
  readonly note: string | null;
}

export interface AuthzState {
  readonly schemaVersion: 1;
  readonly uat: UatLease | null;
  /** Optional pin of grant ids considered active (empty = all non-revoked on disk). */
  readonly activeGrantIds: readonly string[];
}

export type AuthzDecisionCode =
  | "authz-allow"
  | "authz-inactive"
  | "authz-uat-deny"
  | "authz-grant-missing"
  | "authz-grant-origin-reject"
  | "authz-grant-scope-deny"
  | "authz-grant-expired"
  | "authz-grant-revoked"
  | "authz-grant-single-use-spent";

/** Structured codes for release-class closed-verb gates (#1095 Wave 4). */
export type ClosedVerbDecisionCode =
  | "closed-verb-allow"
  | "closed-verb-env-bypass"
  | "closed-verb-deny-missing"
  | "closed-verb-deny-origin"
  | "closed-verb-deny-scope"
  | "closed-verb-deny-expired"
  | "closed-verb-deny-revoked"
  | "closed-verb-deny-spent"
  | "closed-verb-unknown";

export interface ClosedVerbDecision {
  readonly allowed: boolean;
  readonly code: ClosedVerbDecisionCode;
  readonly reason: string;
  readonly verb: string;
  readonly target: string | null;
  readonly humanApprovalRef: string | null;
  readonly envBypassKey: string | null;
  readonly skillPointer: string | null;
}

export interface AuthzDecision {
  readonly allowed: boolean;
  readonly code: AuthzDecisionCode;
  readonly reason: string;
  readonly humanApprovalRef: string | null;
  readonly approvedScope: GrantScope | null;
  readonly attemptedOp: AuthzOperation | "test" | "evidence" | "unknown";
  readonly path: string | null;
}

export interface AuthzAuditRecord {
  readonly schemaVersion: 1;
  readonly ts: string;
  readonly humanApprovalRef: string | null;
  readonly approvedScope: GrantScope | null;
  readonly attemptedOp: string;
  readonly path: string | null;
  readonly result: "allow" | "deny";
  readonly code: AuthzDecisionCode;
  readonly message: string;
  readonly campaignId: string | null;
}

export const AUTHZ_SCHEMA_VERSION = 1 as const;
export const AUTHZ_DIR = ".deft/authz";
export const AUTHZ_STATE_FILE = "state.json";
export const AUTHZ_GRANTS_DIR = "grants";
export const AUTHZ_AUDIT_FILE = "audit.jsonl";
