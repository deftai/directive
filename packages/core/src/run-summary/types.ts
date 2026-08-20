/**
 * Run-summary telemetry types (#3282).
 *
 * Event-driven JSONL lines for harness collection. Silent by default unless
 * `DEFT_RUN_SUMMARY_PATH` is set (or the gitignored default path is writable).
 */

export const RUN_SUMMARY_SCHEMA_VERSION = 1 as const;

/** Env var that opts into / redirects run-summary JSONL (#3282). */
export const ENV_RUN_SUMMARY_PATH = "DEFT_RUN_SUMMARY_PATH";

/** Harness-supplied session tool/turn total stamped onto run-summary lines (#3320). */
export const ENV_TOTAL_TOOL_TURNS = "DEFT_TOTAL_TOOL_TURNS";

/** Repo-root default collectible path when gitignore coverage is present. */
export const DEFAULT_RUN_SUMMARY_BASENAME = ".deft-run-summary.json";

/** Prefix for stdout lines when `DEFT_RUN_SUMMARY_PATH=-`. */
export const RUN_SUMMARY_STDOUT_PREFIX = "DEFT-TLM:";

/** One warning when an explicitly requested write fails. */
export const RUN_SUMMARY_WRITE_WARNING =
  "[deft run-summary] failed to write DEFT_RUN_SUMMARY_PATH telemetry (fail-open; exit codes unchanged)";

export const RUN_SUMMARY_EVENT_KINDS = [
  "session_start",
  "dial_transition",
  "dial_escalation_evaluation",
  "check_invocation",
  "tool_turn_denominator",
  "verification",
  "acceptance",
  "acceptance_stamp",
  "ac_pass_bank",
] as const;

export type RunSummaryEventKind = (typeof RUN_SUMMARY_EVENT_KINDS)[number];

export interface RunSummaryBaseFields {
  readonly schema_version: typeof RUN_SUMMARY_SCHEMA_VERSION;
  readonly session_id: string;
  readonly framework_version: string;
  /**
   * Monotonic 1-based sequence for this destination (#3350).
   * File destinations continue from the existing JSONL line count so multiple
   * CLI processes appending to one DEFT_RUN_SUMMARY_PATH share 1..N. Concurrent
   * file writers serialize count-then-append via a sibling lock; reclaim is
   * allowed only when the lock owner process is dead or the token is unknown
   * (#3361). Stdout destinations stay per-process (each process starts at 1).
   */
  readonly seq: number;
  readonly ts: string;
  readonly event: RunSummaryEventKind;
  /**
   * Optional emitter label (verify-ac, clause-derivation, …). Not a closed
   * union — new callers add a string without a schema bump (#3399).
   */
  readonly component?: string;
  /**
   * Session total tool/turn count (#3320). Present so ritual+gate share is
   * computable from the summary alone. Absence means the #3286 trigger is unevaluable.
   */
  readonly total_tool_turns?: number;
}

export interface SessionStartRunSummaryPayload {
  readonly ceremony_dial?: Record<string, unknown>;
  readonly preflight?: Record<string, unknown>;
  readonly ceremony_tier?: string;
  readonly ready?: boolean;
  readonly exit_code?: number;
  /** #3286: orientation surfaces composed into session:start (graduation trigger). */
  readonly orientation_call_count?: number;
  readonly orientation_compact?: boolean;
  readonly deposit_sha?: string;
  readonly orientation_later_status?: string;
  readonly orientation_sections?: readonly Record<string, unknown>[];
}

export interface DialTransitionRunSummaryPayload {
  readonly from: string | null;
  readonly to: string;
  readonly reason: string;
  readonly evidence?: string;
}

/** One evaluation of escalate-on-evidence (#3319). Absence of this event ≠ declined. */
export type DialEscalationEvaluationOutcome = "escalated" | "declined";

export interface DialEscalationEvaluationRunSummaryPayload {
  /** Ceremony depth considered (the start/current tier under evaluation). */
  readonly tier: string;
  readonly outcome: DialEscalationEvaluationOutcome;
  readonly reason: string;
}

export interface CheckGateOutcome {
  readonly id: string;
  readonly status: "run" | "skipped" | "failed";
  readonly exit_code?: number;
  readonly cause?: string;
  readonly remedy?: string;
  readonly from_cache?: boolean;
}

/** Per-clause coverage row carried on verify:ac telemetry (#3323). */
export interface AcceptanceClauseOutcomeRow {
  readonly id: number;
  readonly outcome: "verified" | "unverifiable" | "failed";
}

export interface CheckInvocationRunSummaryPayload {
  readonly target: string;
  readonly exit_code: number;
  readonly degraded?: boolean;
  readonly gates: readonly CheckGateOutcome[];
  /** Additive verify:ac fields (#3323). Consumers ignore unknown keys. */
  readonly source_rung?: string;
  readonly none_stated?: boolean;
  readonly clause_outcomes?: readonly AcceptanceClauseOutcomeRow[];
}

/** How a tool_turn_denominator value was obtained (#3399). */
export type ToolTurnDenominatorSource = "harness_actual" | "host_planned";

/** Total tool/turn count for the session (#3320 / #3399). */
export interface ToolTurnDenominatorRunSummaryPayload {
  readonly total_tool_turns: number;
  readonly denominator_source?: ToolTurnDenominatorSource;
}

/** Bank checkpoint JSONL payload. Disk ledger stays camelCase (#3387). */
export interface AcPassBankRunSummaryPayload {
  readonly scope_id: string;
  readonly banked_at: string;
  readonly next_action?: string;
  readonly had_surplus?: boolean;
  readonly surplus_threshold?: number;
  readonly remaining_fraction?: number | null;
  readonly remaining_turns?: number | null;
  readonly remaining_budget?: number | null;
  readonly max_turns?: number | null;
  readonly max_budget?: number | null;
  readonly head_sha?: string | null;
  readonly path?: string;
}

/** Product-oracle attempt (#3322). Same emitter as #3319 / #3320. */
export type VerificationOutcome = "pass" | "fail";

/** verify:ac resolution telemetry (#3334 / #3355). Distinct from verification pass/fail. */
export type AcceptanceRunSummaryOutcome =
  | "verified-pass"
  | "empty-pass"
  | "soft_empty"
  | "fail"
  | "config-error"
  | "soft-missing"
  | "rejected-noop";

export interface AcceptanceRunSummaryPayload {
  readonly resolved_command_count: number;
  readonly outcome: AcceptanceRunSummaryOutcome;
  readonly source_rung?: string;
  readonly none_stated?: boolean;
  readonly clause_count?: number;
  readonly clause_outcomes?: readonly AcceptanceClauseOutcomeRow[];
  /** bank | cache | executed — how verify:ac obtained this result (#3387). */
  readonly served_from?: "bank" | "cache" | "executed";
  /** Config-error cause when outcome is config-error (#3559). */
  readonly cause?: string;
}

/** Intake-time stamp: which rung locked, whether commands were stated, counts (#3323). */
export interface AcceptanceStampRunSummaryPayload {
  readonly rung: string;
  readonly none_stated: boolean;
  readonly command_count: number;
  readonly clause_count: number;
}

export interface VerificationRunSummaryPayload {
  readonly check_id: string;
  readonly method_fingerprint: string;
  readonly outcome: VerificationOutcome;
  /**
   * True when both sides of the comparison were rebuilt from scratch by a
   * different method than the one that failed. Required to resolve
   * fail → method-change → pass (#3322).
   */
  readonly independent_rederivation?: boolean;
}

export type RunSummaryPayload =
  | SessionStartRunSummaryPayload
  | DialTransitionRunSummaryPayload
  | DialEscalationEvaluationRunSummaryPayload
  | CheckInvocationRunSummaryPayload
  | ToolTurnDenominatorRunSummaryPayload
  | VerificationRunSummaryPayload
  | AcceptanceRunSummaryPayload
  | AcceptanceStampRunSummaryPayload
  | AcPassBankRunSummaryPayload;

export type RunSummaryLine = RunSummaryBaseFields & {
  readonly payload: RunSummaryPayload;
};

export type RunSummaryDestination =
  | { readonly kind: "silent" }
  | { readonly kind: "stdout" }
  | {
      readonly kind: "file";
      readonly path: string;
      /** Truncate default-path file on session_start only. */
      readonly truncateOnSessionStart: boolean;
      /** Explicit path (env set) vs default gitignored path. */
      readonly explicit: boolean;
    };
