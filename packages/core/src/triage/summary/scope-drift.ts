import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectDefinition } from "../../policy/resolve.js";

const DRIFT_MIN_ISSUES = 3;
const CACHE_SOURCE = "github-issue";

interface CacheIssue {
  readonly repo: string;
  readonly number: number;
  readonly state: string;
  readonly labels: readonly string[];
  readonly milestone: string | null;
}

function isPosIntDirName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  for (const ch of name) {
    if (ch < "0" || ch > "9") {
      return false;
    }
  }
  return true;
}

function iterCacheIssues(cacheRoot: string): CacheIssue[] {
  const base = join(cacheRoot, CACHE_SOURCE);
  if (!existsSync(base)) {
    return [];
  }
  const out: CacheIssue[] = [];
  for (const ownerEntry of readdirSync(base, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!ownerEntry.isDirectory()) {
      continue;
    }
    const ownerDir = join(base, ownerEntry.name);
    for (const repoEntry of readdirSync(ownerDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!repoEntry.isDirectory()) {
        continue;
      }
      const repo = `${ownerEntry.name}/${repoEntry.name}`;
      const repoDir = join(ownerDir, repoEntry.name);
      const issueDirs = readdirSync(repoDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && isPosIntDirName(e.name))
        .sort((a, b) => Number.parseInt(a.name, 10) - Number.parseInt(b.name, 10));
      for (const issueEntry of issueDirs) {
        const number = Number.parseInt(issueEntry.name, 10);
        const rawPath = join(repoDir, issueEntry.name, "raw.json");
        if (!existsSync(rawPath)) {
          continue;
        }
        try {
          const raw = JSON.parse(readFileSync(rawPath, { encoding: "utf8" })) as unknown;
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            continue;
          }
          const obj = raw as Record<string, unknown>;
          const state = typeof obj.state === "string" ? obj.state : "open";
          const labels: string[] = [];
          if (Array.isArray(obj.labels)) {
            for (const label of obj.labels) {
              if (typeof label === "string") {
                labels.push(label);
              } else if (
                typeof label === "object" &&
                label !== null &&
                !Array.isArray(label) &&
                typeof (label as Record<string, unknown>).name === "string"
              ) {
                labels.push((label as Record<string, unknown>).name as string);
              }
            }
          }
          let milestone: string | null = null;
          const ms = obj.milestone;
          if (typeof ms === "object" && ms !== null && !Array.isArray(ms)) {
            const title = (ms as Record<string, unknown>).title;
            if (typeof title === "string") {
              milestone = title;
            }
          }
          out.push({ repo, number, state, labels, milestone });
        } catch {
          // skip unreadable raw.json
        }
      }
    }
  }
  return out;
}

function resolveScopeRules(projectRoot: string): Record<string, unknown>[] {
  const [data] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return [{ rule: "all-open" }];
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [{ rule: "all-open" }];
  }
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [{ rule: "all-open" }];
  }
  const scope = (policy as Record<string, unknown>).triageScope;
  if (!Array.isArray(scope) || scope.length === 0) {
    return [{ rule: "all-open" }];
  }
  const rules: Record<string, unknown>[] = [];
  for (const rule of scope) {
    if (typeof rule === "object" && rule !== null && !Array.isArray(rule)) {
      rules.push(rule as Record<string, unknown>);
    }
  }
  return rules.length > 0 ? rules : [{ rule: "all-open" }];
}

function subscribedLabels(rules: readonly Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (rule.rule !== "labels") {
      continue;
    }
    const anyOf = rule["any-of"];
    if (Array.isArray(anyOf)) {
      for (const label of anyOf) {
        if (typeof label === "string") {
          out.add(label);
        }
      }
    }
  }
  return out;
}

function subscribedMilestones(rules: readonly Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (rule.rule !== "milestone") {
      continue;
    }
    const name = rule.name;
    if (typeof name === "string") {
      out.add(name);
    }
  }
  return out;
}

/**
 * Compute scope-drift total (#1133) — mirrors `triage_scope_drift.compute_drift().total`.
 */
export function computeScopeDriftTotal(projectRoot: string, cacheRoot: string): number {
  try {
    const issues = iterCacheIssues(cacheRoot);
    const rules = resolveScopeRules(projectRoot);
    if (rules.some((r) => r.rule === "all-open")) {
      return 0;
    }
    const subscribedLabelsSet = subscribedLabels(rules);
    const subscribedMilestonesSet = subscribedMilestones(rules);
    const labelCounts = new Map<string, number>();
    const milestoneCounts = new Map<string, number>();
    const surfacedIssues = new Set<string>();

    for (const issue of issues) {
      if (issue.state !== "open") {
        continue;
      }
      const issueKey = `${issue.repo}\0${issue.number}`;
      for (const label of issue.labels) {
        if (subscribedLabelsSet.has(label)) {
          continue;
        }
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
      if (issue.milestone !== null && !subscribedMilestonesSet.has(issue.milestone)) {
        milestoneCounts.set(issue.milestone, (milestoneCounts.get(issue.milestone) ?? 0) + 1);
      }
      for (const [label, count] of labelCounts) {
        if (count >= DRIFT_MIN_ISSUES && issue.labels.includes(label)) {
          surfacedIssues.add(issueKey);
        }
      }
      if (issue.milestone !== null) {
        const msCount = milestoneCounts.get(issue.milestone) ?? 0;
        if (msCount >= DRIFT_MIN_ISSUES && !subscribedMilestonesSet.has(issue.milestone)) {
          surfacedIssues.add(issueKey);
        }
      }
    }

    const surfacedLabels = new Set<string>();
    const surfacedMilestones = new Set<string>();
    for (const [label, count] of labelCounts) {
      if (count >= DRIFT_MIN_ISSUES) {
        surfacedLabels.add(label);
      }
    }
    for (const [ms, count] of milestoneCounts) {
      if (count >= DRIFT_MIN_ISSUES) {
        surfacedMilestones.add(ms);
      }
    }

    const distinct = new Set<string>();
    for (const issue of issues) {
      if (issue.state !== "open") {
        continue;
      }
      const issueKey = `${issue.repo}\0${issue.number}`;
      let surfaced = false;
      for (const label of issue.labels) {
        if (surfacedLabels.has(label) && !subscribedLabelsSet.has(label)) {
          surfaced = true;
          break;
        }
      }
      if (
        !surfaced &&
        issue.milestone !== null &&
        surfacedMilestones.has(issue.milestone) &&
        !subscribedMilestonesSet.has(issue.milestone)
      ) {
        surfaced = true;
      }
      if (surfaced) {
        distinct.add(issueKey);
      }
    }
    return distinct.size;
  } catch {
    return 0;
  }
}
