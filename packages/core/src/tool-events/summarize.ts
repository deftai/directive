/**
 * Aggregate tool-event classifications into counts, anomalies, and status lines (#2967).
 * Pure: no I/O.
 */

import { classifyToolEvent } from "./classify.js";
import {
  TOOL_EVENT_BUCKETS,
  type ToolEventAnomaly,
  type ToolEventBucket,
  type ToolEventBucketCounts,
  type ToolEventInput,
  type ToolEventSummary,
} from "./types.js";

export function emptyBucketCounts(): ToolEventBucketCounts {
  return {
    explore: 0,
    commit: 0,
    verify: 0,
    coordinate: 0,
    unknown: 0,
  };
}

/** Count classified buckets for a sequence of tool events. */
export function countToolEventBuckets(events: readonly ToolEventInput[]): ToolEventBucketCounts {
  const counts: Record<ToolEventBucket, number> = {
    explore: 0,
    commit: 0,
    verify: 0,
    coordinate: 0,
    unknown: 0,
  };
  for (const event of events) {
    const { bucket } = classifyToolEvent(event);
    counts[bucket] += 1;
  }
  return counts;
}

/**
 * Detect operator-facing anomalies from bucket counts.
 *
 * Rules (conservative — only fire when the mix is clearly wrong):
 * - commit-without-explore: commit > 0 and explore === 0
 * - verify-skipped: commit > 0 and verify === 0 (ship without gates)
 * - explore-only: explore > 0, commit === 0, verify === 0, and total >= 3
 *   (thrash / stuck-reading signal; small explore-only sessions stay quiet)
 */
export function detectToolEventAnomalies(counts: ToolEventBucketCounts): ToolEventAnomaly[] {
  const anomalies: ToolEventAnomaly[] = [];
  const total = counts.explore + counts.commit + counts.verify + counts.coordinate + counts.unknown;

  if (counts.commit > 0 && counts.explore === 0) {
    anomalies.push({
      code: "commit-without-explore",
      message: `commit-without-explore: ${counts.commit} commit event(s) with 0 explore`,
    });
  }
  if (counts.commit > 0 && counts.verify === 0) {
    anomalies.push({
      code: "verify-skipped",
      message: `verify-skipped: ${counts.commit} commit event(s) with 0 verify`,
    });
  }
  if (counts.explore > 0 && counts.commit === 0 && counts.verify === 0 && total >= 3) {
    anomalies.push({
      code: "explore-only",
      message: `explore-only: ${counts.explore} explore event(s) with 0 commit and 0 verify (possible thrash)`,
    });
  }

  return anomalies;
}

/**
 * Compact status line for swarm monitor / review-cycle batch brief.
 * Example: `tools: explore=3 commit=2 verify=1 coordinate=0 unknown=0`
 */
export function formatToolEventStatusLine(counts: ToolEventBucketCounts): string {
  const parts = TOOL_EVENT_BUCKETS.map((b) => `${b}=${counts[b]}`);
  return `tools: ${parts.join(" ")}`;
}

/**
 * One-line anomaly suffix for status surfaces.
 * Empty string when no anomalies.
 */
export function formatToolEventAnomalyLine(anomalies: readonly ToolEventAnomaly[]): string {
  if (anomalies.length === 0) return "";
  return `anomalies: ${anomalies.map((a) => a.code).join(",")}`;
}

/**
 * Full summary for a tool-event sequence — counts, anomalies, status line.
 * When anomalies exist, statusLine appends `| anomalies: …`.
 */
export function summarizeToolEvents(events: readonly ToolEventInput[]): ToolEventSummary {
  const counts = countToolEventBuckets(events);
  const anomalies = detectToolEventAnomalies(counts);
  const total = counts.explore + counts.commit + counts.verify + counts.coordinate + counts.unknown;
  const base = formatToolEventStatusLine(counts);
  const anomalyLine = formatToolEventAnomalyLine(anomalies);
  const statusLine = anomalyLine.length > 0 ? `${base} | ${anomalyLine}` : base;
  return { total, counts, anomalies, statusLine };
}
