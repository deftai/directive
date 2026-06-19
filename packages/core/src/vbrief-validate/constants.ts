/** v0.6 Status enum from the canonical schema. */
export const VALID_STATUSES = new Set([
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

export const VALID_VBRIEF_VERSIONS = new Set(["0.6"]);

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
]);

export const LEGACY_ORIGIN_TYPES = new Set(["github-issue", "jira-ticket", "user-request"]);

export const DEPRECATED_FILES = ["SPECIFICATION.md", "PROJECT.md"] as const;

export const USAGE =
  "Usage: vbrief_validate.py [--vbrief-dir <path>] [--strict-origin-types] [--warnings-as-errors]";
