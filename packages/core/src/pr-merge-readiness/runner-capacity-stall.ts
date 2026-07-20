/**
 * Runner capacity-stall classifier for required CI check-runs (#2672).
 *
 * Distinct from ordinary `not_ready_yet` (check still under budget / in_progress)
 * and from execution hangs (#2652). A capacity stall is: required check still
 * `queued`, no `started_at`, past the stall budget since `created_at`.
 */

/** Default stall budget: 20 minutes (matches CI_CAPACITY_STALL_SECONDS in ci.yml). */
export const DEFAULT_CAPACITY_STALL_MS = 20 * 60 * 1000;

export interface CapacityStallProbe {
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string;
  /** ISO timestamp when the check-run was created (budget clock). */
  readonly created_at?: string | null;
  /** ISO timestamp when execution started; null/absent while still queued. */
  readonly started_at?: string | null;
}

export interface CapacityStallOptions {
  /** Stall budget in ms (default 20m). */
  readonly budgetMs?: number;
  /** Injectable clock for tests. */
  readonly nowMs?: number;
}

/**
 * True when a single check-run looks capacity-stalled (queued, never started,
 * past budget). Never true for `in_progress` (#2652 must not be conflated).
 */
export function isRunnerCapacityStalled(
  run: CapacityStallProbe,
  options: CapacityStallOptions = {},
): boolean {
  if (run.status !== "queued") {
    return false;
  }
  if (run.started_at != null && String(run.started_at).length > 0) {
    return false;
  }
  const createdRaw = run.created_at;
  if (createdRaw == null || String(createdRaw).length === 0) {
    return false;
  }
  const createdMs = Date.parse(String(createdRaw));
  if (!Number.isFinite(createdMs)) {
    return false;
  }
  const nowMs = options.nowMs ?? Date.now();
  const budgetMs = options.budgetMs ?? DEFAULT_CAPACITY_STALL_MS;
  return nowMs - createdMs >= budgetMs;
}

/**
 * Among pending required check names, return those that are capacity-stalled.
 * Callers pass only the required/pending subset.
 */
export function classifyCapacityStalledRequired(
  pendingRequired: readonly CapacityStallProbe[],
  options: CapacityStallOptions = {},
): readonly string[] {
  const stalled: string[] = [];
  for (const run of pendingRequired) {
    if (isRunnerCapacityStalled(run, options)) {
      stalled.push(run.name);
    }
  }
  return stalled;
}
