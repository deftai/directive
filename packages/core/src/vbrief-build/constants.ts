/** Canonical ``vBRIEFInfo.version`` emitted on scope vBRIEFs (#533). */
export const EMITTED_VBRIEF_VERSION = "0.6";

/** Migrator provenance namespace under ``plan.metadata`` (#616). */
export const MIGRATOR_METADATA_KEY = "x-migrator";

export const PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json";

export const DEPRECATION_SENTINEL = "<!-- deft:deprecated-redirect -->";

export const INTERNAL_REFERENCE_TYPES = new Set([
  "x-vbrief/plan",
  "x-vbrief/spec-section",
  "x-vbrief/user-request",
]);

export const EXTERNAL_REFERENCE_TYPES = new Set([
  "x-vbrief/github-issue",
  "x-vbrief/github-pr",
  "x-vbrief/jira-ticket",
  "x-vbrief/web-page",
]);

export const FOLDER_TO_STATUSES: Readonly<Record<string, readonly string[]>> = {
  proposed: ["draft", "proposed"],
  pending: ["approved", "pending"],
  active: ["running", "blocked"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

export const STATUS_TO_FOLDER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FOLDER_TO_STATUSES).flatMap(([folder, statuses]) =>
    statuses.map((status) => [status, folder]),
  ),
);

export const LIFECYCLE_FOLDERS = Object.keys(FOLDER_TO_STATUSES);

export const DEFAULT_STATUS_FOR_FOLDER: Readonly<Record<string, string>> = {
  proposed: "proposed",
  pending: "pending",
  active: "running",
  completed: "completed",
  cancelled: "cancelled",
};
