/**
 * Local xBRIEF lifecycle folder stats for weekly process rollups (#2995).
 *
 * Filesystem-only inventory of `xbrief/{proposed,pending,active,completed,cancelled}/`.
 * No network calls.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasArtifactSuffix, resolveLayoutRootOrCanonical } from "../layout/resolve.js";
import { parseDurationMs } from "../triage/scope/duration.js";

/** Lifecycle folders scanned for stats. */
export const STATS_LIFECYCLE_FOLDERS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

export type StatsLifecycleFolder = (typeof STATS_LIFECYCLE_FOLDERS)[number];

/** Count semantics for WWYSYDH / process forms (stable strings for --json). */
export const LIFECYCLE_STATS_SEMANTICS = {
  promoted:
    "xbriefs currently in pending/ whose event time falls inside the --since window " +
    "(promoted and still pending; later-activated work is not double-counted here).",
  activated:
    "xbriefs currently in active/ whose event time falls inside the --since window " +
    "(activated and still active).",
  completed:
    "xbriefs currently in completed/ with plan.status completed (or unset, treated as completed) " +
    "whose event time falls inside the --since window.",
  cancelled_or_failed:
    "xbriefs currently in cancelled/, or in completed/ with plan.status failed, " +
    "whose event time falls inside the --since window.",
  still_active: "snapshot count of all xbriefs currently in active/ (not filtered by --since).",
  event_time:
    "event time = plan.metadata.completedAt, else plan.updated, else xBRIEFInfo/vBRIEFInfo.updated, " +
    "else file mtime. Window is [as_of - since, as_of] inclusive of as_of.",
  note:
    "Counts are current-folder membership, not full transition history. A brief that was " +
    "promoted then activated in the same week appears under activated (and still_active), not promoted.",
} as const;

export interface LifecycleFolderTotals {
  readonly proposed: number;
  readonly pending: number;
  readonly active: number;
  readonly completed: number;
  readonly cancelled: number;
}

export interface LifecycleStats {
  readonly since: string;
  readonly since_ms: number;
  readonly as_of: string;
  readonly window_start: string;
  readonly project_root: string;
  readonly lifecycle_root: string;
  readonly promoted: number;
  readonly activated: number;
  readonly completed: number;
  readonly cancelled_or_failed: number;
  readonly still_active: number;
  readonly folder_totals: LifecycleFolderTotals;
  readonly semantics: typeof LIFECYCLE_STATS_SEMANTICS;
}

export interface CollectLifecycleStatsOptions {
  readonly projectRoot: string;
  /** Window duration string, e.g. "7d", "24h", "1w". Default "7d". */
  readonly since?: string;
  /** Clock for window end (tests inject a fixed Date). */
  readonly now?: Date;
}

interface ArtifactRecord {
  readonly folder: StatsLifecycleFolder;
  readonly status: string;
  readonly eventTime: Date | null;
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const text = value.trim().endsWith("Z") ? `${value.trim().slice(0, -1)}+00:00` : value.trim();
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function planOf(data: Record<string, unknown>): Record<string, unknown> | null {
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return null;
  }
  return plan as Record<string, unknown>;
}

function infoUpdated(data: Record<string, unknown>): Date | null {
  for (const key of ["xBRIEFInfo", "vBRIEFInfo"] as const) {
    const info = data[key];
    if (typeof info === "object" && info !== null && !Array.isArray(info)) {
      const stamp = parseIso((info as Record<string, unknown>).updated);
      if (stamp !== null) {
        return stamp;
      }
    }
  }
  return null;
}

function completedAt(plan: Record<string, unknown>): Date | null {
  const metadata = plan.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return null;
  }
  return parseIso((metadata as Record<string, unknown>).completedAt);
}

function eventTimeFor(
  data: Record<string, unknown>,
  plan: Record<string, unknown>,
  path: string,
): Date | null {
  const completed = completedAt(plan);
  if (completed !== null) {
    return completed;
  }
  const planUpdated = parseIso(plan.updated);
  if (planUpdated !== null) {
    return planUpdated;
  }
  const info = infoUpdated(data);
  if (info !== null) {
    return info;
  }
  try {
    return new Date(statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

function statusOf(plan: Record<string, unknown>, folder: StatsLifecycleFolder): string {
  const raw = plan.status;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (folder === "completed") {
    return "completed";
  }
  if (folder === "cancelled") {
    return "cancelled";
  }
  if (folder === "pending") {
    return "pending";
  }
  if (folder === "active") {
    return "running";
  }
  return "proposed";
}

function inWindow(eventTime: Date | null, windowStart: Date, asOf: Date): boolean {
  if (eventTime === null) {
    return false;
  }
  const t = eventTime.getTime();
  return t >= windowStart.getTime() && t <= asOf.getTime();
}

function emptyFolderTotals(): {
  proposed: number;
  pending: number;
  active: number;
  completed: number;
  cancelled: number;
} {
  return { proposed: 0, pending: 0, active: 0, completed: 0, cancelled: 0 };
}

function scanArtifacts(lifecycleRoot: string): ArtifactRecord[] {
  const out: ArtifactRecord[] = [];
  for (const folder of STATS_LIFECYCLE_FOLDERS) {
    const dir = join(lifecycleRoot, folder);
    if (!existsSync(dir)) {
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((name) => hasArtifactSuffix(name))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const data = readJsonObject(path);
      if (data === null) {
        continue;
      }
      const plan = planOf(data);
      if (plan === null) {
        continue;
      }
      out.push({
        folder,
        status: statusOf(plan, folder),
        eventTime: eventTimeFor(data, plan, path),
      });
    }
  }
  return out;
}

function utcIso(dt: Date): string {
  return `${dt.toISOString().slice(0, 19)}Z`;
}

/**
 * Collect lifecycle folder stats for a project root.
 * Offline / filesystem only.
 */
export function collectLifecycleStats(options: CollectLifecycleStatsOptions): LifecycleStats {
  const sinceRaw = (options.since ?? "7d").trim() || "7d";
  const sinceMs = parseDurationMs(sinceRaw);
  const asOf = options.now ?? new Date();
  const windowStart = new Date(asOf.getTime() - sinceMs);
  const projectRoot = resolve(options.projectRoot);
  const lifecycleRoot = resolveLayoutRootOrCanonical(projectRoot);

  const folder_totals = emptyFolderTotals();
  let promoted = 0;
  let activated = 0;
  let completed = 0;
  let cancelled_or_failed = 0;
  let still_active = 0;

  const records = existsSync(lifecycleRoot) ? scanArtifacts(lifecycleRoot) : [];
  for (const rec of records) {
    folder_totals[rec.folder] += 1;
    if (rec.folder === "active") {
      still_active += 1;
    }
    const win = inWindow(rec.eventTime, windowStart, asOf);
    if (!win) {
      continue;
    }
    if (rec.folder === "pending") {
      promoted += 1;
    } else if (rec.folder === "active") {
      activated += 1;
    } else if (rec.folder === "cancelled") {
      cancelled_or_failed += 1;
    } else if (rec.folder === "completed") {
      if (rec.status === "failed") {
        cancelled_or_failed += 1;
      } else {
        // completed, or any non-failed terminal status under completed/
        completed += 1;
      }
    }
  }

  return {
    since: sinceRaw,
    since_ms: sinceMs,
    as_of: utcIso(asOf),
    window_start: utcIso(windowStart),
    project_root: projectRoot,
    lifecycle_root: lifecycleRoot,
    promoted,
    activated,
    completed,
    cancelled_or_failed,
    still_active,
    folder_totals: { ...folder_totals },
    semantics: LIFECYCLE_STATS_SEMANTICS,
  };
}

/** Format human-readable lifecycle stats text. */
export function formatLifecycleStatsText(stats: LifecycleStats): string {
  const lines = [
    `lifecycle:stats (since ${stats.since}, as of ${stats.as_of})`,
    `  window: ${stats.window_start} → ${stats.as_of}`,
    `  promoted: ${stats.promoted}`,
    `  activated: ${stats.activated}`,
    `  completed: ${stats.completed}`,
    `  cancelled_or_failed: ${stats.cancelled_or_failed}`,
    `  still_active: ${stats.still_active}`,
    `  folder_totals: proposed=${stats.folder_totals.proposed} pending=${stats.folder_totals.pending} active=${stats.folder_totals.active} completed=${stats.folder_totals.completed} cancelled=${stats.folder_totals.cancelled}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Re-export duration parse for CLI error messaging. */
export { parseDurationMs };
