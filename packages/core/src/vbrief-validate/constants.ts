/** v0.6/v0.8 plan-level Status enum (excludes item-only `auto`). */
export const VALID_PLAN_STATUSES = new Set([
  "draft",
  "proposed",
  "approved",
  "pending",
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled",
]);

/** PlanItem status enum — plan statuses plus container rollup `auto` (#2107 / xBRIEF v0.8). */
export const VALID_ITEM_STATUSES = new Set([...VALID_PLAN_STATUSES, "auto"]);

/** @deprecated Use VALID_PLAN_STATUSES or VALID_ITEM_STATUSES; kept for module re-exports. */
export const VALID_STATUSES = VALID_PLAN_STATUSES;

export const VALID_VBRIEF_VERSIONS = new Set(["0.6", "0.8"]);

/** Accepted top-level document info blocks (additive v0.6 + v0.8). */
export const VALID_INFO_ROOT_KEYS = new Set(["vBRIEFInfo", "xBRIEFInfo"]);

/** v0.8 PlanItem.type enum values (optional field). */
export const VALID_PLAN_ITEM_TYPES = new Set(["task", "group", "milestone", "epic"]);

/** D13: status-to-folder mapping (#533 adds ``failed`` in completed/). */
export const FOLDER_ALLOWED_STATUSES: Readonly<Record<string, ReadonlySet<string>>> = {
  proposed: new Set(["draft", "proposed"]),
  pending: new Set(["approved", "pending"]),
  active: new Set(["running", "blocked"]),
  completed: new Set(["completed", "failed"]),
  cancelled: new Set(["cancelled"]),
};

export const LIFECYCLE_FOLDERS = Object.keys(FOLDER_ALLOWED_STATUSES);

/** D3: expected narrative keys for PROJECT-DEFINITION (normalized). */
export const PROJECT_DEF_EXPECTED_NARRATIVES = new Set(["overview", "techstack"]);

export const STRICT_ORIGIN_ALLOWLIST = new Set([
  "x-vbrief/plan",
  "x-vbrief/github-issue",
  "x-vbrief/github-pr",
  "x-vbrief/jira-ticket",
  "x-vbrief/user-request",
  "x-vbrief/spec-section",
  "x-xbrief/plan",
  "x-xbrief/github-issue",
  "x-xbrief/github-pr",
  "x-xbrief/jira-ticket",
  "x-xbrief/user-request",
  "x-xbrief/spec-section",
  "x-xbrief/commit",
  "x-xbrief/external",
  "x-xbrief/research",
  "x-xbrief/adr",
]);

export const LEGACY_ORIGIN_TYPES = new Set(["github-issue", "jira-ticket", "user-request"]);

export const DEPRECATED_FILES = ["SPECIFICATION.md", "PROJECT.md"] as const;

export const USAGE =
  "Usage: vbrief_validate.py [--vbrief-dir <path>] [--strict-origin-types] [--warnings-as-errors]";
