import { extractAuthor, extractLabels, extractMilestone } from "../scope-drift/cache-walker.js";
import { resolveScopeIgnores, type ScopeIgnores } from "../scope-drift/scope-rules.js";

export { resolveScopeIgnores, type ScopeIgnores };

export function hasActiveScopeIgnores(ignores: ScopeIgnores): boolean {
  return ignores.labels.size > 0 || ignores.milestones.size > 0 || ignores.authors.size > 0;
}

/** True when a cached raw.json payload matches any triageScopeIgnores entry. */
export function isRawIssueScopeIgnored(
  raw: Record<string, unknown>,
  ignores: ScopeIgnores,
): boolean {
  if (ignores.authors.size > 0 && ignores.authors.has(extractAuthor(raw))) {
    return true;
  }
  if (ignores.labels.size > 0) {
    for (const label of extractLabels(raw)) {
      if (ignores.labels.has(label)) {
        return true;
      }
    }
  }
  if (ignores.milestones.size > 0) {
    const milestone = extractMilestone(raw);
    if (milestone && ignores.milestones.has(milestone)) {
      return true;
    }
  }
  return false;
}

/** True when a queue CachedIssue matches any triageScopeIgnores entry. */
export function isCachedIssueScopeIgnored(
  issue: {
    readonly labels: readonly string[];
    readonly author?: string;
    readonly milestone?: string;
  },
  ignores: ScopeIgnores,
): boolean {
  if (
    ignores.authors.size > 0 &&
    issue.author !== undefined &&
    issue.author.length > 0 &&
    ignores.authors.has(issue.author)
  ) {
    return true;
  }
  if (ignores.labels.size > 0) {
    for (const label of issue.labels) {
      if (ignores.labels.has(label)) {
        return true;
      }
    }
  }
  if (
    ignores.milestones.size > 0 &&
    issue.milestone !== undefined &&
    issue.milestone.length > 0 &&
    ignores.milestones.has(issue.milestone)
  ) {
    return true;
  }
  return false;
}
