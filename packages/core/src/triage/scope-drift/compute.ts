import { join, resolve } from "node:path";
import {
  extractAuthor,
  extractLabels,
  extractMilestone,
  isOpen,
  issueRepoKey,
  iterCacheIssues,
} from "./cache-walker.js";
import {
  inferRepoFromIssues,
  resolveScopeIgnores,
  resolveScopeRules,
  rulesRequestIsOpen,
  subscribedLabels,
  subscribedMilestones,
} from "./scope-rules.js";
import { CACHE_DIR_NAME, DRIFT_MIN_ISSUES, type DriftReport } from "./types.js";

export interface ComputeDriftOptions {
  readonly cacheRoot?: string;
  readonly threshold?: number;
  readonly openMilestonesFetcher?: () => Set<string> | Iterable<string>;
}

/** Read-only subscription drift computation — mirrors Python `compute_drift`. */
export function computeDrift(projectRoot: string, options: ComputeDriftOptions = {}): DriftReport {
  const root = resolve(projectRoot);
  const resolvedCacheRoot = options.cacheRoot ?? join(root, CACHE_DIR_NAME);
  const effectiveThreshold =
    options.threshold !== undefined && options.threshold > 0 ? options.threshold : DRIFT_MIN_ISSUES;

  const issues = iterCacheIssues(resolvedCacheRoot);
  const rules = resolveScopeRules(root);
  const ignores = resolveScopeIgnores(root);

  let openMsSnapshot = new Set<string>();
  if (rulesRequestIsOpen(rules)) {
    if (options.openMilestonesFetcher) {
      try {
        const raw = options.openMilestonesFetcher();
        openMsSnapshot = raw instanceof Set ? new Set(raw) : new Set(raw);
      } catch {
        openMsSnapshot = new Set();
      }
    } else {
      openMsSnapshot = new Set();
    }
  }

  if (rules.some((r) => r.rule === "all-open")) {
    return { labels: {}, milestones: {}, total: 0, threshold: effectiveThreshold };
  }

  const subLabels = subscribedLabels(rules);
  const subMilestones = subscribedMilestones(rules, openMsSnapshot);
  const labelCounts: Record<string, number> = {};
  const milestoneCounts: Record<string, number> = {};
  const ignoredAuthors = ignores.authors;

  for (const issue of issues) {
    if (!isOpen(issue)) continue;
    const number = issue.number;
    if (typeof number !== "number" || !Number.isInteger(number)) continue;
    if (ignoredAuthors.size > 0 && ignoredAuthors.has(extractAuthor(issue))) continue;

    const labels = extractLabels(issue);
    for (const label of labels) {
      if (subLabels.has(label) || ignores.labels.has(label)) continue;
      labelCounts[label] = (labelCounts[label] ?? 0) + 1;
    }
    const milestone = extractMilestone(issue);
    if (milestone && !subMilestones.has(milestone) && !ignores.milestones.has(milestone)) {
      milestoneCounts[milestone] = (milestoneCounts[milestone] ?? 0) + 1;
    }
  }

  const surfacedLabels: Record<string, number> = {};
  for (const [label, count] of Object.entries(labelCounts)) {
    if (count >= effectiveThreshold) surfacedLabels[label] = count;
  }
  const surfacedMilestones: Record<string, number> = {};
  for (const [name, count] of Object.entries(milestoneCounts)) {
    if (count >= effectiveThreshold) surfacedMilestones[name] = count;
  }

  const sortedLabels = Object.fromEntries(
    Object.entries(surfacedLabels).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sortedMilestones = Object.fromEntries(
    Object.entries(surfacedMilestones).sort(([a], [b]) => a.localeCompare(b)),
  );

  const surfacedIssues = new Set<string>();
  for (const issue of issues) {
    if (!isOpen(issue)) continue;
    const number = issue.number;
    if (typeof number !== "number" || !Number.isInteger(number)) continue;
    if (ignoredAuthors.size > 0 && ignoredAuthors.has(extractAuthor(issue))) continue;
    const labels = extractLabels(issue);
    const milestone = extractMilestone(issue);
    const hasLabelDrift = [...labels].some((l) => l in sortedLabels);
    const hasMilestoneDrift = milestone.length > 0 && milestone in sortedMilestones;
    if (hasLabelDrift || hasMilestoneDrift) {
      surfacedIssues.add(`${issueRepoKey(issue)}:${number}`);
    }
  }

  void inferRepoFromIssues(issues);

  return {
    labels: sortedLabels,
    milestones: sortedMilestones,
    total: surfacedIssues.size,
    threshold: effectiveThreshold,
  };
}
