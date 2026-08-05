/**
 * Freshness report assembly + human formatting (#3117).
 */

import { readRitualState } from "../session/ritual-sentinel.js";
import { readBoundGeneration } from "./bind.js";
import { compareFreshness } from "./compare.js";
import { readLiveGeneration } from "./generation.js";
import type { FreshnessReport } from "./types.js";

export interface ReportFreshnessOptions {
  /**
   * Host session identity. When set, only that session's bind is read
   * (multi-agent isolation).
   *
   * When omitted, recover the current ritual `session_id` from
   * `.deft/ritual-state.json` (written by `session:start`) so bare
   * `freshness:report` matches the bind just created. Pass `null` to force
   * the default project bind path only.
   */
  readonly sessionId?: string | null;
}

/**
 * Resolve which bind identity a report should use.
 * Explicit sessionId wins; else ritual session_id; else default bind (null).
 */
export function resolveReportSessionId(
  projectRoot: string,
  explicit?: string | null,
): string | null {
  if (explicit === null) {
    return null;
  }
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  try {
    const [state] = readRitualState(projectRoot);
    const id = state?.sessionId?.trim();
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Build a freshness report for the project (bound vs live on disk). */
export function reportFreshness(
  projectRoot: string,
  options: ReportFreshnessOptions = {},
): FreshnessReport {
  const sessionId = resolveReportSessionId(projectRoot, options.sessionId);
  const bound = readBoundGeneration(projectRoot, { sessionId });
  const live = readLiveGeneration(projectRoot);
  return compareFreshness(bound, live);
}

/** Human-readable multi-line freshness report. */
export function formatFreshnessReport(report: FreshnessReport): string {
  const lines: string[] = [
    "[deft freshness] bound vs live generation",
    `  state              : ${report.state}`,
    `  ready              : ${report.ready ? "yes" : "no"}`,
    `  bound generation   : ${report.boundGeneration ?? "(none)"}`,
    `  live generation    : ${report.liveGeneration ?? "(none)"}`,
    `  bound content      : ${report.boundContentVersion ?? "(none)"}`,
    `  live content       : ${report.liveContentVersion ?? "(none)"}`,
  ];
  if (report.differingSurfaces.length > 0) {
    lines.push(`  differing surfaces: ${report.differingSurfaces.join(", ")}`);
    if (report.hardDiffs.length > 0) {
      lines.push(`  hard diffs         : ${report.hardDiffs.join(", ")}`);
    }
    if (report.softDiffs.length > 0) {
      lines.push(`  soft diffs         : ${report.softDiffs.join(", ")}`);
    }
  } else if (report.state !== "unbound") {
    lines.push("  differing surfaces: (none)");
  }
  lines.push(`  rebind             : ${report.rebindGuidance}`);
  if (report.state === "stale_hard" || report.state === "unbound") {
    lines.push(`  mid-mission        : ${report.midMissionSafety}`);
  }
  return `${lines.join("\n")}\n`;
}

/** JSON-serializable shape for --json output. */
export function freshnessReportToJson(report: FreshnessReport): Record<string, unknown> {
  return {
    state: report.state,
    ready: report.ready,
    bound_generation: report.boundGeneration,
    live_generation: report.liveGeneration,
    bound_content_version: report.boundContentVersion,
    live_content_version: report.liveContentVersion,
    differing_surfaces: report.differingSurfaces,
    hard_diffs: report.hardDiffs,
    soft_diffs: report.softDiffs,
    rebind_guidance: report.rebindGuidance,
    mid_mission_safety: report.midMissionSafety,
    live: report.live,
    bound: report.bound,
  };
}

/**
 * Exit code for freshness:report.
 * 0 = current (ready); 1 = stale_soft or unbound (caution); 2 = stale_hard (must rebind).
 */
export function freshnessReportExitCode(report: FreshnessReport): 0 | 1 | 2 {
  if (report.state === "current") return 0;
  if (report.state === "stale_hard") return 2;
  return 1;
}
