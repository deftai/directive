/**
 * Tool-event taxonomy types for explore/commit/verify classification (#2967).
 * Pure types only — no I/O.
 */

/** Deterministic activity buckets for swarm/review operator skim. */
export type ToolEventBucket = "explore" | "commit" | "verify" | "coordinate" | "unknown";

/** All buckets in stable report order (unknown last). */
export const TOOL_EVENT_BUCKETS: readonly ToolEventBucket[] = [
  "explore",
  "commit",
  "verify",
  "coordinate",
  "unknown",
] as const;

/**
 * Minimal tool-event input. Prefer tool name + coarse args; never require
 * full host payloads. Shell tools should pass `command` when known.
 */
export interface ToolEventInput {
  /** Host tool name (e.g. `Read`, `Shell`, `Write`, `Task`). */
  readonly name: string;
  /**
   * Coarse args bag — common keys: `command`, `cmd`, `path`, `file_path`,
   * `query`, `pattern`. Values may be strings or other JSON-ish primitives.
   */
  readonly args?: Readonly<Record<string, unknown>> | null;
  /**
   * Explicit shell/command string when not nested under `args`.
   * Wins over `args.command` / `args.cmd` when both are set.
   */
  readonly command?: string | null;
}

/** Result of classifying one tool event. */
export interface ClassifyToolEventResult {
  readonly bucket: ToolEventBucket;
  /** Stable machine-oriented reason code for tests and debug. */
  readonly reason: string;
}

/** Per-bucket event counts (always includes every bucket key). */
export type ToolEventBucketCounts = Readonly<Record<ToolEventBucket, number>>;

/**
 * Operator-facing anomaly codes derived from a sequence of classified events.
 * Detection is conservative: only fire when the mix is clearly wrong.
 */
export type ToolEventAnomalyCode = "commit-without-explore" | "verify-skipped" | "explore-only";

export interface ToolEventAnomaly {
  readonly code: ToolEventAnomalyCode;
  readonly message: string;
}

/** Aggregate summary for monitor status lines and batch briefs. */
export interface ToolEventSummary {
  readonly total: number;
  readonly counts: ToolEventBucketCounts;
  readonly anomalies: readonly ToolEventAnomaly[];
  /** Compact one-liner: `tools: explore=3 commit=2 verify=1 coordinate=0 unknown=0`. */
  readonly statusLine: string;
}
