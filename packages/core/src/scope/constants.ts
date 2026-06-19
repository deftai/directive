/** vBRIEF lifecycle folder names. */
export const LIFECYCLE_FOLDERS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

export type LifecycleFolder = (typeof LIFECYCLE_FOLDERS)[number];

export type ScopeAction =
  | "promote"
  | "activate"
  | "complete"
  | "fail"
  | "cancel"
  | "restore"
  | "block"
  | "unblock";

export interface TransitionSpec {
  readonly allowedSources: readonly LifecycleFolder[];
  readonly targetFolder: LifecycleFolder | null;
  readonly targetStatus: string;
}

/** action -> (allowed_source_folders, target_folder, target_status) */
export const TRANSITIONS: Record<ScopeAction, TransitionSpec> = {
  promote: { allowedSources: ["proposed"], targetFolder: "pending", targetStatus: "pending" },
  activate: { allowedSources: ["pending"], targetFolder: "active", targetStatus: "running" },
  complete: { allowedSources: ["active"], targetFolder: "completed", targetStatus: "completed" },
  fail: { allowedSources: ["active"], targetFolder: "completed", targetStatus: "failed" },
  cancel: {
    allowedSources: LIFECYCLE_FOLDERS,
    targetFolder: "cancelled",
    targetStatus: "cancelled",
  },
  restore: { allowedSources: ["cancelled"], targetFolder: "proposed", targetStatus: "proposed" },
  block: { allowedSources: ["active"], targetFolder: null, targetStatus: "blocked" },
  unblock: { allowedSources: ["active"], targetFolder: null, targetStatus: "running" },
};

/** Status preconditions for in-place actions. */
export const STATUS_PRECONDITIONS: Partial<Record<ScopeAction, string>> = {
  block: "running",
  unblock: "blocked",
};

export const MOVE_LABELS: Partial<Record<ScopeAction, string>> = {
  promote: "Promoted",
  activate: "Activated",
  complete: "Completed",
  fail: "Failed",
  cancel: "Cancelled",
  restore: "Restored",
};

export const STAY_LABELS: Partial<Record<ScopeAction, string>> = {
  block: "Blocked",
  unblock: "Unblocked",
};

export const REVERSIBLE_ACTIONS = new Set(["demote", "cancel", "restore", "undo"]);
export const TERMINAL_ACTIONS = new Set(["complete", "fail"]);

export const AUDIT_LOG_REL_PATH = "vbrief/.eval/scope-lifecycle.jsonl";
