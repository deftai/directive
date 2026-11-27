/**
 * TOTP-armed operator delegation (#7420): types and named constants.
 *
 * A phone-only operator types `deft delegate on <ttl> <code>` in chat. A thin
 * host adapter passes the prompt text and the host session id to the one core
 * arming verb (`arm.ts`). A valid code writes a time-boxed delegation record.
 * While it is live, #7279 harness-attended requests for approved-scope and the
 * four release templates complete with provenance `delegated-totp`.
 *
 * Strength (operator decision "Equal effort, limits"): the TOTP secret is
 * readable by any process of the operator's OS user, so forging an arm costs
 * about the same as forging today's terminal gate; one arm buys hours of
 * authority instead of one mint. The passkey (#6945 / #7046) is the upgrade
 * that makes the code unproducible by an agent.
 *
 * Each constant below is owned by this feature. Do not reuse another action's
 * constant for any of these values, and do not reuse these elsewhere.
 */

/** Schema version of the delegation store and record. */
export const DELEGATION_SCHEMA_VERSION = 1 as const;

/** Default delegation lifetime when the arm command names no TTL (#7420 B2). */
export const DELEGATION_DEFAULT_TTL_HOURS = 12;

/** Longest delegation lifetime an arm may ask for (#7420 B2). */
export const DELEGATION_MAX_TTL_HOURS = 72;

/** Shortest delegation lifetime an arm may ask for. */
export const DELEGATION_MIN_TTL_HOURS = 1;

/** TOTP time step in seconds (RFC 6238 default; matches phone authenticator apps). */
export const DELEGATION_TOTP_STEP_SECONDS = 30;

/** TOTP code length in digits (RFC 6238 default; matches phone authenticator apps). */
export const DELEGATION_TOTP_DIGITS = 6;

/**
 * Accepted clock drift in whole steps on each side of the current step.
 * One step either way tolerates a phone clock up to 30s off.
 */
export const DELEGATION_TOTP_DRIFT_STEPS = 1;

/** Size of a freshly enrolled TOTP secret in bytes (RFC 4226 recommends 160 bits). */
export const DELEGATION_TOTP_SECRET_BYTES = 20;

/** Issuer label in the enrollment `otpauth://` URI. */
export const DELEGATION_TOTP_ISSUER = "Directive";

/**
 * Directory under the user config dir that holds the enrolled secret. Outside
 * every repository: `%APPDATA%\deft\delegation` on win32, else
 * `$XDG_CONFIG_HOME/deft/delegation` or `~/.config/deft/delegation`.
 */
export const DELEGATION_SECRET_DIR_NAME = "delegation";

/** Enrolled secret file name under {@link DELEGATION_SECRET_DIR_NAME}. */
export const DELEGATION_SECRET_FILE_NAME = "totp-secret.json";

/** Protected delegation store, relative to the main checkout root (#7420 B1). */
export const DELEGATION_STORE_REL = ".deft/authz/delegation";

/** Store state file name (holds `lastAcceptedStep` and the record). */
export const DELEGATION_STATE_FILE = "state.json";

/** Store audit log file name (one JSON line per arm, end, delegated mint or allow). */
export const DELEGATION_AUDIT_FILE = "audit.jsonl";

/** Store lock file name (exclusive create; one locked step per arm or end). */
export const DELEGATION_LOCK_FILE = "state.lock";

/** How long an arm or end waits for the store lock before it refuses. */
export const DELEGATION_LOCK_TIMEOUT_MS = 5000;

/** Pause between store lock attempts. */
export const DELEGATION_LOCK_RETRY_MS = 25;

/**
 * Provenance of a harness-attended completion, grant or stamp made under a
 * live delegation (#7420 B3). Never `host-user-event`.
 */
export const DELEGATED_TOTP_PROVENANCE = "delegated-totp" as const;

/**
 * Longest life of a grant or approved-scope stamp minted under a delegation.
 * The minted expiry is the earliest of this cap, the template's own default
 * and the delegation's `expiresAt`; consumers also stop admitting the moment
 * the delegation ends (#7420 B4).
 */
export const DELEGATED_AUTHORITY_MAX_EXPIRY_HOURS = 72;

/** Arm command keyword sequence typed in chat: `deft delegate on [<ttl>] <code>`. */
export const DELEGATION_ARM_COMMAND = "deft delegate on";

/** One-line chat prefix for every delegated mint or allow (#7420 B8). */
export const DELEGATED_ACTION_CHAT_LINE_PREFIX = "[delegated-totp]";

/** Verb that mints approved-scope stamps (delegable, #7420 B3). */
export const DELEGABLE_APPROVED_SCOPE_VERB = "scope:record-approved-scope";

/** Verb that mints release grants (delegable only with a release template, #7420 B3). */
export const DELEGABLE_GRANT_VERB = "authz:grant";

/** The four release templates a live delegation may mint (operator: "Plus release templates"). */
export const DELEGABLE_RELEASE_TEMPLATES = [
  "release-cut",
  "release-publish",
  "release-rollback",
  "release-promote-latest",
] as const;

export type DelegableReleaseTemplate = (typeof DELEGABLE_RELEASE_TEMPLATES)[number];

/**
 * Hook deny conditions a live delegation turns into allow-with-audit (#7420 B5).
 * Per-condition form only: the commit-admission scope-cover failure that is
 * advisory-capable (targets resolved, staged paths read). Unresolved targets,
 * unreadable staged paths and index-changing forms are other conditions and
 * still refuse.
 */
export const DELEGABLE_HOOK_ALLOWS = ["prospective-scope-cover-deny:advisory-capable"] as const;

export type DelegableHookAllow = (typeof DELEGABLE_HOOK_ALLOWS)[number];

/** Harness-attended verbs a delegation may complete. Every other verb refuses. */
export const DELEGABLE_MINT_VERBS = [DELEGABLE_APPROVED_SCOPE_VERB, DELEGABLE_GRANT_VERB] as const;

/**
 * Named never-delegable stops (#7420 B7). Kept as data so the docs and tests
 * can show the refusal is deliberate; the evaluator is an allowlist, so any
 * name not on the allowlist refuses whether or not it is listed here.
 */
export const NEVER_DELEGABLE_TEMPLATES = [
  "finish-loop",
  "gate-override",
  "spec-drift-override",
  "one-pr-unit",
  "delivery-identity-attest",
  "acceptance-disposition",
  "plan-sequence-approval",
] as const;

/** Harness-attended verbs that never complete under a delegation (#7420 B7). */
export const NEVER_DELEGABLE_VERBS = [
  "authz:uat-start",
  "authz:uat-suspend",
  "authz:revoke",
  "kill-switch:on",
  "kill-switch:off",
  "approvers:enroll",
  "approvers:remove",
] as const;

/** Why a delegation ended (#7420 B2). */
export type DelegationEndReason =
  | "operator-off"
  | "ttl-expired"
  | "session-end"
  | "uat-start"
  | "kill-switch"
  | "authz-revoke";

/** The allowlist frozen into a record at arm time. */
export interface DelegationAllowlist {
  readonly verbs: readonly string[];
  readonly templates: readonly string[];
  /** Hook deny conditions allowed with audit (#7420 B5); absent on older records = none. */
  readonly hookAllows?: readonly string[];
}

/** One delegation record (#7420 B2). */
export interface DelegationRecord {
  readonly schemaVersion: typeof DELEGATION_SCHEMA_VERSION;
  readonly delegationId: string;
  /**
   * Host session id at arm time. It limits the record's life and labels the
   * audit; it is not isolation between agents of the same OS user.
   */
  readonly hostSessionId: string;
  /** Host adapter that armed it (e.g. `claude`). */
  readonly host: string;
  readonly armedAt: string;
  /** Hard cap; never later than armedAt + {@link DELEGATION_MAX_TTL_HOURS}. */
  readonly expiresAt: string;
  /** TOTP step of the arming code. */
  readonly armedStep: number;
  readonly allowlist: DelegationAllowlist;
  readonly provenance: typeof DELEGATED_TOTP_PROVENANCE;
  readonly endedAt: string | null;
  readonly endedReason: DelegationEndReason | null;
}

/** Store state (#7420 B1). */
export interface DelegationState {
  readonly schemaVersion: typeof DELEGATION_SCHEMA_VERSION;
  /** Highest TOTP step ever seen as valid. A step at or below it is a quiet no-op. */
  readonly lastAcceptedStep: number;
  readonly record: DelegationRecord | null;
}

/** Liveness verdict for a record at one moment. */
export type DelegationLiveness =
  | { readonly live: true; readonly record: DelegationRecord }
  | {
      readonly live: false;
      readonly reason: DelegationEndReason | "no-record" | "store-unreadable";
    };

/** What a consumer needs to know about the live delegation (or null). */
export interface LiveDelegationView {
  readonly delegationId: string;
  readonly hostSessionId: string;
  readonly expiresAt: string;
  readonly allowlist: DelegationAllowlist;
}

/** One audit line in the delegation store. */
export interface DelegationAuditRecord {
  readonly schemaVersion: typeof DELEGATION_SCHEMA_VERSION;
  readonly ts: string;
  readonly event: "arm" | "arm-refused" | "end" | "delegated-mint" | "delegated-allow";
  readonly provenance: typeof DELEGATED_TOTP_PROVENANCE;
  readonly delegationId: string | null;
  readonly hostSessionId: string | null;
  readonly detail: string;
}

/** Result of a delegated harness-attended completion, handed to the minting caller. */
export interface DelegatedCompletion {
  readonly provenance: typeof DELEGATED_TOTP_PROVENANCE;
  readonly delegationId: string;
  readonly hostSessionId: string;
  readonly delegationExpiresAt: string;
  readonly verb: string;
  readonly template: string | null;
  readonly requestId: string;
}
