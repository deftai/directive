export const EXIT_OK = 0;
export const EXIT_GATE_FAILED = 1;
export const EXIT_CONFIG_ERROR = 2;

export const EXIT_VALIDATION_ERROR = 1;
export const EXIT_FAILED = 1;
export const EXIT_UNCLEAN = 1;
export const EXIT_EXTERNAL_ERROR = 2;

export const DEFAULT_BASE_BRANCH = "master";
export const LEAF_CODING_WORKER_ROLE = "leaf-implementation";
export const SUBAGENT_BACKEND_SET_CMD = "task policy:subagent-backend -- --set {backend_id}";

export const GATE_ADVISE = "advise";
export const GATE_ENFORCE = "enforce";

export const READY = "ready";

export const LIFECYCLE_FOLDERS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

export const TERMINAL_FOLDERS = ["completed", "cancelled"] as const;

export const C3_FIELDS = ["story_id", "worktree_path", "base_branch"] as const;

export const MAX_FIXPOINT_PASSES = 50;
