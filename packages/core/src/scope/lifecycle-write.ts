/**
 * Transition-write fingerprint for completed/ artifacts (#3679).
 *
 * Distinct from completionProvenance (#3686): this only records that
 * runTransition wrote the blob. Non-code-bearing completes and scope:fail
 * stamp this and still omit delivery provenance.
 */

export const LIFECYCLE_WRITE_KEY = "lifecycleWrite" as const;

export type LifecycleWriteAction = "complete" | "fail" | "cancel";

export interface LifecycleWriteStamp {
  readonly action: LifecycleWriteAction;
  readonly writtenAt: string;
}

/** Worker-facing leftover-land path after a scope-provenance strip (#3476 / #3679). */
export const LEFTOVER_LAND_PR_REMEDIATION =
  "After a provenance-gated product PR strips active/ from the change set, " +
  "the designed remainder is a leftover land PR (#3476): run `task scope:complete` " +
  "after merge (it can stamp a brief already in completed/), then land that artifact. " +
  "Do not git-add a completed/ husk to skip the verb.";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function metadataRecord(plan: Record<string, unknown>): Record<string, unknown> {
  const existing = asRecord(plan.metadata);
  if (existing !== null) {
    return existing;
  }
  const created: Record<string, unknown> = {};
  plan.metadata = created;
  return created;
}

/** Stamp that runTransition wrote this plan into completed/ or cancelled/. */
export function stampLifecycleWrite(
  plan: Record<string, unknown>,
  action: LifecycleWriteAction,
  writtenAt: string,
): void {
  const meta = metadataRecord(plan);
  meta[LIFECYCLE_WRITE_KEY] = { action, writtenAt };
}

function hasLifecycleWriteStamp(plan: Record<string, unknown>): boolean {
  const meta = asRecord(plan.metadata);
  if (meta === null) {
    return false;
  }
  const stamp = asRecord(meta[LIFECYCLE_WRITE_KEY]);
  if (stamp === null) {
    return false;
  }
  const action = stamp.action;
  const writtenAt = stamp.writtenAt;
  return (
    (action === "complete" || action === "fail" || action === "cancel") &&
    typeof writtenAt === "string" &&
    writtenAt.trim().length > 0
  );
}

/**
 * True when a completed/ blob shows verb evidence.
 * Accepts the new stamp, legacy completedAt (pre-#3679 complete), or failed status
 * (scope:fail never stamped provenance and must keep passing).
 */
export function hasTransitionWrite(plan: Record<string, unknown>): boolean {
  if (hasLifecycleWriteStamp(plan)) {
    return true;
  }
  const meta = asRecord(plan.metadata);
  if (meta !== null && typeof meta.completedAt === "string" && meta.completedAt.trim().length > 0) {
    return true;
  }
  return String(plan.status ?? "") === "failed";
}

function stampAction(plan: Record<string, unknown>): string | null {
  const meta = asRecord(plan.metadata);
  if (meta === null) {
    return null;
  }
  const stamp = asRecord(meta[LIFECYCLE_WRITE_KEY]);
  if (stamp === null) {
    return null;
  }
  const action = stamp.action;
  return typeof action === "string" ? action : null;
}

/** Folder-aware stamp: cancel stamps do not authorize completed/, and vice versa. */
export function transitionWriteFitsFolder(
  plan: Record<string, unknown>,
  folder: "completed" | "cancelled",
): boolean {
  if (folder === "cancelled") {
    return stampAction(plan) === "cancel";
  }
  if (stampAction(plan) === "cancel") {
    return false;
  }
  return hasTransitionWrite(plan);
}
