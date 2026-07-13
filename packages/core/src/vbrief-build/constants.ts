import { VBRIEF_VERSION } from "@deftai/directive-types";

/** Canonical envelope version emitted on new scope xBRIEFs (#533, #2318). */
export const EMITTED_VBRIEF_VERSION = VBRIEF_VERSION;

/** Migrator provenance namespace under ``plan.metadata`` (#616). */
export const MIGRATOR_METADATA_KEY = "x-migrator";

/** Layout-aware PROJECT-DEFINITION paths live in ``project-definition-io.ts`` / ``policy/resolve.ts`` (#2302). */

export const DEPRECATION_SENTINEL = "<!-- deft:deprecated-redirect -->";

export const INTERNAL_REFERENCE_TYPES = new Set([
  "x-vbrief/plan",
  "x-vbrief/spec-section",
  "x-vbrief/user-request",
  "x-xbrief/plan",
  "x-xbrief/spec-section",
  "x-xbrief/user-request",
]);

export const EXTERNAL_REFERENCE_TYPES = new Set([
  "x-vbrief/github-issue",
  "x-vbrief/github-pr",
  "x-vbrief/jira-ticket",
  "x-vbrief/web-page",
  "x-xbrief/github-issue",
  "x-xbrief/github-pr",
  "x-xbrief/jira-ticket",
  "x-xbrief/web-page",
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
