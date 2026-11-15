import { readFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveChangelogText } from "../changelog/effective-unreleased.js";
import { guardChangelogReadSafety } from "../release/changelog-read-safety.js";
import {
  COVERAGE_GOAL,
  countRecentCoverageDebtMentions,
  formatCoverageAttribution,
  formatOveruseWarning,
  metricsBelowGoal,
  readCoverageTotalsFromReport,
  resolveCoverageDebtIssue,
} from "./coverage-debt.js";

function resolveDebtIssueForTeardown(): { kind: "none" } | { kind: "valid"; issue: number } {
  const resolution = resolveCoverageDebtIssue(process.argv, process.env);
  if (resolution.kind === "valid") return resolution;
  if (resolution.kind === "invalid") {
    throw new Error(`coverage-debt: ${resolution.reason}`);
  }
  const laneRaw = process.env.DEFT_TS_LANE_COVERAGE_DEBT;
  if (laneRaw !== undefined && /^\d+$/.test(laneRaw.trim())) {
    const issue = Number.parseInt(laneRaw.trim(), 10);
    if (issue > 0) return { kind: "valid", issue };
  }
  return { kind: "none" };
}

/** Vitest globalTeardown: enforce coverage goal or debt soft-pass (#2573). */
export default async function coverageDebtTeardown(): Promise<void> {
  const resolution = resolveDebtIssueForTeardown();
  if (resolution.kind === "none") return;

  const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
  const totals = readCoverageTotalsFromReport(join(repoRoot, "coverage"));
  if (totals === null) {
    throw new Error("coverage-debt: could not read coverage/coverage-final.json");
  }

  const missed = metricsBelowGoal(totals);
  if (missed.length === 0) {
    process.stderr.write(
      `coverage-debt: note — --allow-coverage-debt=#${resolution.issue} set but all metrics meet the ${COVERAGE_GOAL.branches}% goal\n`,
    );
    return;
  }

  process.stderr.write(`${formatCoverageAttribution(resolution.issue, totals)}\n`);

  const changelogSafety = guardChangelogReadSafety(repoRoot);
  if (changelogSafety.ok) {
    try {
      // #6314: read through the effective view (changelog + changelog.d/ fragments).
      const changelog = effectiveChangelogText(
        repoRoot,
        readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8"),
      );
      const overuse = formatOveruseWarning(countRecentCoverageDebtMentions(changelog));
      if (overuse) process.stderr.write(`${overuse}\n`);
    } catch {
      // CHANGELOG unreadable — debt attribution still stands.
    }
  }
}
