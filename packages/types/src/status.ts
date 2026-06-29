/** v0.6 lifecycle status enum — mirrors `Status` in vbrief-core.schema.json. */
export const VALID_STATUSES = [
  "draft",
  "proposed",
  "approved",
  "pending",
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;

export type Status = (typeof VALID_STATUSES)[number];

/** Folder mapping used by lifecycle validators (informational for consumers). */
export const FOLDER_ALLOWED_STATUSES: Readonly<Record<string, readonly Status[]>> = {
  proposed: ["draft", "proposed"],
  pending: ["approved", "pending"],
  active: ["running", "blocked"],
  completed: ["completed", "failed"],
  cancelled: ["cancelled"],
};
