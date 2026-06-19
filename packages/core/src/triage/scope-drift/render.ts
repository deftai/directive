import { type DriftReport, isEmptyReport } from "./types.js";

/** Human-readable drift report — mirrors Python `render_drift_report`. */
export function renderDriftReport(report: DriftReport): string {
  if (isEmptyReport(report)) {
    return (
      "[scope-drift] no unsubscribed labels / milestones found " +
      `(threshold: >= ${report.threshold} cached open issues).`
    );
  }

  const lines: string[] = [];
  const labelNames = Object.keys(report.labels);
  if (labelNames.length > 0) {
    lines.push("[scope-drift] labels not in subscription:");
    const width = Math.max(...labelNames.map((n) => n.length));
    for (const [name, count] of Object.entries(report.labels)) {
      lines.push(`  ${name.padEnd(width)}  (${count} open issues)`);
    }
  }
  const milestoneNames = Object.keys(report.milestones);
  if (milestoneNames.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("[scope-drift] milestones not in subscription:");
    const width = Math.max(...milestoneNames.map((n) => n.length));
    for (const [name, count] of Object.entries(report.milestones)) {
      lines.push(`  ${name.padEnd(width)}  (${count} open issues)`);
    }
  }

  lines.push("");
  lines.push("To subscribe:");
  for (const name of labelNames) {
    lines.push(`  task triage:subscribe -- --label=${name}`);
  }
  for (const name of milestoneNames) {
    lines.push(`  task triage:subscribe -- --milestone=${name}`);
  }

  lines.push("");
  lines.push("To suppress (record explicit ignore):");
  for (const name of labelNames) {
    lines.push(`  task triage:scope-drift -- --ignore-label=${name}`);
  }
  for (const name of milestoneNames) {
    lines.push(`  task triage:scope-drift -- --ignore-milestone=${name}`);
  }

  return lines.join("\n");
}
