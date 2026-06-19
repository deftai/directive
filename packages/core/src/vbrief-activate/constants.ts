/** Folders the lifecycle move flows between (source allow-list). */
export const SOURCE_FOLDERS = new Set(["pending"]);

export const ACTIVE_FOLDER = "active";

export const ELIGIBLE_STATUSES_FOR_FLIP = new Set(["pending", "approved"]);

export const TARGET_STATUS = "running";

export const ELIGIBLE_STATUSES_SORTED = ["approved", "pending"] as const;

/** Python ``str(sorted(ELIGIBLE_STATUSES_FOR_FLIP))`` for error messages. */
export function formatEligibleStatusList(): string {
  return `[${ELIGIBLE_STATUSES_SORTED.map((s) => `'${s}'`).join(", ")}]`;
}
