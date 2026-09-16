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

/** Solo leftover-land recovery after empty-active / scope-not-ready (#4421 / #3476 / #3679). */
export const LEFTOVER_LAND_PR_REMEDIATION =
  "Sanctioned close-out is unreachable from the solo consumer path, not unsatisfiable. " +
  "Strike option 2 as written: do not complete the scope in the product PR. " +
  "After a provenance-gated product PR strips active/ from the change set, " +
  "the designed remainder is a leftover land PR (#3476). " +
  "Solo sequence after the product PR merges: run `task scope:complete` " +
  "(it can stamp a brief already in completed/), git add of that verb's already-written diff, " +
  "then open the leftover-land lifecycle PR. " +
  "That git add is leftover-land of the verb's diff, not a Shell reach-around of product files. " +
  "Empty-active / scope-not-ready recovery names leftover land. " +
  "Do not Edit/Write completed/. Do not mint a completed/ Write class. " +
  "A leftover-land PR is a lifecycle-only diff (completed/cancelled xBRIEFs + optional CHANGELOG) " +
  "after the origin issue is merged or closed. After merge means after the product PR, not after the land PR. " +
  "Greptile partition: xbrief/active/ on a product PR is correct; " +
  "completed/ on a product PR before merge stays a defect; " +
  "completed/ on a leftover-land PR after merge is the sanctioned close-out. " +
  "Org-enforced dashboard rules cannot be overridden by rules.md. " +
  "Do not mint a completing status or a default-branch auto-finalizer without a runTransition stamp and lease. " +
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

/**
 * Completion-specific stamp for an active/ -> completed/ move (#4508).
 *
 * Policy: GitHub-closed is not authority to mint lifecycleWrite or rewrite
 * failed/legacy work as completed. Fail stamps, failed status, and cancel
 * stamps do not authorize that rewrite. Only a complete action stamp or
 * pre-#3679 metadata.completedAt does.
 */
export function hasCompleteTransitionWrite(plan: Record<string, unknown>): boolean {
  if (stampAction(plan) === "cancel" || stampAction(plan) === "fail") {
    return false;
  }
  if (hasLifecycleWriteStamp(plan) && stampAction(plan) === "complete") {
    return true;
  }
  const meta = asRecord(plan.metadata);
  return (
    meta !== null && typeof meta.completedAt === "string" && meta.completedAt.trim().length > 0
  );
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
    return hasLifecycleWriteStamp(plan) && stampAction(plan) === "cancel";
  }
  if (stampAction(plan) === "cancel") {
    return false;
  }
  return hasTransitionWrite(plan);
}
